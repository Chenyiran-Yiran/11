/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as mime from 'mime';
import { TargetSession, TargetSessionEvents } from './Connection';
import { Events } from '../Events';
import { Frame, FrameManager, FrameManagerEvents } from './FrameManager';
import { assert, helper, RegisteredListener } from '../helper';
import { valueFromRemoteObject } from './protocolHelper';
import { Keyboard, Mouse } from './Input';
import { createJSHandle, ElementHandle, JSHandle, ClickOptions } from './JSHandle';
import { Response, NetworkManagerEvents } from './NetworkManager';
import { TaskQueue } from './TaskQueue';
import { TimeoutSettings } from '../TimeoutSettings';
import { Target } from './Target';
import { Browser, BrowserContext } from './Browser';
import { Protocol } from './protocol';

const writeFileAsync = helper.promisify(fs.writeFile);

export type Viewport = {
  width: number;
  height: number;
}

export class Page extends EventEmitter {
  private _closed = false;
  private _session: TargetSession;
  private _target: Target;
  private _keyboard: Keyboard;
  private _mouse: Mouse;
  private _timeoutSettings: TimeoutSettings;
  private _frameManager: FrameManager;
  _javascriptEnabled = true;
  private _viewport: Viewport | null = null;
  private _screenshotTaskQueue: TaskQueue;
  private _workers = new Map<string, Worker>();
  private _disconnectPromise: Promise<Error> | undefined;
  private _sessionListeners: RegisteredListener[] = [];

  static async create(session: TargetSession, target: Target, defaultViewport: Viewport | null, screenshotTaskQueue: TaskQueue): Promise<Page> {
    const page = new Page(session, target, screenshotTaskQueue);
    await page._initialize();
    if (defaultViewport)
      await page.setViewport(defaultViewport);
    return page;
  }

  constructor(session: TargetSession, target: Target, screenshotTaskQueue: TaskQueue) {
    super();
    this._keyboard = new Keyboard(session);
    this._mouse = new Mouse(session, this._keyboard);
    this._timeoutSettings = new TimeoutSettings();
    this._frameManager = new FrameManager(session, this, this._timeoutSettings);

    this._screenshotTaskQueue = screenshotTaskQueue;
    
    this._setSession(session);
    this._setTarget(target);

    this._frameManager.on(FrameManagerEvents.FrameAttached, event => this.emit(Events.Page.FrameAttached, event));
    this._frameManager.on(FrameManagerEvents.FrameDetached, event => this.emit(Events.Page.FrameDetached, event));
    this._frameManager.on(FrameManagerEvents.FrameNavigated, event => this.emit(Events.Page.FrameNavigated, event));

    const networkManager = this._frameManager.networkManager();
    networkManager.on(NetworkManagerEvents.Request, event => this.emit(Events.Page.Request, event));
    networkManager.on(NetworkManagerEvents.Response, event => this.emit(Events.Page.Response, event));
    networkManager.on(NetworkManagerEvents.RequestFailed, event => this.emit(Events.Page.RequestFailed, event));
    networkManager.on(NetworkManagerEvents.RequestFinished, event => this.emit(Events.Page.RequestFinished, event));
  }

  async _initialize() {
    return Promise.all([
      this._frameManager.initialize(),
      this._session.send('Console.enable'),
    ]);
  }

  _setSession(newSession: TargetSession) {
    helper.removeEventListeners(this._sessionListeners);
    this._session = newSession;
    this._sessionListeners = [
      helper.addEventListener(this._session, TargetSessionEvents.Disconnected, () => this._frameManager.disconnectFromTarget()),
      helper.addEventListener(this._session, 'Page.loadEventFired', event => this.emit(Events.Page.Load)),
      helper.addEventListener(this._session, 'Console.messageAdded', event => this._onConsoleMessage(event)),
      helper.addEventListener(this._session, 'Page.domContentEventFired', event => this.emit(Events.Page.DOMContentLoaded)),
    ];
  }

  _setTarget(newTarget: Target) {
    this._target = newTarget;
    this._target._isClosedPromise.then(() => {
      if (this._target !== newTarget)
        return;
      this.emit(Events.Page.Close);
      this._closed = true;
    });
  }

  async _swapTargetOnNavigation(newSession : TargetSession, newTarget : Target)
  {
    this._setSession(newSession); 
    this._setTarget(newTarget);

    await this._frameManager._swapTargetOnNavigation(newSession);

    await this._initialize().catch(e => console.log('failed to enable agents after swap: ' + e));
  }

  target(): Target {
    return this._target;
  }

  browser(): Browser {
    return this._target.browser();
  }

  browserContext(): BrowserContext {
    return this._target.browserContext();
  }

  _onTargetCrashed() {
    this.emit('error', new Error('Page crashed!'));
  }

  async _onConsoleMessage(event : Protocol.Console.messageAddedPayload) {
    const {type, level, text, parameters, url, line:lineNumber, column:columnNumber} = event.message;
    let derivedType: string = type;
    if (type === 'log')
      derivedType = level;
    else if (type === 'timing')
      derivedType = 'timeEnd';
    const mainFrameContext = await this.mainFrame().executionContext();
    const handles = (parameters || []).map(p => {
      let context = null;;
      if (p.objectId) {
        const objectId = JSON.parse(p.objectId);
        context = this._frameManager._contextIdToContext.get(objectId.injectedScriptId);
      } else {
        context = mainFrameContext;
      }
      return createJSHandle(context, p);
    });
    const textTokens = [];
    for (const handle of handles) {
      const remoteObject = handle._remoteObject;
      if (remoteObject.objectId)
        textTokens.push(handle.toString());
      else
        textTokens.push(valueFromRemoteObject(remoteObject));
    }
    const location = {url, lineNumber, columnNumber};
    const formattedText = textTokens.length ? textTokens.join(' ') : text;
    this.emit(Events.Page.Console, new ConsoleMessage(derivedType, formattedText, handles, location));
  }
  
  mainFrame(): Frame {
    return this._frameManager.mainFrame();
  }

  get keyboard(): Keyboard {
    return this._keyboard;
  }

  frames(): Frame[] {
    return this._frameManager.frames();
  }

  workers(): Worker[] {
    return Array.from(this._workers.values());
  }


  setDefaultNavigationTimeout(timeout: number) {
    this._timeoutSettings.setDefaultNavigationTimeout(timeout);
  }

  setDefaultTimeout(timeout: number) {
    this._timeoutSettings.setDefaultTimeout(timeout);
  }

  async $(selector: string): Promise<ElementHandle | null> {
    return this.mainFrame().$(selector);
  }

  async evaluateHandle(pageFunction: Function | string, ...args: any[]): Promise<JSHandle> {
    const context = await this.mainFrame().executionContext();
    return context.evaluateHandle(pageFunction, ...args);
  }

  async $eval(selector: string, pageFunction: Function | string, ...args: any[]): Promise<(object | undefined)> {
    return this.mainFrame().$eval(selector, pageFunction, ...args);
  }

  async $$eval(selector: string, pageFunction: Function | string, ...args: any[]): Promise<(object | undefined)> {
    return this.mainFrame().$$eval(selector, pageFunction, ...args);
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    return this.mainFrame().$$(selector);
  }

  async $x(expression: string): Promise<ElementHandle[]> {
    return this.mainFrame().$x(expression);
  }

  async cookies(...urls: string[]): Promise<NetworkCookie[]> {
    const response = await this._session.send('Page.getCookies');
    return response.cookies.map(cookie => {
      // Webkit returns 0 for a cookie without an expiration
      if (cookie.expires === 0)
        cookie.expires = -1;
      return cookie;
    });
  }

  async deleteCookie(...cookies: DeleteNetworkCookieParam[]) {
    const pageURL = this.url();
    for (const cookie of cookies) {
      const item = {
        cookieName: cookie.name,
        url: cookie.url
      };
      if (!cookie.url && pageURL.startsWith('http'))
        item.url = pageURL;
      await this._session.send('Page.deleteCookie', item).catch(e => console.log("deleting " + JSON.stringify(item) + " => " +e));
    }
  }

  async addScriptTag(options: { url?: string; path?: string; content?: string; type?: string; }): Promise<ElementHandle> {
    return this.mainFrame().addScriptTag(options);
  }

  async addStyleTag(options: { url?: string; path?: string; content?: string; }): Promise<ElementHandle> {
    return this.mainFrame().addStyleTag(options);
  }

  async setExtraHTTPHeaders(headers: { [s: string]: string; }) {
    return this._frameManager.networkManager().setExtraHTTPHeaders(headers);
  }

  async setUserAgent(userAgent: string) {
    await this._session.send('Page.overrideUserAgent', { value: userAgent });
  }

  url(): string {
    return this.mainFrame().url();
  }

  async content(): Promise<string> {
    return await this._frameManager.mainFrame().content();
  }

  async setContent(html: string, options: { timeout?: number; waitUntil?: string | string[]; } | undefined) {
    await this._frameManager.mainFrame().setContent(html, options);
  }

  async goto(url: string, options: { referer?: string; timeout?: number; waitUntil?: string | string[]; } | undefined): Promise<Response | null> {
    return await this._frameManager.mainFrame().goto(url, options);
  }

  async reload(): Promise<Response | null> {
    const [response] = await Promise.all([
      this.waitForNavigation(),
      this._session.send('Page.reload')
    ]);
    return response;
  }

  async waitForNavigation(): Promise<Response | null> {
    return await this._frameManager.mainFrame().waitForNavigation();
  }

  _sessionClosePromise() {
    if (!this._disconnectPromise)
      this._disconnectPromise = new Promise(fulfill => this._session.once(TargetSessionEvents.Disconnected, () => fulfill(new Error('Target closed'))));
    return this._disconnectPromise;
  }

  async waitForRequest(urlOrPredicate: (string | Function), options: { timeout?: number; } = {}): Promise<Request> {
    const {
      timeout = this._timeoutSettings.timeout(),
    } = options;
    return helper.waitForEvent(this._frameManager.networkManager(), NetworkManagerEvents.Request, request => {
      if (helper.isString(urlOrPredicate))
        return (urlOrPredicate === request.url());
      if (typeof urlOrPredicate === 'function')
        return !!(urlOrPredicate(request));
      return false;
    }, timeout, this._sessionClosePromise());
  }

  async waitForResponse(urlOrPredicate: (string | Function), options: { timeout?: number; } = {}): Promise<Response> {
    const {
      timeout = this._timeoutSettings.timeout(),
    } = options;
    return helper.waitForEvent(this._frameManager.networkManager(), NetworkManagerEvents.Response, response => {
      if (helper.isString(urlOrPredicate))
        return (urlOrPredicate === response.url());
      if (typeof urlOrPredicate === 'function')
        return !!(urlOrPredicate(response));
      return false;
    }, timeout, this._sessionClosePromise());
  }

  async emulate(options: { viewport: Viewport; userAgent: string; }) {
    await Promise.all([
      this.setViewport(options.viewport),
      this.setUserAgent(options.userAgent)
    ]);
  }

  async emulateMedia(type: string | null) {
    return this.emulateMediaType(type);
  }

  async emulateMediaType(type: string | null) {
    assert(type === 'screen' || type === 'print' || type === null, 'Unsupported media type: ' + type);
    await this._session.send('Page.setEmulatedMedia', {media: type || ''});
  }

  async setViewport(viewport: Viewport) {
    this._viewport = viewport;
    const width = viewport.width;
    const height = viewport.height;
    await this._session.send('Emulation.setDeviceMetricsOverride', { width, height });
  }

  viewport(): Viewport | null {
    return this._viewport;
  }

  async evaluate(pageFunction: Function | string, ...args: any[]): Promise<any> {
    return this._frameManager.mainFrame().evaluate(pageFunction, ...args);
  }

  async setCacheEnabled(enabled: boolean = true) {
    await this._frameManager.networkManager().setCacheEnabled(enabled);
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer | string> {
    let screenshotType = null;
    // options.type takes precedence over inferring the type from options.path
    // because it may be a 0-length file with no extension created beforehand (i.e. as a temp file).
    if (options.type) {
      assert(options.type === 'png', 'Unknown options.type value: ' + options.type);
      screenshotType = options.type;
    } else if (options.path) {
      const mimeType = mime.getType(options.path);
      if (mimeType === 'image/png')
        screenshotType = 'png';
      assert(screenshotType, 'Unsupported screenshot mime type: ' + mimeType);
    }

    if (!screenshotType)
      screenshotType = 'png';

    if (options.quality)
      assert(screenshotType === 'jpeg', 'options.quality is unsupported for the ' + screenshotType + ' screenshots');
    assert(!options.clip || !options.fullPage, 'options.clip and options.fullPage are exclusive');
    if (options.clip) {
      assert(typeof options.clip.x === 'number', 'Expected options.clip.x to be a number but found ' + (typeof options.clip.x));
      assert(typeof options.clip.y === 'number', 'Expected options.clip.y to be a number but found ' + (typeof options.clip.y));
      assert(typeof options.clip.width === 'number', 'Expected options.clip.width to be a number but found ' + (typeof options.clip.width));
      assert(typeof options.clip.height === 'number', 'Expected options.clip.height to be a number but found ' + (typeof options.clip.height));
      assert(options.clip.width !== 0, 'Expected options.clip.width not to be 0.');
      assert(options.clip.height !== 0, 'Expected options.clip.height not to be 0.');
    }
    return this._screenshotTaskQueue.postTask(this._screenshotTask.bind(this, options));
  }

  async _screenshotTask(options?: ScreenshotOptions): Promise<Buffer | string> {
    const params: Protocol.Page.snapshotRectParameters = { x: 0, y: 0, width: 800, height: 600, coordinateSystem: 'Page' };
    if (options.fullPage) {
      const pageSize = await this.evaluate(() => {
        return {
          width: document.body.scrollWidth,
          height: document.body.scrollHeight
        };
      });
      Object.assign(params, pageSize);
    } else if (options.clip)
      Object.assign(params, options.clip);
    else if (this._viewport)
      Object.assign(params, this._viewport);
    const [, result] = await Promise.all([
      this._session._connection.send('Target.activate', { targetId: this._target._targetId }),
      this._session.send('Page.snapshotRect', params),
    ]).catch(e => {
      console.log('Failed to take screenshot: ' + e);
      throw e;
    });
    const prefix = 'data:image/png;base64,';
    const buffer = Buffer.from(result.dataURL.substr(prefix.length), 'base64');
    if (options.path)
      await writeFileAsync(options.path, buffer);
    return buffer;
  }

  async title(): Promise<string> {
    return this.mainFrame().title();
  }

  async close() {
    this.browser()._connection.send('Target.close', {
      targetId: this._target._targetId
    }).catch(e => {
      console.log(e);
    });
    await this._target._isClosedPromise;
  }

  isClosed(): boolean {
    return this._closed;
  }

  get mouse(): Mouse {
    return this._mouse;
  }

  click(selector: string, options?: ClickOptions) {
    return this.mainFrame().click(selector, options);
  }

  hover(selector: string) {
    return this.mainFrame().hover(selector);
  }

  focus(selector: string) {
    return this.mainFrame().focus(selector);
  }

  select(selector: string, ...values: string[]): Promise<string[]> {
    return this.mainFrame().select(selector, ...values);
  }

  type(selector: string, text: string, options: { delay: (number | undefined); } | undefined) {
    return this.mainFrame().type(selector, text, options);
  }

  waitFor(selectorOrFunctionOrTimeout: (string | number | Function), options: { visible?: boolean; hidden?: boolean; timeout?: number; polling?: string | number; } = {}, ...args: any[]): Promise<JSHandle> {
    return this.mainFrame().waitFor(selectorOrFunctionOrTimeout, options, ...args);
  }

  waitForSelector(selector: string, options: { visible?: boolean; hidden?: boolean; timeout?: number; } = {}): Promise<ElementHandle | null> {
    return this.mainFrame().waitForSelector(selector, options);
  }

  waitForXPath(xpath: string, options: { visible?: boolean; hidden?: boolean; timeout?: number; } = {}): Promise<ElementHandle | null> {
    return this.mainFrame().waitForXPath(xpath, options);
  }

  waitForFunction(pageFunction: Function, options: {
      polling?: string | number;
      timeout?: number; } = {},
  ...args: any[]): Promise<JSHandle> {
    return this.mainFrame().waitForFunction(pageFunction, options, ...args);
  }
}

type PDFOptions = {
  scale?: number,
  displayHeaderFooter?: boolean,
  headerTemplate?: string,
  footerTemplate?: string,
  printBackground?: boolean,
  landscape?: boolean,
  pageRanges?: string,
  format?: string,
  width?: string|number,
  height?: string|number,
  preferCSSPageSize?: boolean,
  margin?: {top?: string|number, bottom?: string|number, left?: string|number, right?: string|number},
  path?: string,
}

type Metrics = {
  Timestamp?: number,
  Documents?: number,
  Frames?: number,
  JSEventListeners?: number,
  Nodes?: number,
  LayoutCount?: number,
  RecalcStyleCount?: number,
  LayoutDuration?: number,
  RecalcStyleDuration?: number,
  ScriptDuration?: number,
  TaskDuration?: number,
  JSHeapUsedSize?: number,
  JSHeapTotalSize?: number,
}

type ScreenshotOptions = {
  type?: string,
  path?: string,
  fullPage?: boolean,
  clip?: {x: number, y: number, width: number, height: number},
  quality?: number,
  omitBackground?: boolean,
  encoding?: string,
}

type MediaFeature = {
  name: string,
  value: string
}

const supportedMetrics: Set<string> = new Set([
  'Timestamp',
  'Documents',
  'Frames',
  'JSEventListeners',
  'Nodes',
  'LayoutCount',
  'RecalcStyleCount',
  'LayoutDuration',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration',
  'JSHeapUsedSize',
  'JSHeapTotalSize',
]);

const PagePaperFormats = {
  letter: {width: 8.5, height: 11},
  legal: {width: 8.5, height: 14},
  tabloid: {width: 11, height: 17},
  ledger: {width: 17, height: 11},
  a0: {width: 33.1, height: 46.8 },
  a1: {width: 23.4, height: 33.1 },
  a2: {width: 16.54, height: 23.4 },
  a3: {width: 11.7, height: 16.54 },
  a4: {width: 8.27, height: 11.7 },
  a5: {width: 5.83, height: 8.27 },
  a6: {width: 4.13, height: 5.83 },
};

const unitToPixels = {
  'px': 1,
  'in': 96,
  'cm': 37.8,
  'mm': 3.78
};

function convertPrintParameterToInches(parameter: (string | number | undefined)): (number | undefined) {
  if (typeof parameter === 'undefined')
    return undefined;
  let pixels: number;
  if (helper.isNumber(parameter)) {
    // Treat numbers as pixel values to be aligned with phantom's paperSize.
    pixels = parameter as number;
  } else if (helper.isString(parameter)) {
    const text: string = parameter as string;
    let unit = text.substring(text.length - 2).toLowerCase();
    let valueText = '';
    if (unitToPixels.hasOwnProperty(unit)) {
      valueText = text.substring(0, text.length - 2);
    } else {
      // In case of unknown unit try to parse the whole parameter as number of pixels.
      // This is consistent with phantom's paperSize behavior.
      unit = 'px';
      valueText = text;
    }
    const value = Number(valueText);
    assert(!isNaN(value), 'Failed to parse parameter value: ' + text);
    pixels = value * unitToPixels[unit];
  } else {
    throw new Error('page.pdf() Cannot handle parameter type: ' + (typeof parameter));
  }
  return pixels / 96;
}

type NetworkCookie = {
  name: string,
  value: string,
  domain: string,
  path: string,
  expires: number,
  size: number,
  httpOnly: boolean,
  secure: boolean,
  session: boolean,
  sameSite?: 'Strict'|'Lax'|'Extended'|'None'
};

type NetworkCookieParam = {
  name: string,
  value: string,
  url?: string,
  domain?: string,
  path?: string,
  expires?: number,
  httpOnly?: boolean,
  secure?: boolean,
  sameSite?: 'Strict'|'Lax'
};


type DeleteNetworkCookieParam = {
  name: string,
  url?: string,
};

type ConsoleMessageLocation = {
  url?: string,
  lineNumber?: number,
  columnNumber?: number
};

export class ConsoleMessage {
  private _type: string;
  private _text: string;
  private _args: JSHandle[];
  private _location: any;

  constructor(type: string, text: string, args: JSHandle[], location: ConsoleMessageLocation = {}) {
    this._type = type;
    this._text = text;
    this._args = args;
    this._location = location;
  }

  type(): string {
    return this._type;
  }

  text(): string {
    return this._text;
  }

  args(): JSHandle[] {
    return this._args;
  }

  location(): object {
    return this._location;
  }
}
