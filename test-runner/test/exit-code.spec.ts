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
import "../lib"
import { runTest } from "./runTest";

it('should fail', async() => {
  const result = runTest('one-failure.js');
  expect(result.exitCode).toBe(1);
  expect(result.passing).toBe(0);
  expect(result.failing).toBe(1);
});

it('should succeed', async() => {
  const result = runTest('one-success.js');
  expect(result.exitCode).toBe(0);
  expect(result.passing).toBe(1);
  expect(result.failing).toBe(0);
});
