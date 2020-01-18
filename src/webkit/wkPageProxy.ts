/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


import { BrowserContext } from '../browserContext';
import { Page } from '../page';
import { Protocol } from './protocol';
import { WKSession } from './wkConnection';
import { WKPage } from './wkPage';
import { RegisteredListener, helper, assert, debugError } from '../helper';
import { Events } from '../events';
import { WKProvisionalPage } from './wkProvisionalPage';

const isPovisionalSymbol = Symbol('isPovisional');

export class WKPageProxy {
  private readonly _pageProxySession: WKSession;
  readonly _browserContext: BrowserContext;
  private _pagePromise: Promise<Page> | null = null;
  private _wkPage: WKPage | null = null;
  private _provisionalPage: WKProvisionalPage | null = null;
  private readonly _firstTargetPromise: Promise<void>;
  private _firstTargetCallback?: () => void;
  private readonly _sessions = new Map<string, WKSession>();
  private readonly _eventListeners: RegisteredListener[];

  constructor(pageProxySession: WKSession, browserContext: BrowserContext) {
    this._pageProxySession = pageProxySession;
    this._browserContext = browserContext;
    this._firstTargetPromise = new Promise(r => this._firstTargetCallback = r);
    this._eventListeners = [
      helper.addEventListener(this._pageProxySession, 'Target.targetCreated', this._onTargetCreated.bind(this)),
      helper.addEventListener(this._pageProxySession, 'Target.targetDestroyed', this._onTargetDestroyed.bind(this)),
      helper.addEventListener(this._pageProxySession, 'Target.dispatchMessageFromTarget', this._onDispatchMessageFromTarget.bind(this)),
      helper.addEventListener(this._pageProxySession, 'Target.didCommitProvisionalTarget', this._onDidCommitProvisionalTarget.bind(this)),
    ];

    // Intercept provisional targets during cross-process navigation.
    this._pageProxySession.send('Target.setPauseOnStart', { pauseOnStart: true }).catch(e => {
      if (this._pageProxySession.isDisposed())
        return;
      debugError(e);
      throw e;
    });
  }

  didClose() {
    if (this._wkPage)
      this._wkPage.didClose(false);
  }

  dispose() {
    this._pageProxySession.dispose();
    helper.removeEventListeners(this._eventListeners);
    for (const session of this._sessions.values())
      session.dispose();
    this._sessions.clear();
    if (this._provisionalPage) {
      this._provisionalPage.dispose();
      this._provisionalPage = null;
    }
    if (this._wkPage)
      this._wkPage.didDisconnect();
  }

  dispatchMessageToSession(message: any) {
    this._pageProxySession.dispatchMessage(message);
  }

  private _isProvisionalCrossProcessLoadInProgress() : boolean {
    for (const anySession of this._sessions.values()) {
      if ((anySession as any)[isPovisionalSymbol])
        return true;
    }
    return false;
  }

  handleProvisionalLoadFailed(event: Protocol.Browser.provisionalLoadFailedPayload) {
    if (!this._wkPage)
      return;
    if (!this._isProvisionalCrossProcessLoadInProgress())
      return;
    let errorText = event.error;
    if (errorText.includes('cancelled'))
      errorText += '; maybe frame was detached?';
    this._wkPage._page._frameManager.provisionalLoadFailed(event.loaderId, errorText);
  }

  async page(): Promise<Page> {
    if (!this._pagePromise)
      this._pagePromise = this._initializeWKPage();
    return this._pagePromise;
  }

  onPopupCreated(popupPageProxy: WKPageProxy) {
    const wkPage = this._wkPage;
    if (!wkPage || !wkPage._page.listenerCount(Events.Page.Popup))
      return;
    popupPageProxy.page().then(page => wkPage._page.emit(Events.Page.Popup, page));
  }

  private async _initializeWKPage(): Promise<Page> {
    await this._firstTargetPromise;
    let session: WKSession | undefined;
    for (const anySession of this._sessions.values()) {
      if (!(anySession as any)[isPovisionalSymbol]) {
        session = anySession;
        break;
      }
    }
    assert(session, 'One non-provisional target session must exist');
    this._wkPage = new WKPage(this._browserContext, this._pageProxySession);
    this._wkPage.setSession(session!);
    await this._wkPage.initialize();
    return this._wkPage._page;
  }

  private _onTargetCreated(event: Protocol.Target.targetCreatedPayload) {
    const { targetInfo } = event;
    const session = new WKSession(this._pageProxySession.connection, targetInfo.targetId, `The ${targetInfo.type} has been closed.`, (message: any) => {
      this._pageProxySession.send('Target.sendMessageToTarget', {
        message: JSON.stringify(message), targetId: targetInfo.targetId
      }).catch(e => {
        session.dispatchMessage({ id: message.id, error: { message: e.message } });
      });
    });
    assert(targetInfo.type === 'page', 'Only page targets are expected in WebKit, received: ' + targetInfo.type);
    this._sessions.set(targetInfo.targetId, session);
    if (this._firstTargetCallback) {
      this._firstTargetCallback();
      this._firstTargetCallback = undefined;
    }
    if (targetInfo.isProvisional)
      (session as any)[isPovisionalSymbol] = true;
    if (targetInfo.isProvisional && this._wkPage) {
      assert(!this._provisionalPage);
      this._provisionalPage = new WKProvisionalPage(session, this._wkPage);
    }
    if (targetInfo.isPaused)
      this._pageProxySession.send('Target.resume', { targetId: targetInfo.targetId }).catch(debugError);
  }

  private _onTargetDestroyed(event: Protocol.Target.targetDestroyedPayload) {
    const { targetId, crashed } = event;
    const session = this._sessions.get(targetId);
    if (session)
      session.dispose();
    this._sessions.delete(targetId);
    if (this._provisionalPage && this._provisionalPage._session === session) {
      this._provisionalPage.dispose();
      this._provisionalPage = null;
    }
    if (this._wkPage && this._wkPage._session === session && crashed)
      this._wkPage.didClose(crashed);
  }

  private _onDispatchMessageFromTarget(event: Protocol.Target.dispatchMessageFromTargetPayload) {
    const { targetId, message } = event;
    const session = this._sessions.get(targetId);
    assert(session, 'Unknown target: ' + targetId);
    session!.dispatchMessage(JSON.parse(message));
  }

  private _onDidCommitProvisionalTarget(event: Protocol.Target.didCommitProvisionalTargetPayload) {
    const { oldTargetId, newTargetId } = event;
    const newSession = this._sessions.get(newTargetId);
    assert(newSession, 'Unknown new target: ' + newTargetId);
    const oldSession = this._sessions.get(oldTargetId);
    assert(oldSession, 'Unknown old target: ' + oldTargetId);
    // TODO: make some calls like screenshot catch swapped out error and retry.
    oldSession!.errorText = 'Target was swapped out.';
    (newSession as any)[isPovisionalSymbol] = undefined;
    if (this._provisionalPage) {
      this._provisionalPage.commit();
      this._provisionalPage.dispose();
      this._provisionalPage = null;
    }
    if (this._wkPage)
      this._wkPage.setSession(newSession!);
  }
}
