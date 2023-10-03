/**
 * Copyright Microsoft Corporation. All rights reserved.
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

import type { TestResult } from '../../types/testReporter';
import type { FullConfigInternal } from '../common/config';
import type { Suite, TestCase } from '../common/test';

export class FailureTracker {
  private _totalTestCount = 0;
  private _failureCount = 0;
  private _hasWorkerErrors = false;
  private _rootSuite: Suite | undefined;

  constructor(private _config: FullConfigInternal) {
  }

  onRootSuite(rootSuite: Suite) {
    this._rootSuite = rootSuite;
    this._totalTestCount = this._rootSuite.allTests().length;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== 'skipped' && result.status !== test.expectedStatus)
      ++this._failureCount;
  }

  onWorkerError() {
    this._hasWorkerErrors = true;
  }

  hasReachedMaxFailures() {
    let maxFailures = this._config.config.maxFailures;
    maxFailures = Number.isInteger(maxFailures) ? maxFailures : Math.ceil(maxFailures * this._totalTestCount);

    return maxFailures > 0 && this._failureCount >= maxFailures;
  }

  hasWorkerErrors() {
    return this._hasWorkerErrors;
  }

  result(): 'failed' | 'passed' {
    return this._hasWorkerErrors || this._rootSuite?.allTests().some(test => !test.ok()) ? 'failed' : 'passed';
  }
}
