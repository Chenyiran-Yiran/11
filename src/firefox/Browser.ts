/**
 * Copyright 2018 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventEmitter } from 'events';
import { helper, RegisteredListener, assert } from '../helper';
import { Connection, ConnectionEvents, JugglerSessionEvents } from './Connection';
import { Events } from './events';
import { Events as CommonEvents } from '../events';
import { Permissions } from './features/permissions';
import { Page } from '../page';
import { FrameManager } from './FrameManager';
import { Firefox } from './features/firefox';
import * as network from '../network';
import { BrowserContext, BrowserContextOptions } from '../browserContext';

export class Browser extends EventEmitter {
  _connection: Connection;
  private _process: import('child_process').ChildProcess;
  private _closeCallback: () => Promise<void>;
  _targets: Map<string, Target>;
  private _defaultContext: BrowserContext;
  private _contexts: Map<string, BrowserContext>;
  private _eventListeners: RegisteredListener[];
  readonly firefox: Firefox;

  static async create(connection: Connection, process: import('child_process').ChildProcess | null, closeCallback: () => Promise<void>) {
    const {browserContextIds} = await connection.send('Target.getBrowserContexts');
    const browser = new Browser(connection, browserContextIds, process, closeCallback);
    await connection.send('Target.enable');
    return browser;
  }

  constructor(connection: Connection, browserContextIds: Array<string>, process: import('child_process').ChildProcess | null, closeCallback: () => Promise<void>) {
    super();
    this._connection = connection;
    this._process = process;
    this._closeCallback = closeCallback;
    this.firefox = new Firefox(this);

    this._targets = new Map();

    this._defaultContext = this._createBrowserContext(null, {});
    this._contexts = new Map();
    for (const browserContextId of browserContextIds)
      this._contexts.set(browserContextId, this._createBrowserContext(browserContextId, {}));

    this._connection.on(ConnectionEvents.Disconnected, () => this.emit(Events.Browser.Disconnected));

    this._eventListeners = [
      helper.addEventListener(this._connection, 'Target.targetCreated', this._onTargetCreated.bind(this)),
      helper.addEventListener(this._connection, 'Target.targetDestroyed', this._onTargetDestroyed.bind(this)),
      helper.addEventListener(this._connection, 'Target.targetInfoChanged', this._onTargetInfoChanged.bind(this)),
    ];
  }

  disconnect() {
    this._connection.dispose();
  }

  isConnected(): boolean {
    return !this._connection._closed;
  }

  async newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const {browserContextId} = await this._connection.send('Target.createBrowserContext');
    // TODO: move ignoreHTTPSErrors to browser context level.
    if (options.ignoreHTTPSErrors)
      await this._connection.send('Browser.setIgnoreHTTPSErrors', { enabled: true });
    const context = this._createBrowserContext(browserContextId, options);
    this._contexts.set(browserContextId, context);
    return context;
  }

  browserContexts(): Array<BrowserContext> {
    return [this._defaultContext, ...Array.from(this._contexts.values())];
  }

  defaultContext() {
    return this._defaultContext;
  }

  async userAgent(): Promise<string> {
    const info = await this._connection.send('Browser.getInfo');
    return info.userAgent;
  }

  async version(): Promise<string> {
    const info = await this._connection.send('Browser.getInfo');
    return info.version;
  }

  process(): import('child_process').ChildProcess | null {
    return this._process;
  }

  async _waitForTarget(predicate: (target: Target) => boolean, options: { timeout?: number; } = {}): Promise<Target> {
    const {
      timeout = 30000
    } = options;
    const existingTarget = this._allTargets().find(predicate);
    if (existingTarget)
      return existingTarget;
    let resolve: (t: Target) => void;
    const targetPromise = new Promise<Target>(x => resolve = x);
    this.on('targetchanged', check);
    try {
      if (!timeout)
        return await targetPromise;
      return await helper.waitWithTimeout(targetPromise, 'target', timeout);
    } finally {
      this.removeListener('targetchanged', check);
    }

    function check(target: Target) {
      if (predicate(target))
        resolve(target);
    }
  }

  async newPage(options?: BrowserContextOptions): Promise<Page> {
    const context = await this.newContext(options);
    return context._createOwnerPage();
  }

  async pages() {
    const pageTargets = Array.from(this._targets.values()).filter(target => target.type() === 'page');
    return await Promise.all(pageTargets.map(target => target.page()));
  }

  _allTargets() {
    return Array.from(this._targets.values());
  }

  async _onTargetCreated({targetId, url, browserContextId, openerId, type}) {
    const context = browserContextId ? this._contexts.get(browserContextId) : this._defaultContext;
    const target = new Target(this._connection, this, context, targetId, type, url, openerId);
    this._targets.set(targetId, target);
    if (target.opener() && target.opener()._pagePromise) {
      const openerPage = await target.opener()._pagePromise;
      if (openerPage.listenerCount(CommonEvents.Page.Popup)) {
        const popupPage = await target.page();
        openerPage.emit(CommonEvents.Page.Popup, popupPage);
      }
    }
  }

  _onTargetDestroyed({targetId}) {
    const target = this._targets.get(targetId);
    this._targets.delete(targetId);
    target._didClose();
  }

  _onTargetInfoChanged({targetId, url}) {
    const target = this._targets.get(targetId);
    target._url = url;
  }

  async close() {
    helper.removeEventListeners(this._eventListeners);
    await this._closeCallback();
  }

  _createBrowserContext(browserContextId: string | null, options: BrowserContextOptions): BrowserContext {
    const context = new BrowserContext({
      pages: async (): Promise<Page[]> => {
        const targets = this._allTargets().filter(target => target.browserContext() === context && target.type() === 'page');
        const pages = await Promise.all(targets.map(target => target.page()));
        return pages.filter(page => !!page);
      },

      newPage: async (): Promise<Page> => {
        const {targetId} = await this._connection.send('Target.newPage', {
          browserContextId: browserContextId || undefined
        });
        const target = this._targets.get(targetId);
        const page = await target.page();
        const session = (page._delegate as FrameManager)._session;
        const promises: Promise<any>[] = [];
        if (options.viewport)
          promises.push(page._delegate.setViewport(options.viewport));
        if (options.bypassCSP)
          promises.push(session.send('Page.setBypassCSP', { enabled: true }));
        if (options.javaScriptEnabled === false)
          promises.push(session.send('Page.setJavascriptEnabled', { enabled: false }));
        if (options.userAgent)
          promises.push(session.send('Page.setUserAgent', { userAgent: options.userAgent }));
        if (options.mediaType || options.colorScheme)
          promises.push(session.send('Page.setEmulatedMedia', { type: options.mediaType, colorScheme: options.colorScheme }));
        await Promise.all(promises);
        return page;
      },

      close: async (): Promise<void> => {
        assert(browserContextId, 'Non-incognito profiles cannot be closed!');
        await this._connection.send('Target.removeBrowserContext', { browserContextId });
        this._contexts.delete(browserContextId);
      },

      cookies: async (): Promise<network.NetworkCookie[]> => {
        const { cookies } = await this._connection.send('Browser.getCookies', { browserContextId: browserContextId || undefined });
        return cookies.map(c => {
          const copy: any = { ... c };
          delete copy.size;
          return copy as network.NetworkCookie;
        });
      },

      clearCookies: async (): Promise<void> => {
        await this._connection.send('Browser.clearCookies', { browserContextId: browserContextId || undefined });
      },

      setCookies: async (cookies: network.SetNetworkCookieParam[]): Promise<void> => {
        await this._connection.send('Browser.setCookies', { browserContextId: browserContextId || undefined, cookies });
      },
    }, options);
    (context as any).permissions = new Permissions(this._connection, browserContextId);
    return context;
  }
}

export class Target {
  _pagePromise?: Promise<Page>;
  private _frameManager: FrameManager | null = null;
  private _browser: Browser;
  _context: BrowserContext;
  private _connection: Connection;
  private _targetId: string;
  private _type: 'page' | 'browser';
  _url: string;
  private _openerId: string;

  constructor(connection: any, browser: Browser, context: BrowserContext, targetId: string, type: 'page' | 'browser', url: string, openerId: string | undefined) {
    this._browser = browser;
    this._context = context;
    this._connection = connection;
    this._targetId = targetId;
    this._type = type;
    this._url = url;
    this._openerId = openerId;
  }

  _didClose() {
    if (this._frameManager)
      this._frameManager.didClose();
  }

  opener(): Target | null {
    return this._openerId ? this._browser._targets.get(this._openerId) : null;
  }

  type(): 'page' | 'browser' {
    return this._type;
  }

  url() {
    return this._url;
  }

  browserContext(): BrowserContext {
    return this._context;
  }

  page(): Promise<Page> {
    if (this._type === 'page' && !this._pagePromise) {
      this._pagePromise = new Promise(async f => {
        const session = await this._connection.createSession(this._targetId);
        this._frameManager = new FrameManager(session, this._context);
        const page = this._frameManager._page;
        session.once(JugglerSessionEvents.Disconnected, () => page._didDisconnect());
        await this._frameManager._initialize();
        f(page);
      });
    }
    return this._pagePromise;
  }

  browser() {
    return this._browser;
  }
}
