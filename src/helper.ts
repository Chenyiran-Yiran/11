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

import * as debug from 'debug';
import * as types from './types';
import { TimeoutError } from './errors';

export const debugError = debug(`playwright:error`);

export type RegisteredListener = {
  emitter: NodeJS.EventEmitter;
  eventName: (string | symbol);
  handler: (...args: any[]) => void;
};

class Helper {
  static evaluationString(fun: Function | string, ...args: any[]): string {
    if (Helper.isString(fun)) {
      assert(args.length === 0, 'Cannot evaluate a string with arguments');
      return fun as string;
    }
    return `(${fun})(${args.map(serializeArgument).join(',')})`;

    function serializeArgument(arg: any): string {
      if (Object.is(arg, undefined))
        return 'undefined';
      return JSON.stringify(arg);
    }
  }

  static installAsyncStackHooks(classType: any) {
    for (const methodName of Reflect.ownKeys(classType.prototype)) {
      const method = Reflect.get(classType.prototype, methodName);
      if (methodName === 'constructor' || typeof methodName !== 'string' || methodName.startsWith('_') || typeof method !== 'function' || method.constructor.name !== 'AsyncFunction')
        continue;
      Reflect.set(classType.prototype, methodName, function(...args: any[]) {
        const syncStack: any = {};
        Error.captureStackTrace(syncStack);
        return method.call(this, ...args).catch(e => {
          const stack = syncStack.stack.substring(syncStack.stack.indexOf('\n') + 1);
          const clientStack = stack.substring(stack.indexOf('\n'));
          if (e instanceof Error && e.stack && !e.stack.includes(clientStack))
            e.stack += '\n  -- ASYNC --\n' + stack;
          throw e;
        });
      });
    }
  }

  static addEventListener(
    emitter: NodeJS.EventEmitter,
    eventName: (string | symbol),
    handler: (...args: any[]) => void): RegisteredListener {
    emitter.on(eventName, handler);
    return { emitter, eventName, handler };
  }

  static removeEventListeners(listeners: Array<{
      emitter: NodeJS.EventEmitter;
      eventName: (string | symbol);
      handler: (...args: any[]) => void;
    }>) {
    for (const listener of listeners)
      listener.emitter.removeListener(listener.eventName, listener.handler);
    listeners.splice(0, listeners.length);
  }

  static isString(obj: any): obj is string {
    return typeof obj === 'string' || obj instanceof String;
  }

  static isNumber(obj: any): obj is number {
    return typeof obj === 'number' || obj instanceof Number;
  }

  static promisify(nodeFunction: Function): Function {
    function promisified(...args) {
      return new Promise((resolve, reject) => {
        function callback(err, ...result) {
          if (err)
            return reject(err);
          if (result.length === 1)
            return resolve(result[0]);
          return resolve(result);
        }
        nodeFunction.call(null, ...args, callback);
      });
    }
    return promisified;
  }

  static async waitForEvent(
    emitter: NodeJS.EventEmitter,
    eventName: (string | symbol),
    predicate: Function,
    timeout: number,
    abortPromise: Promise<Error>): Promise<any> {
    let eventTimeout, resolveCallback, rejectCallback;
    const promise = new Promise((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    const listener = Helper.addEventListener(emitter, eventName, event => {
      if (!predicate(event))
        return;
      resolveCallback(event);
    });
    if (timeout) {
      eventTimeout = setTimeout(() => {
        rejectCallback(new TimeoutError('Timeout exceeded while waiting for event'));
      }, timeout);
    }
    function cleanup() {
      Helper.removeEventListeners([listener]);
      clearTimeout(eventTimeout);
    }
    const result = await Promise.race([promise, abortPromise]).then(r => {
      cleanup();
      return r;
    }, e => {
      cleanup();
      throw e;
    });
    if (result instanceof Error)
      throw result;
    return result;
  }

  static async waitWithTimeout<T>(promise: Promise<T>, taskName: string, timeout: number): Promise<T> {
    let reject: (error: Error) => void;
    const timeoutError = new TimeoutError(`waiting for ${taskName} failed: timeout ${timeout}ms exceeded`);
    const timeoutPromise = new Promise<T>((resolve, x) => reject = x);
    let timeoutTimer = null;
    if (timeout)
      timeoutTimer = setTimeout(() => reject(timeoutError), timeout);
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutTimer)
        clearTimeout(timeoutTimer);
    }
  }

  static selectorToString(selector: string | types.Selector): string {
    if (typeof selector === 'string')
      return selector;
    return `${selector.visible ? '[visible] ' : selector.visible === false ? '[hidden] ' : ''}${selector.selector}`;
  }

  // Ensures that we don't use accidental properties in selector, e.g. scope.
  static clearSelector(selector: string | types.Selector): string | types.Selector {
    if (helper.isString(selector))
      return selector;
    return { selector: selector.selector, visible: selector.visible };
  }
}

export function assert(value: any, message?: string) {
  if (!value)
    throw new Error(message);
}

export const helper = Helper;
