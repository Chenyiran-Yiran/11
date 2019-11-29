/**
 * Copyright 2019 Google Inc. All rights reserved.
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

import {helper, debugError} from '../helper';
import * as js from '../javascript';
import { JugglerSession } from './Connection';

export class ExecutionContextDelegate implements js.ExecutionContextDelegate {
  _session: JugglerSession;
  _executionContextId: string;

  constructor(session: JugglerSession, executionContextId: string) {
    this._session = session;
    this._executionContextId = executionContextId;
  }

  async evaluate(context: js.ExecutionContext, returnByValue: boolean, pageFunction: Function | string, ...args: any[]): Promise<any> {
    if (returnByValue) {
      try {
        const handle = await this.evaluate(context, false /* returnByValue */, pageFunction, ...args as any);
        const result = await handle.jsonValue();
        await handle.dispose();
        return result;
      } catch (e) {
        if (e.message.includes('cyclic object value') || e.message.includes('Object is not serializable'))
          return undefined;
        throw e;
      }
    }

    if (helper.isString(pageFunction)) {
      const payload = await this._session.send('Runtime.evaluate', {
        expression: pageFunction.trim(),
        executionContextId: this._executionContextId,
      }).catch(rewriteError);
      checkException(payload.exceptionDetails);
      return context._createHandle(payload.result);
    }
    if (typeof pageFunction !== 'function')
      throw new Error(`Expected to get |string| or |function| as the first argument, but got "${pageFunction}" instead.`);

    let functionText = pageFunction.toString();
    try {
      new Function('(' + functionText + ')');
    } catch (e1) {
      // This means we might have a function shorthand. Try another
      // time prefixing 'function '.
      if (functionText.startsWith('async '))
        functionText = 'async function ' + functionText.substring('async '.length);
      else
        functionText = 'function ' + functionText;
      try {
        new Function('(' + functionText  + ')');
      } catch (e2) {
        // We tried hard to serialize, but there's a weird beast here.
        throw new Error('Passed function is not well-serializable!');
      }
    }
    const protocolArgs = args.map(arg => {
      if (arg instanceof js.JSHandle) {
        if (arg._context !== context)
          throw new Error('JSHandles can be evaluated only in the context they were created!');
        if (arg._disposed)
          throw new Error('JSHandle is disposed!');
        return this._toCallArgument(arg._remoteObject);
      }
      if (Object.is(arg, Infinity))
        return {unserializableValue: 'Infinity'};
      if (Object.is(arg, -Infinity))
        return {unserializableValue: '-Infinity'};
      if (Object.is(arg, -0))
        return {unserializableValue: '-0'};
      if (Object.is(arg, NaN))
        return {unserializableValue: 'NaN'};
      return {value: arg};
    });
    let callFunctionPromise;
    try {
      callFunctionPromise = this._session.send('Runtime.callFunction', {
        functionDeclaration: functionText,
        args: protocolArgs,
        executionContextId: this._executionContextId
      });
    } catch (err) {
      if (err instanceof TypeError && err.message.startsWith('Converting circular structure to JSON'))
        err.message += ' Are you passing a nested JSHandle?';
      throw err;
    }
    const payload = await callFunctionPromise.catch(rewriteError);
    checkException(payload.exceptionDetails);
    return context._createHandle(payload.result);

    function rewriteError(error) {
      if (error.message.includes('Failed to find execution context with id'))
        throw new Error('Execution context was destroyed, most likely because of a navigation.');
      throw error;
    }
  }

  async getProperties(handle: js.JSHandle): Promise<Map<string, js.JSHandle>> {
    const response = await this._session.send('Runtime.getObjectProperties', {
      executionContextId: this._executionContextId,
      objectId: handle._remoteObject.objectId,
    });
    const result = new Map();
    for (const property of response.properties)
      result.set(property.name, handle.executionContext()._createHandle(property.value));
    return result;
  }

  async releaseHandle(handle: js.JSHandle): Promise<void> {
    await this._session.send('Runtime.disposeObject', {
      executionContextId: this._executionContextId,
      objectId: handle._remoteObject.objectId,
    }).catch(error => {
      // Exceptions might happen in case of a page been navigated or closed.
      // Swallow these since they are harmless and we don't leak anything in this case.
      debugError(error);
    });
  }

  async handleJSONValue(handle: js.JSHandle): Promise<any> {
    const payload = handle._remoteObject;
    if (!payload.objectId)
      return deserializeValue(payload);
    const simpleValue = await this._session.send('Runtime.callFunction', {
      executionContextId: this._executionContextId,
      returnByValue: true,
      functionDeclaration: (e => e).toString(),
      args: [this._toCallArgument(payload)],
    });
    return deserializeValue(simpleValue.result);
  }

  handleToString(handle: js.JSHandle, includeType: boolean): string {
    const payload = handle._remoteObject;
    if (payload.objectId)
      return 'JSHandle@' + (payload.subtype || payload.type);
    return (includeType ? 'JSHandle:' : '') + deserializeValue(payload);
  }

  private _toCallArgument(payload: any): any {
    return { value: payload.value, unserializableValue: payload.unserializableValue, objectId: payload.objectId };
  }
}

function checkException(exceptionDetails?: any) {
  if (exceptionDetails) {
    if (exceptionDetails.value)
      throw new Error('Evaluation failed: ' + JSON.stringify(exceptionDetails.value));
    else
      throw new Error('Evaluation failed: ' + exceptionDetails.text + '\n' + exceptionDetails.stack);
  }
}

export function deserializeValue({unserializableValue, value}) {
  if (unserializableValue === 'Infinity')
    return Infinity;
  if (unserializableValue === '-Infinity')
    return -Infinity;
  if (unserializableValue === '-0')
    return -0;
  if (unserializableValue === 'NaN')
    return NaN;
  return value;
}
