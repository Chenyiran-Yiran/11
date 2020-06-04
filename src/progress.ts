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

import { InnerLogger, Log } from './logger';
import { TimeoutError } from './errors';
import { helper, assert } from './helper';
import * as types from './types';
import { DEFAULT_TIMEOUT, TimeoutSettings } from './timeoutSettings';
import { getCurrentApiCall, rewriteErrorMessage } from './debug/stackTrace';

export interface Progress {
  readonly apiName: string;
  readonly deadline: number;  // To be removed?
  readonly aborted: Promise<void>;
  isRunning(): boolean;
  cleanupWhenAborted(cleanup: () => any): void;
  log(log: Log, message: string | Error): void;
}

export async function runAbortableTask<T>(task: (progress: Progress) => Promise<T>, timeoutOptions: types.TimeoutOptions, logger: InnerLogger, timeoutSettingsOrDefaultTimeout?: TimeoutSettings | number, apiName?: string): Promise<T> {
  const controller = new ProgressController(timeoutOptions, logger, timeoutSettingsOrDefaultTimeout, apiName);
  return controller.run(task);
}

export class ProgressController {
  // Promise and callback that forcefully abort the progress.
  // This promise always rejects.
  private _forceAbort: (error: Error) => void = () => {};
  private _forceAbortPromise: Promise<any>;

  // Promise and callback that resolve once the progress is aborted.
  // This includes the force abort and also rejection of the task itself (failure).
  private _aborted = () => {};
  private _abortedPromise: Promise<void>;

  // Cleanups to be run only in the case of abort.
  private _cleanups: (() => any)[] = [];

  private _logger: InnerLogger;
  private _logRecording: string[] = [];
  private _state: 'before' | 'running' | 'aborted' | 'finished' = 'before';
  private _apiName: string;
  private _deadline: number;
  private _timeout: number;

  constructor(timeoutOptions: types.TimeoutOptions, logger: InnerLogger, timeoutSettingsOrDefaultTimeout?: TimeoutSettings | number, apiName?: string) {
    this._apiName = apiName || getCurrentApiCall();
    this._logger = logger;

    // TODO: figure out nice timeout parameters.
    let defaultTimeout = DEFAULT_TIMEOUT;
    if (typeof timeoutSettingsOrDefaultTimeout === 'number')
      defaultTimeout = timeoutSettingsOrDefaultTimeout;
    if (timeoutSettingsOrDefaultTimeout instanceof TimeoutSettings)
      defaultTimeout = timeoutSettingsOrDefaultTimeout.timeout();
    const { timeout = defaultTimeout } = timeoutOptions;
    this._timeout = timeout;
    this._deadline = TimeoutSettings.computeDeadline(timeout);

    this._forceAbortPromise = new Promise((resolve, reject) => this._forceAbort = reject);
    this._forceAbortPromise.catch(e => null);  // Prevent unhandle promsie rejection.
    this._abortedPromise = new Promise(resolve => this._aborted = resolve);
  }

  async run<T>(task: (progress: Progress) => Promise<T>): Promise<T> {
    assert(this._state === 'before');
    this._state = 'running';

    const progress: Progress = {
      apiName: this._apiName,
      deadline: this._deadline,
      aborted: this._abortedPromise,
      isRunning: () => this._state === 'running',
      cleanupWhenAborted: (cleanup: () => any) => {
        if (this._state === 'running')
          this._cleanups.push(cleanup);
        else
          runCleanup(cleanup);
      },
      log: (log: Log, message: string | Error) => {
        if (this._state === 'running')
          this._logRecording.push(message.toString());
        this._logger._log(log, message);
      },
    };

    const timeoutError = new TimeoutError(`Timeout ${this._timeout}ms exceeded during ${this._apiName}.`);
    const timer = setTimeout(() => this._forceAbort(timeoutError), helper.timeUntilDeadline(this._deadline));
    try {
      const promise = task(progress);
      const result = await Promise.race([promise, this._forceAbortPromise]);
      clearTimeout(timer);
      this._state = 'finished';
      this._logRecording = [];
      return result;
    } catch (e) {
      this._aborted();
      rewriteErrorMessage(e, e.message + formatLogRecording(this._logRecording, this._apiName));
      clearTimeout(timer);
      this._state = 'aborted';
      this._logRecording = [];
      await Promise.all(this._cleanups.splice(0).map(cleanup => runCleanup(cleanup)));
      throw e;
    }
  }

  abort(error: Error) {
    this._forceAbort(error);
  }
}

async function runCleanup(cleanup: () => any) {
  try {
    await cleanup();
  } catch (e) {
  }
}

function formatLogRecording(log: string[], name: string): string {
  if (!log.length)
    return '';
  name = ` ${name} logs `;
  const headerLength = 60;
  const leftLength = (headerLength - name.length) / 2;
  const rightLength = headerLength - name.length - leftLength;
  return `\n${'='.repeat(leftLength)}${name}${'='.repeat(rightLength)}\n${log.join('\n')}\n${'='.repeat(headerLength)}`;
}
