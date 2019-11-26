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

import * as types from '../types';
import * as fs from 'fs';
import { helper, assert } from '../helper';
import { ClickOptions, MultiClickOptions, PointerActionOptions, SelectOption } from '../input';
import { CDPSession } from './Connection';
import { ExecutionContext } from './ExecutionContext';
import { FrameManager } from './FrameManager';
import { ElementHandle, JSHandle, createJSHandle } from './JSHandle';
import { Response } from './NetworkManager';
import { Protocol } from './protocol';
import { LifecycleWatcher } from './LifecycleWatcher';
import { waitForSelectorOrXPath, WaitTaskParams, WaitTask } from '../waitTask';

const readFileAsync = helper.promisify(fs.readFile);

type WorldType = 'main' | 'utility';
type World = {
  contextPromise: Promise<ExecutionContext>;
  contextResolveCallback: (c: ExecutionContext) => void;
  context: ExecutionContext | null;
  waitTasks: Set<WaitTask<JSHandle>>;
};

export class Frame {
  _id: string;
  _frameManager: FrameManager;
  private _client: CDPSession;
  private _parentFrame: Frame;
  private _url = '';
  private _detached = false;
  _loaderId = '';
  _lifecycleEvents = new Set<string>();
  _worlds = new Map<WorldType, World>();
  private _childFrames = new Set<Frame>();
  private _name: string;
  private _navigationURL: string;

  constructor(frameManager: FrameManager, client: CDPSession, parentFrame: Frame | null, frameId: string) {
    this._frameManager = frameManager;
    this._client = client;
    this._parentFrame = parentFrame;
    this._id = frameId;

    this._worlds.set('main', { contextPromise: new Promise(() => {}), contextResolveCallback: () => {}, context: null, waitTasks: new Set() });
    this._worlds.set('utility', { contextPromise: new Promise(() => {}), contextResolveCallback: () => {}, context: null, waitTasks: new Set() });
    this._setContext('main', null);
    this._setContext('utility', null);

    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);
  }

  async goto(
    url: string,
    options: { referer?: string; timeout?: number; waitUntil?: string | string[]; } | undefined
  ): Promise<Response | null> {
    return await this._frameManager.navigateFrame(this, url, options);
  }

  async waitForNavigation(options: { timeout?: number; waitUntil?: string | string[]; } | undefined): Promise<Response | null> {
    return await this._frameManager.waitForFrameNavigation(this, options);
  }

  _mainContext(): Promise<ExecutionContext> {
    if (this._detached)
      throw new Error(`Execution Context is not available in detached frame "${this.url()}" (are you trying to evaluate?)`);
    return this._worlds.get('main').contextPromise;
  }

  _utilityContext(): Promise<ExecutionContext> {
    if (this._detached)
      throw new Error(`Execution Context is not available in detached frame "${this.url()}" (are you trying to evaluate?)`);
    return this._worlds.get('utility').contextPromise;
  }

  executionContext(): Promise<ExecutionContext> {
    return this._mainContext();
  }

  evaluateHandle: types.EvaluateHandle<JSHandle> = async (pageFunction, ...args) => {
    const context = await this._mainContext();
    return context.evaluateHandle(pageFunction, ...args as any);
  }

  evaluate: types.Evaluate<JSHandle> = async (pageFunction, ...args) => {
    const context = await this._mainContext();
    return context.evaluate(pageFunction, ...args as any);
  }

  async $(selector: string): Promise<ElementHandle | null> {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$(selector);
  }

  async $x(expression: string): Promise<ElementHandle[]> {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$x(expression);
  }

  $eval: types.$Eval<JSHandle> = async (selector, pageFunction, ...args) => {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$eval(selector, pageFunction, ...args as any);
  }

  $$eval: types.$$Eval<JSHandle> = async (selector, pageFunction, ...args) => {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$$eval(selector, pageFunction, ...args as any);
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$$(selector);
  }

  async content(): Promise<string> {
    const context = await this._utilityContext();
    return context.evaluate(() => {
      let retVal = '';
      if (document.doctype)
        retVal = new XMLSerializer().serializeToString(document.doctype);
      if (document.documentElement)
        retVal += document.documentElement.outerHTML;
      return retVal;
    });
  }

  async setContent(html: string, options: {
      timeout?: number;
      waitUntil?: string | string[];
    } = {}) {
    const {
      waitUntil = ['load'],
      timeout = this._frameManager._timeoutSettings.navigationTimeout(),
    } = options;
    const context = await this._utilityContext();
    // We rely upon the fact that document.open() will reset frame lifecycle with "init"
    // lifecycle event. @see https://crrev.com/608658
    await context.evaluate(html => {
      document.open();
      document.write(html);
      document.close();
    }, html);
    const watcher = new LifecycleWatcher(this._frameManager, this, waitUntil, timeout);
    const error = await Promise.race([
      watcher.timeoutOrTerminationPromise(),
      watcher.lifecyclePromise(),
    ]);
    watcher.dispose();
    if (error)
      throw error;
  }

  name(): string {
    return this._name || '';
  }

  url(): string {
    return this._url;
  }

  parentFrame(): Frame | null {
    return this._parentFrame;
  }

  childFrames(): Frame[] {
    return Array.from(this._childFrames);
  }

  isDetached(): boolean {
    return this._detached;
  }

  async addScriptTag(options: {
      url?: string; path?: string;
      content?: string;
      type?: string;
    }): Promise<ElementHandle> {
    const {
      url = null,
      path = null,
      content = null,
      type = ''
    } = options;
    if (url !== null) {
      try {
        const context = await this._mainContext();
        return (await context.evaluateHandle(addScriptUrl, url, type)).asElement();
      } catch (error) {
        throw new Error(`Loading script from ${url} failed`);
      }
    }

    if (path !== null) {
      let contents = await readFileAsync(path, 'utf8');
      contents += '//# sourceURL=' + path.replace(/\n/g, '');
      const context = await this._mainContext();
      return (await context.evaluateHandle(addScriptContent, contents, type)).asElement();
    }

    if (content !== null) {
      const context = await this._mainContext();
      return (await context.evaluateHandle(addScriptContent, content, type)).asElement();
    }

    throw new Error('Provide an object with a `url`, `path` or `content` property');

    async function addScriptUrl(url: string, type: string): Promise<HTMLElement> {
      const script = document.createElement('script');
      script.src = url;
      if (type)
        script.type = type;
      const promise = new Promise((res, rej) => {
        script.onload = res;
        script.onerror = rej;
      });
      document.head.appendChild(script);
      await promise;
      return script;
    }

    function addScriptContent(content: string, type: string = 'text/javascript'): HTMLElement {
      const script = document.createElement('script');
      script.type = type;
      script.text = content;
      let error = null;
      script.onerror = e => error = e;
      document.head.appendChild(script);
      if (error)
        throw error;
      return script;
    }
  }

  async addStyleTag(options: { url?: string; path?: string; content?: string; }): Promise<ElementHandle> {
    const {
      url = null,
      path = null,
      content = null
    } = options;
    if (url !== null) {
      try {
        const context = await this._mainContext();
        return (await context.evaluateHandle(addStyleUrl, url)).asElement();
      } catch (error) {
        throw new Error(`Loading style from ${url} failed`);
      }
    }

    if (path !== null) {
      let contents = await readFileAsync(path, 'utf8');
      contents += '/*# sourceURL=' + path.replace(/\n/g, '') + '*/';
      const context = await this._mainContext();
      return (await context.evaluateHandle(addStyleContent, contents)).asElement();
    }

    if (content !== null) {
      const context = await this._mainContext();
      return (await context.evaluateHandle(addStyleContent, content)).asElement();
    }

    throw new Error('Provide an object with a `url`, `path` or `content` property');

    async function addStyleUrl(url: string): Promise<HTMLElement> {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      const promise = new Promise((res, rej) => {
        link.onload = res;
        link.onerror = rej;
      });
      document.head.appendChild(link);
      await promise;
      return link;
    }

    async function addStyleContent(content: string): Promise<HTMLElement> {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      const promise = new Promise((res, rej) => {
        style.onload = res;
        style.onerror = rej;
      });
      document.head.appendChild(style);
      await promise;
      return style;
    }
  }

  async click(selector: string, options?: ClickOptions) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.click(options);
    await handle.dispose();
  }

  async dblclick(selector: string, options?: MultiClickOptions) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.dblclick(options);
    await handle.dispose();
  }

  async tripleclick(selector: string, options?: MultiClickOptions) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.tripleclick(options);
    await handle.dispose();
  }

  async fill(selector: string, value: string) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.fill(value);
    await handle.dispose();
  }

  async focus(selector: string) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.focus();
    await handle.dispose();
  }

  async hover(selector: string, options?: PointerActionOptions) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.hover(options);
    await handle.dispose();
  }

  async select(selector: string, ...values: (string | ElementHandle | SelectOption)[]): Promise<string[]> {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    const utilityContext = await this._utilityContext();
    const adoptedValues = await Promise.all(values.map(async value => value instanceof ElementHandle ? this._adoptElementHandle(value, utilityContext, false /* dispose */) : value));
    const result = await handle.select(...adoptedValues);
    await handle.dispose();
    return result;
  }

  async type(selector: string, text: string, options: { delay: (number | undefined); } | undefined) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.type(text, options);
    await handle.dispose();
  }

  waitFor(selectorOrFunctionOrTimeout: (string | number | Function), options: any = {}, ...args: any[]): Promise<JSHandle | null> {
    const xPathPattern = '//';

    if (helper.isString(selectorOrFunctionOrTimeout)) {
      const string = selectorOrFunctionOrTimeout as string;
      if (string.startsWith(xPathPattern))
        return this.waitForXPath(string, options);
      return this.waitForSelector(string, options);
    }
    if (helper.isNumber(selectorOrFunctionOrTimeout))
      return new Promise(fulfill => setTimeout(fulfill, selectorOrFunctionOrTimeout as number));
    if (typeof selectorOrFunctionOrTimeout === 'function')
      return this.waitForFunction(selectorOrFunctionOrTimeout, options, ...args);
    return Promise.reject(new Error('Unsupported target type: ' + (typeof selectorOrFunctionOrTimeout)));
  }

  async waitForSelector(selector: string, options: {
      visible?: boolean;
      hidden?: boolean;
      timeout?: number; } | undefined): Promise<ElementHandle | null> {
    const params = waitForSelectorOrXPath(selector, false /* isXPath */, { timeout: this._frameManager._timeoutSettings.timeout(), ...options });
    const handle = await this._scheduleWaitTask(params, this._worlds.get('utility'));
    if (!handle.asElement()) {
      await handle.dispose();
      return null;
    }
    const mainContext = await this._mainContext();
    return this._adoptElementHandle(handle.asElement(), mainContext, true /* dispose */);
  }

  async waitForXPath(xpath: string, options: {
      visible?: boolean;
      hidden?: boolean;
      timeout?: number; } | undefined): Promise<ElementHandle | null> {
    const params = waitForSelectorOrXPath(xpath, true /* isXPath */, { timeout: this._frameManager._timeoutSettings.timeout(), ...options });
    const handle = await this._scheduleWaitTask(params, this._worlds.get('utility'));
    if (!handle.asElement()) {
      await handle.dispose();
      return null;
    }
    const mainContext = await this._mainContext();
    return this._adoptElementHandle(handle.asElement(), mainContext, true /* dispose */);
  }

  waitForFunction(
    pageFunction: Function | string,
    options: { polling?: string | number; timeout?: number; } = {},
    ...args): Promise<JSHandle> {
    const {
      polling = 'raf',
      timeout = this._frameManager._timeoutSettings.timeout(),
    } = options;
    const params: WaitTaskParams = {
      predicateBody: pageFunction,
      title: 'function',
      polling,
      timeout,
      args
    };
    return this._scheduleWaitTask(params, this._worlds.get('main'));
  }

  async title(): Promise<string> {
    const context = await this._utilityContext();
    return context.evaluate(() => document.title);
  }

  _navigated(framePayload: Protocol.Page.Frame) {
    this._name = framePayload.name;
    // TODO(lushnikov): remove this once requestInterception has loaderId exposed.
    this._navigationURL = framePayload.url;
    this._url = framePayload.url;
  }

  _navigatedWithinDocument(url: string) {
    this._url = url;
  }

  _onLifecycleEvent(loaderId: string, name: string) {
    if (name === 'init') {
      this._loaderId = loaderId;
      this._lifecycleEvents.clear();
    }
    this._lifecycleEvents.add(name);
  }

  _onLoadingStopped() {
    this._lifecycleEvents.add('DOMContentLoaded');
    this._lifecycleEvents.add('load');
  }

  _detach() {
    this._detached = true;
    for (const world of this._worlds.values()) {
      for (const waitTask of world.waitTasks)
        waitTask.terminate(new Error('waitForFunction failed: frame got detached.'));
    }
    if (this._parentFrame)
      this._parentFrame._childFrames.delete(this);
    this._parentFrame = null;
  }

  private _scheduleWaitTask(params: WaitTaskParams, world: World): Promise<JSHandle> {
    const task = new WaitTask(params, () => world.waitTasks.delete(task));
    world.waitTasks.add(task);
    if (world.context)
      task.rerun(world.context);
    return task.promise;
  }

  private _setContext(worldType: WorldType, context: ExecutionContext | null) {
    const world = this._worlds.get(worldType);
    world.context = context;
    if (context) {
      world.contextResolveCallback.call(null, context);
      for (const waitTask of world.waitTasks)
        waitTask.rerun(context);
    } else {
      world.contextPromise = new Promise(fulfill => {
        world.contextResolveCallback = fulfill;
      });
    }
  }

  _contextCreated(worldType: WorldType, context: ExecutionContext) {
    const world = this._worlds.get(worldType);
    // In case of multiple sessions to the same target, there's a race between
    // connections so we might end up creating multiple isolated worlds.
    // We can use either.
    if (!world.context)
      this._setContext(worldType, context);
  }

  _contextDestroyed(context: ExecutionContext) {
    for (const [worldType, world] of this._worlds) {
      if (world.context === context)
        this._setContext(worldType, null);
    }
  }

  private async _adoptElementHandle(elementHandle: ElementHandle, context: ExecutionContext, dispose: boolean): Promise<ElementHandle> {
    if (elementHandle.executionContext() === context)
      return elementHandle;
    const nodeInfo = await this._client.send('DOM.describeNode', {
      objectId: elementHandle._remoteObject.objectId,
    });
    const result = await context._adoptBackendNodeId(nodeInfo.node.backendNodeId);
    if (dispose)
      await elementHandle.dispose();
    return result;
  }
}
