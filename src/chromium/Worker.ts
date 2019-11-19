/**
 * Copyright 2018 Google Inc. All rights reserved.
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
import { CDPSession } from './Connection';
import { ExecutionContext } from './ExecutionContext';
import { debugError } from '../helper';
import { JSHandle } from './JSHandle';
import { Protocol } from './protocol';

export class Worker extends EventEmitter {
  private _client: CDPSession;
  private _url: string;
  private _executionContextPromise: Promise<ExecutionContext>;
  private _executionContextCallback: (value?: ExecutionContext) => void;

  constructor(client: CDPSession, url: string, consoleAPICalled: (arg0: string, arg1: JSHandle[], arg2: Protocol.Runtime.StackTrace | undefined) => void, exceptionThrown: (arg0: Protocol.Runtime.ExceptionDetails) => void) {
    super();
    this._client = client;
    this._url = url;
    this._executionContextPromise = new Promise(x => this._executionContextCallback = x);
    let jsHandleFactory: (o: Protocol.Runtime.RemoteObject) => JSHandle;
    this._client.once('Runtime.executionContextCreated', async event => {
      jsHandleFactory = remoteObject => new JSHandle(executionContext, client, remoteObject);
      const executionContext = new ExecutionContext(client, event.context, null);
      this._executionContextCallback(executionContext);
    });
    // This might fail if the target is closed before we recieve all execution contexts.
    this._client.send('Runtime.enable', {}).catch(debugError);

    this._client.on('Runtime.consoleAPICalled', event => consoleAPICalled(event.type, event.args.map(jsHandleFactory), event.stackTrace));
    this._client.on('Runtime.exceptionThrown', exception => exceptionThrown(exception.exceptionDetails));
  }

  url(): string {
    return this._url;
  }

  async executionContext(): Promise<ExecutionContext> {
    return this._executionContextPromise;
  }

  async evaluate(pageFunction: Function | string, ...args: any[]): Promise<any> {
    return (await this._executionContextPromise).evaluate(pageFunction, ...args);
  }

  async evaluateHandle(pageFunction: Function | string, ...args: any[]): Promise<JSHandle> {
    return (await this._executionContextPromise).evaluateHandle(pageFunction, ...args);
  }
}
