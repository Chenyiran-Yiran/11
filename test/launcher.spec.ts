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

import { it, expect } from './fixtures';

it('should require top-level Errors', async ({}) => {
  const Errors = require('../lib/utils/errors.js');
  expect(String(Errors.TimeoutError)).toContain('TimeoutError');
});

it('should require top-level DeviceDescriptors', async ({playwright}) => {
  const Devices = require('../lib/server/deviceDescriptors.js');
  expect(Devices['iPhone 6']).toBeTruthy();
  expect(Devices['iPhone 6']).toEqual(playwright.devices['iPhone 6']);
});
