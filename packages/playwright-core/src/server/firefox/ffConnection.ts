/**
 * Copyright 2017 Google Inc. All rights reserved.
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
import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from '../transport';
import type { Protocol } from './protocol';
import { rewriteErrorMessage } from '../../utils/stackTrace';
import type { RecentLogsCollector } from '../../common/debugLogger';
import { debugLogger } from '../../common/debugLogger';
import type { ProtocolLogger } from '../types';
import { helper } from '../helper';
import { ProtocolError } from '../protocolError';
import { kTargetClosedErrorMessage } from '../../common/errors';

export const ConnectionEvents = {
  Disconnected: Symbol('Disconnected'),
};

// FFPlaywright uses this special id to issue Browser.close command which we
// should ignore.
export const kBrowserCloseMessageId = -9999;

export class FFConnection extends EventEmitter {
  private _lastId: number;
  private _transport: ConnectionTransport;
  private readonly _protocolLogger: ProtocolLogger;
  private readonly _browserLogsCollector: RecentLogsCollector;
  _browserDisconnectedLogs: string | undefined;
  readonly rootSession: FFSession;
  readonly _sessions: Map<string, FFSession>;
  _closed: boolean;

  constructor(transport: ConnectionTransport, protocolLogger: ProtocolLogger, browserLogsCollector: RecentLogsCollector) {
    super();
    this.setMaxListeners(0);
    this._transport = transport;
    this._protocolLogger = protocolLogger;
    this._browserLogsCollector = browserLogsCollector;
    this._lastId = 0;
    this._sessions = new Map();
    this._closed = false;
    this.rootSession = new FFSession(this, '', message => this._rawSend(message));
    this._sessions.set('', this.rootSession);

    this._transport.onmessage = this._onMessage.bind(this);
    // onclose should be set last, since it can be immediately called.
    this._transport.onclose = this._onClose.bind(this);
  }

  nextMessageId(): number {
    return ++this._lastId;
  }

  _rawSend(message: ProtocolRequest) {
    this._protocolLogger('send', message);
    this._transport.send(message);
  }

  async _onMessage(message: ProtocolResponse) {
    this._protocolLogger('receive', message);
    if (message.id === kBrowserCloseMessageId)
      return;
    const session = this._sessions.get(message.sessionId || '');
    if (session)
      session.dispatchMessage(message);
  }

  _onClose() {
    this._closed = true;
    this._transport.onmessage = undefined;
    this._transport.onclose = undefined;
    this._browserDisconnectedLogs = helper.formatBrowserLogs(this._browserLogsCollector.recentLogs());
    this.rootSession.dispose();
    Promise.resolve().then(() => this.emit(ConnectionEvents.Disconnected));
  }

  close() {
    if (!this._closed)
      this._transport.close();
  }

  createSession(sessionId: string): FFSession {
    const session = new FFSession(this, sessionId, message => this._rawSend({ ...message, sessionId }));
    this._sessions.set(sessionId, session);
    return session;
  }
}

export class FFSession extends EventEmitter {
  _connection: FFConnection;
  _disposed = false;
  private _callbacks: Map<number, {resolve: Function, reject: Function, error: ProtocolError, method: string}>;
  private _sessionId: string;
  private _rawSend: (message: any) => void;
  private _crashed: boolean = false;
  override on: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  override addListener: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  override off: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  override removeListener: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;
  override once: <T extends keyof Protocol.Events | symbol>(event: T, listener: (payload: T extends symbol ? any : Protocol.Events[T extends keyof Protocol.Events ? T : never]) => void) => this;

  constructor(connection: FFConnection, sessionId: string, rawSend: (message: any) => void) {
    super();
    this.setMaxListeners(0);
    this._callbacks = new Map();
    this._connection = connection;
    this._sessionId = sessionId;
    this._rawSend = rawSend;

    this.on = super.on;
    this.addListener = super.addListener;
    this.off = super.removeListener;
    this.removeListener = super.removeListener;
    this.once = super.once;
  }

  markAsCrashed() {
    this._crashed = true;
  }

  private _closedErrorMessage() {
    if (this._crashed)
      return 'Target crashed';
    if (this._connection._browserDisconnectedLogs)
      return kTargetClosedErrorMessage + '\nBrowser logs: ' + this._connection._browserDisconnectedLogs;
    if (this._disposed || this._connection._closed)
      return kTargetClosedErrorMessage;
  }

  async send<T extends keyof Protocol.CommandParameters>(
    method: T,
    params?: Protocol.CommandParameters[T]
  ): Promise<Protocol.CommandReturnValues[T]> {
    const closedErrorMessage = this._closedErrorMessage();
    if (closedErrorMessage)
      throw new ProtocolError(true, closedErrorMessage);
    const id = this._connection.nextMessageId();
    this._rawSend({ method, params, id });
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error: new ProtocolError(false), method });
    });
  }

  sendMayFail<T extends keyof Protocol.CommandParameters>(method: T, params?: Protocol.CommandParameters[T]): Promise<Protocol.CommandReturnValues[T] | void> {
    return this.send(method, params).catch(error => debugLogger.log('error', error));
  }

  dispatchMessage(object: ProtocolResponse) {
    if (object.id) {
      const callback = this._callbacks.get(object.id);
      // Callbacks could be all rejected if someone has called `.dispose()`.
      if (callback) {
        this._callbacks.delete(object.id);
        if (object.error)
          callback.reject(createProtocolError(callback.error, callback.method, object.error));
        else
          callback.resolve(object.result);
      }
    } else {
      Promise.resolve().then(() => this.emit(object.method!, object.params));
    }
  }

  dispose() {
    this._disposed = true;
    this._connection._sessions.delete(this._sessionId);
    const errorMessage = this._closedErrorMessage()!;
    for (const callback of this._callbacks.values()) {
      callback.error.sessionClosed = true;
      callback.reject(rewriteErrorMessage(callback.error, errorMessage));
    }
    this._callbacks.clear();
  }
}

function createProtocolError(error: ProtocolError, method: string, protocolError: { message: string; data: any; }): ProtocolError {
  let message = `Protocol error (${method}): ${protocolError.message}`;
  if ('data' in protocolError)
    message += ` ${protocolError.data}`;
  return rewriteErrorMessage(error, message);
}
