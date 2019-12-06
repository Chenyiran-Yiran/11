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
import * as console from '../console';
import * as dialog from '../dialog';
import * as dom from '../dom';
import * as frames from '../frames';
import { assert, debugError, helper, RegisteredListener } from '../helper';
import * as input from '../input';
import { ClickOptions, mediaColorSchemes, mediaTypes, MultiClickOptions } from '../input';
import * as js from '../javascript';
import * as network from '../network';
import { Screenshotter } from '../screenshotter';
import { TimeoutSettings } from '../TimeoutSettings';
import * as types from '../types';
import { Browser, BrowserContext } from './Browser';
import { TargetSession, TargetSessionEvents } from './Connection';
import { Events } from './events';
import { FrameManager, FrameManagerEvents } from './FrameManager';
import { RawKeyboardImpl, RawMouseImpl } from './Input';
import { NetworkManagerEvents } from './NetworkManager';
import { Protocol } from './protocol';
import { WKScreenshotDelegate } from './Screenshotter';

export class Page extends EventEmitter {
  private _closed = false;
  private _closedCallback: () => void;
  private _closedPromise: Promise<void>;
  _session: TargetSession;
  private _browserContext: BrowserContext;
  private _keyboard: input.Keyboard;
  private _mouse: input.Mouse;
  private _timeoutSettings: TimeoutSettings;
  private _frameManager: FrameManager;
  private _bootstrapScripts: string[] = [];
  _javascriptEnabled = true;
  private _viewport: types.Viewport | null = null;
  _screenshotter: Screenshotter;
  private _workers = new Map<string, Worker>();
  private _disconnectPromise: Promise<Error> | undefined;
  private _sessionListeners: RegisteredListener[] = [];
  private _emulatedMediaType: string | undefined;
  private _fileChooserInterceptors = new Set<(chooser: FileChooser) => void>();

  static async create(session: TargetSession, browserContext: BrowserContext, defaultViewport: types.Viewport | null): Promise<Page> {
    const page = new Page(session, browserContext);
    await page._initialize();
    if (defaultViewport)
      await page.setViewport(defaultViewport);
    return page;
  }

  constructor(session: TargetSession, browserContext: BrowserContext) {
    super();
    this._closedPromise = new Promise(f => this._closedCallback = f);
    this._keyboard = new input.Keyboard(new RawKeyboardImpl(session));
    this._mouse = new input.Mouse(new RawMouseImpl(session), this._keyboard);
    this._timeoutSettings = new TimeoutSettings();
    this._frameManager = new FrameManager(session, this, this._timeoutSettings);

    this._screenshotter = new Screenshotter(this, new WKScreenshotDelegate(session), browserContext.browser());

    this._setSession(session);
    this._browserContext = browserContext;

    this._frameManager.on(FrameManagerEvents.FrameAttached, event => this.emit(Events.Page.FrameAttached, event));
    this._frameManager.on(FrameManagerEvents.FrameDetached, event => this.emit(Events.Page.FrameDetached, event));
    this._frameManager.on(FrameManagerEvents.FrameNavigated, event => this.emit(Events.Page.FrameNavigated, event));

    const networkManager = this._frameManager.networkManager();
    networkManager.on(NetworkManagerEvents.Request, event => this.emit(Events.Page.Request, event));
    networkManager.on(NetworkManagerEvents.Response, event => this.emit(Events.Page.Response, event));
    networkManager.on(NetworkManagerEvents.RequestFailed, event => this.emit(Events.Page.RequestFailed, event));
    networkManager.on(NetworkManagerEvents.RequestFinished, event => this.emit(Events.Page.RequestFinished, event));
  }

  _didClose() {
    assert(!this._closed, 'Page closed twice');
    this._closed = true;
    this.emit(Events.Page.Close);
    this._closedCallback();
  }

  async _initialize() {
    return Promise.all([
      this._frameManager.initialize(),
      this._session.send('Console.enable'),
      this._session.send('Dialog.enable'),
      this._session.send('Page.setInterceptFileChooserDialog', { enabled: true }),
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
      helper.addEventListener(this._session, 'Dialog.javascriptDialogOpening', event => this._onDialog(event)),
      helper.addEventListener(this._session, 'Page.fileChooserOpened', event => this._onFileChooserOpened(event))
    ];
  }

  _onDialog(event: Protocol.Dialog.javascriptDialogOpeningPayload) {
    this.emit(Events.Page.Dialog, new dialog.Dialog(
      event.type as dialog.DialogType,
      event.message,
      async (accept: boolean, promptText?: string) => {
        await this._session.send('Dialog.handleJavaScriptDialog', { accept, promptText });
      },
      event.defaultPrompt));
  }

  async _swapSessionOnNavigation(newSession: TargetSession) {
    this._setSession(newSession);
    await this._frameManager._swapSessionOnNavigation(newSession);
    await this._initialize().catch(e => debugError('failed to enable agents after swap: ' + e));
  }

  browser(): Browser {
    return this._browserContext.browser();
  }

  browserContext(): BrowserContext {
    return this._browserContext;
  }

  _onTargetCrashed() {
    this.emit('error', new Error('Page crashed!'));
  }

  async _onConsoleMessage(event: Protocol.Console.messageAddedPayload) {
    const { type, level, text, parameters, url, line: lineNumber, column: columnNumber } = event.message;
    let derivedType: string = type;
    if (type === 'log')
      derivedType = level;
    else if (type === 'timing')
      derivedType = 'timeEnd';
    const mainFrameContext = await this.mainFrame().executionContext();
    const handles = (parameters || []).map(p => {
      let context: js.ExecutionContext | null = null;
      if (p.objectId) {
        const objectId = JSON.parse(p.objectId);
        context = this._frameManager._contextIdToContext.get(objectId.injectedScriptId);
      } else {
        context = mainFrameContext;
      }
      return context._createHandle(p);
    });
    this.emit(Events.Page.Console, new console.ConsoleMessage(derivedType, handles.length ? undefined : text, handles, { url, lineNumber, columnNumber }));
  }

  mainFrame(): frames.Frame {
    return this._frameManager.mainFrame();
  }

  get keyboard(): input.Keyboard {
    return this._keyboard;
  }

  frames(): frames.Frame[] {
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

  async $(selector: string | types.Selector): Promise<dom.ElementHandle | null> {
    return this.mainFrame().$(selector);
  }

  evaluateHandle: types.EvaluateHandle = async (pageFunction, ...args) => {
    const context = await this.mainFrame().executionContext();
    return context.evaluateHandle(pageFunction, ...args as any);
  }

  $eval: types.$Eval = (selector, pageFunction, ...args) => {
    return this.mainFrame().$eval(selector, pageFunction, ...args as any);
  }

  $$eval: types.$$Eval = (selector, pageFunction, ...args) => {
    return this.mainFrame().$$eval(selector, pageFunction, ...args as any);
  }

  async $$(selector: string | types.Selector): Promise<dom.ElementHandle[]> {
    return this.mainFrame().$$(selector);
  }

  async $x(expression: string): Promise<dom.ElementHandle[]> {
    return this.mainFrame().$x(expression);
  }

  async addScriptTag(options: { url?: string; path?: string; content?: string; type?: string; }): Promise<dom.ElementHandle> {
    return this.mainFrame().addScriptTag(options);
  }

  async addStyleTag(options: { url?: string; path?: string; content?: string; }): Promise<dom.ElementHandle> {
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

  async setContent(html: string, options: { timeout?: number; waitUntil?: string | string[]; } = {}) {
    await this._frameManager.mainFrame().setContent(html, options);
  }

  async goto(url: string, options: { referer?: string; timeout?: number; waitUntil?: string | string[]; } = {}): Promise<network.Response | null> {
    return await this._frameManager.mainFrame().goto(url, options);
  }

  async reload(): Promise<network.Response | null> {
    const [response] = await Promise.all([
      this.waitForNavigation(),
      this._session.send('Page.reload')
    ]);
    return response;
  }

  async goBack(): Promise<network.Response | null> {
    return await this._go('Page.goBack');
  }

  async goForward(): Promise<network.Response | null> {
    return await this._go('Page.goForward');
  }

  async _go<T extends keyof Protocol.CommandParameters>(command: T): Promise<network.Response | null> {
    const [response] = await Promise.all([
      this.waitForNavigation(),
      this._session.send(command).then(() => null),
    ]).catch(error => {
      if (error instanceof Error && error.message.includes(`Protocol error (${command}): Failed to go`))
        return [null];
      throw error;
    });
    return response;
  }

  async waitForNavigation(): Promise<network.Response | null> {
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

  async emulate(options: { viewport: types.Viewport; userAgent: string; }) {
    await Promise.all([
      this.setViewport(options.viewport),
      this.setUserAgent(options.userAgent)
    ]);
  }

  async emulateMedia(options: {
      type?: string | null,
      colorScheme?: 'dark' | 'light' | 'no-preference' | null }) {
    assert(!options.type || mediaTypes.has(options.type), 'Unsupported media type: ' + options.type);
    assert(!options.colorScheme || mediaColorSchemes.has(options.colorScheme), 'Unsupported color scheme: ' + options.colorScheme);
    assert(!options.colorScheme, 'Media feature emulation is not supported');
    const media = typeof options.type === 'undefined' ? this._emulatedMediaType : options.type;
    await this._session.send('Page.setEmulatedMedia', { media: media || '' });
    this._emulatedMediaType = options.type;
  }

  async setViewport(viewport: types.Viewport) {
    this._viewport = viewport;
    const width = viewport.width;
    const height = viewport.height;
    await this._session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: viewport.deviceScaleFactor || 1 });
  }

  viewport(): types.Viewport | null {
    return this._viewport;
  }

  evaluate: types.Evaluate = (pageFunction, ...args) => {
    return this._frameManager.mainFrame().evaluate(pageFunction, ...args as any);
  }

  async evaluateOnNewDocument(pageFunction: Function | string, ...args: Array<any>) {
    const script = helper.evaluationString(pageFunction, ...args);
    this._bootstrapScripts.push(script);
    const source = this._bootstrapScripts.join(';');
    // TODO(yurys): support process swap on navigation.
    await this._session.send('Page.setBootstrapScript', { source });
  }

  async setJavaScriptEnabled(enabled: boolean) {
    if (this._javascriptEnabled === enabled)
      return;
    this._javascriptEnabled = enabled;
    await this._session.send('Emulation.setJavaScriptEnabled', { enabled });
  }

  async setCacheEnabled(enabled: boolean = true) {
    await this._frameManager.networkManager().setCacheEnabled(enabled);
  }

  screenshot(options?: types.ScreenshotOptions): Promise<Buffer> {
    return this._screenshotter.screenshotPage(options);
  }

  async title(): Promise<string> {
    return this.mainFrame().title();
  }

  async close() {
    this.browser()._closePage(this);
    await this._closedPromise;
  }

  isClosed(): boolean {
    return this._closed;
  }

  async waitForFileChooser(options: { timeout?: number; } = {}): Promise<FileChooser> {
    const {
      timeout = this._timeoutSettings.timeout(),
    } = options;
    let callback;
    const promise = new Promise<FileChooser>(x => callback = x);
    this._fileChooserInterceptors.add(callback);
    return helper.waitWithTimeout<FileChooser>(promise, 'waiting for file chooser', timeout).catch(e => {
      this._fileChooserInterceptors.delete(callback);
      throw e;
    });
  }

  async _onFileChooserOpened(event: {frameId: Protocol.Network.FrameId, element: Protocol.Runtime.RemoteObject}) {
    if (!this._fileChooserInterceptors.size)
      return;
    const context = await this._frameManager.frame(event.frameId)._utilityContext();
    const handle = context._createHandle(event.element).asElement()!;
    const interceptors = Array.from(this._fileChooserInterceptors);
    this._fileChooserInterceptors.clear();
    const multiple = await handle.evaluate((element: HTMLInputElement) => !!element.multiple);
    const fileChooser = { element: handle, multiple };
    for (const interceptor of interceptors)
      interceptor.call(null, fileChooser);
    this.emit(Events.Page.FileChooser, fileChooser);
  }

  get mouse(): input.Mouse {
    return this._mouse;
  }

  click(selector: string | types.Selector, options?: ClickOptions) {
    return this.mainFrame().click(selector, options);
  }

  dblclick(selector: string | types.Selector, options?: MultiClickOptions) {
    return this.mainFrame().dblclick(selector, options);
  }

  tripleclick(selector: string | types.Selector, options?: MultiClickOptions) {
    return this.mainFrame().tripleclick(selector, options);
  }

  hover(selector: string | types.Selector) {
    return this.mainFrame().hover(selector);
  }

  fill(selector: string | types.Selector, value: string) {
    return this.mainFrame().fill(selector, value);
  }

  focus(selector: string | types.Selector) {
    return this.mainFrame().focus(selector);
  }

  select(selector: string | types.Selector, ...values: string[]): Promise<string[]> {
    return this.mainFrame().select(selector, ...values);
  }

  type(selector: string | types.Selector, text: string, options?: { delay: (number | undefined); }) {
    return this.mainFrame().type(selector, text, options);
  }

  waitFor(selectorOrFunctionOrTimeout: (string | number | Function), options?: { visible?: boolean; hidden?: boolean; timeout?: number; polling?: string | number; }, ...args: any[]): Promise<js.JSHandle> {
    return this.mainFrame().waitFor(selectorOrFunctionOrTimeout, options, ...args);
  }

  waitForSelector(selector: string | types.Selector, options?: types.TimeoutOptions): Promise<dom.ElementHandle | null> {
    return this.mainFrame().waitForSelector(selector, options);
  }

  waitForXPath(xpath: string, options?: types.TimeoutOptions): Promise<dom.ElementHandle | null> {
    return this.mainFrame().waitForXPath(xpath, options);
  }

  waitForFunction(pageFunction: Function | string, options?: types.WaitForFunctionOptions, ...args: any[]): Promise<js.JSHandle> {
    return this.mainFrame().waitForFunction(pageFunction, options, ...args);
  }
}

type FileChooser = {
  element: dom.ElementHandle,
  multiple: boolean
};
