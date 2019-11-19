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

import {RegisteredListener, helper, assert} from '../helper';
import {Page, Viewport} from './Page';
import {EventEmitter} from 'events';
import {Connection, ConnectionEvents} from './Connection';
import {Events} from '../Events';

export class Browser extends EventEmitter {
  private _connection: Connection;
  _defaultViewport: Viewport;
  private _process: import('child_process').ChildProcess;
  private _closeCallback: () => void;
  _targets: Map<string, Target>;
  private _defaultContext: BrowserContext;
  private _contexts: Map<string, BrowserContext>;
  private _eventListeners: RegisteredListener[];

  static async create(connection: Connection, defaultViewport: Viewport | null, process: import('child_process').ChildProcess | null, closeCallback: () => void) {
    const {browserContextIds} = await connection.send('Target.getBrowserContexts');
    const browser = new Browser(connection, browserContextIds, defaultViewport, process, closeCallback);
    await connection.send('Target.enable');
    return browser;
  }


  constructor(connection: Connection, browserContextIds: Array<string>, defaultViewport: Viewport | null, process: import('child_process').ChildProcess | null, closeCallback: () => void) {
    super();
    this._connection = connection;
    this._defaultViewport = defaultViewport;
    this._process = process;
    this._closeCallback = closeCallback;

    this._targets = new Map();

    this._defaultContext = new BrowserContext(this._connection, this, null);
    this._contexts = new Map();
    for (const browserContextId of browserContextIds)
      this._contexts.set(browserContextId, new BrowserContext(this._connection, this, browserContextId));

    this._connection.on(ConnectionEvents.Disconnected, () => this.emit(Events.Browser.Disconnected));

    this._eventListeners = [
      helper.addEventListener(this._connection, 'Target.targetCreated', this._onTargetCreated.bind(this)),
      helper.addEventListener(this._connection, 'Target.targetDestroyed', this._onTargetDestroyed.bind(this)),
      helper.addEventListener(this._connection, 'Target.targetInfoChanged', this._onTargetInfoChanged.bind(this)),
    ];
  }

  wsEndpoint() {
    return this._connection.url();
  }

  disconnect() {
    this._connection.dispose();
  }


  isConnected(): boolean {
    return !this._connection._closed;
  }

  async createIncognitoBrowserContext(): Promise<BrowserContext> {
    const {browserContextId} = await this._connection.send('Target.createBrowserContext');
    const context = new BrowserContext(this._connection, this, browserContextId);
    this._contexts.set(browserContextId, context);
    return context;
  }


  browserContexts(): Array<BrowserContext> {
    return [this._defaultContext, ...Array.from(this._contexts.values())];
  }

  defaultBrowserContext() {
    return this._defaultContext;
  }

  async _disposeContext(browserContextId) {
    await this._connection.send('Target.removeBrowserContext', {browserContextId});
    this._contexts.delete(browserContextId);
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


  async waitForTarget(predicate: (target: Target) => boolean, options: { timeout?: number; } = {}): Promise<Target> {
    const {
      timeout = 30000
    } = options;
    const existingTarget = this.targets().find(predicate);
    if (existingTarget)
      return existingTarget;
    let resolve;
    const targetPromise = new Promise<Target>(x => resolve = x);
    this.on(Events.Browser.TargetCreated, check);
    this.on('targetchanged', check);
    try {
      if (!timeout)
        return await targetPromise;
      return await helper.waitWithTimeout(targetPromise, 'target', timeout);
    } finally {
      this.removeListener(Events.Browser.TargetCreated, check);
      this.removeListener('targetchanged', check);
    }

    function check(target: Target) {
      if (predicate(target))
        resolve(target);
    }
  }


  newPage(): Promise<Page> {
    return this._createPageInContext(this._defaultContext._browserContextId);
  }


  async _createPageInContext(browserContextId: string | null): Promise<Page> {
    const {targetId} = await this._connection.send('Target.newPage', {
      browserContextId: browserContextId || undefined
    });
    const target = this._targets.get(targetId);
    return await target.page();
  }

  async pages() {
    const pageTargets = Array.from(this._targets.values()).filter(target => target.type() === 'page');
    return await Promise.all(pageTargets.map(target => target.page()));
  }

  targets() {
    return Array.from(this._targets.values());
  }

  target() {
    return this.targets().find(target => target.type() === 'browser');
  }

  async _onTargetCreated({targetId, url, browserContextId, openerId, type}) {
    const context = browserContextId ? this._contexts.get(browserContextId) : this._defaultContext;
    const target = new Target(this._connection, this, context, targetId, type, url, openerId);
    this._targets.set(targetId, target);
    if (target.opener() && target.opener()._pagePromise) {
      const openerPage = await target.opener()._pagePromise;
      if (openerPage.listenerCount(Events.Page.Popup)) {
        const popupPage = await target.page();
        openerPage.emit(Events.Page.Popup, popupPage);
      }
    }
    this.emit(Events.Browser.TargetCreated, target);
    context.emit(Events.BrowserContext.TargetCreated, target);
  }

  _onTargetDestroyed({targetId}) {
    const target = this._targets.get(targetId);
    this._targets.delete(targetId);
    target._closedCallback();
    this.emit(Events.Browser.TargetDestroyed, target);
    target.browserContext().emit(Events.BrowserContext.TargetDestroyed, target);
  }

  _onTargetInfoChanged({targetId, url}) {
    const target = this._targets.get(targetId);
    target._url = url;
    this.emit(Events.Browser.TargetChanged, target);
    target.browserContext().emit(Events.BrowserContext.TargetChanged, target);
  }

  async close() {
    helper.removeEventListeners(this._eventListeners);
    await this._closeCallback();
  }
}

export class Target {
  _pagePromise?: Promise<Page>;
  private _browser: Browser;
  _context: BrowserContext;
  private _connection: any;
  private _targetId: string;
  private _type: 'page' | 'browser';
  _url: string;
  private _openerId: string;
  _isClosedPromise: Promise<unknown>;
  _closedCallback: (value?: unknown) => void;

  constructor(connection: any, browser: Browser, context: BrowserContext, targetId: string, type: 'page' | 'browser', url: string, openerId: string | undefined) {
    this._browser = browser;
    this._context = context;
    this._connection = connection;
    this._targetId = targetId;
    this._type = type;
    this._url = url;
    this._openerId = openerId;
    this._isClosedPromise = new Promise(fulfill => this._closedCallback = fulfill);
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

  async page() {
    if (this._type === 'page' && !this._pagePromise) {
      const session = await this._connection.createSession(this._targetId);
      this._pagePromise = Page.create(session, this, this._browser._defaultViewport);
    }
    return this._pagePromise;
  }

  browser() {
    return this._browser;
  }
}

export class BrowserContext extends EventEmitter {
  _connection: Connection;
  _browser: Browser;
  _browserContextId: string;

  constructor(connection: Connection, browser: Browser, browserContextId: string | null) {
    super();
    this._connection = connection;
    this._browser = browser;
    this._browserContextId = browserContextId;
  }


  async overridePermissions(origin: string, permissions: Array<string>) {
    const webPermissionToProtocol = new Map([
      ['geolocation', 'geo'],
      ['microphone', 'microphone'],
      ['camera', 'camera'],
      ['notifications', 'desktop-notifications'],
    ]);
    permissions = permissions.map(permission => {
      const protocolPermission = webPermissionToProtocol.get(permission);
      if (!protocolPermission)
        throw new Error('Unknown permission: ' + permission);
      return protocolPermission;
    });
    await this._connection.send('Browser.grantPermissions', {origin, browserContextId: this._browserContextId || undefined, permissions});
  }

  async clearPermissionOverrides() {
    await this._connection.send('Browser.resetPermissions', {browserContextId: this._browserContextId || undefined});
  }


  targets(): Array<Target> {
    return this._browser.targets().filter(target => target.browserContext() === this);
  }


  async pages(): Promise<Array<Page>> {
    const pages = await Promise.all(
        this.targets()
            .filter(target => target.type() === 'page')
            .map(target => target.page())
    );
    return pages.filter(page => !!page);
  }


  waitForTarget(predicate: (arg0: Target) => boolean, options: { timeout?: number; } | undefined): Promise<Target> {
    return this._browser.waitForTarget(target => target.browserContext() === this && predicate(target), options);
  }


  isIncognito(): boolean {
    return !!this._browserContextId;
  }

  newPage() {
    return this._browser._createPageInContext(this._browserContextId);
  }


  browser(): Browser {
    return this._browser;
  }

  async close() {
    assert(this._browserContextId, 'Non-incognito contexts cannot be closed!');
    await this._browser._disposeContext(this._browserContextId);
  }
}

module.exports = {Browser, BrowserContext, Target};
