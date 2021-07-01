/**
 * Copyright 2020 Microsoft Corporation. All rights reserved.
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

import { browserTest as test, expect } from './config/browserTest';

test('should create new page', async function({browser}) {
  const page1 = await browser.newPage();
  expect(browser.contexts().length).toBe(1);

  const page2 = await browser.newPage();
  expect(browser.contexts().length).toBe(2);

  await page1.close();
  expect(browser.contexts().length).toBe(1);

  await page2.close();
  expect(browser.contexts().length).toBe(0);
});

test('should throw upon second create new page', async function({browser}) {
  const page = await browser.newPage();
  let error;
  await page.context().newPage().catch(e => error = e);
  await page.close();
  expect(error.message).toContain('Please use browser.newContext()');
});

test('version should work', async function({browser, browserName}) {
  const version = browser.version();
  if (browserName === 'chromium')
    expect(version.match(/^\d+\.\d+\.\d+\.\d+$/)).toBeTruthy();
  else
    expect(version.match(/^\d+\.\d+/)).toBeTruthy();
});

test('should fail when exceeding browser timeout', async function({ browser, server, browserName, playwright }) {
  // Hang for request to the empty.html
  server.setRoute('/empty.html', (req, res) => { });
  const page = await browser.newPage();
  let error = null;
  browser.setDefaultTimeout(2);
  await page.goto(server.PREFIX + '/empty.html').catch(e => error = e);
  expect(error.message).toContain('page.goto: Timeout 2ms exceeded.');
  expect(error.message).toContain(server.PREFIX + '/empty.html');
  expect(error).toBeInstanceOf(playwright.errors.TimeoutError);
  const version = browser.version();
  if (browserName === 'chromium')
    expect(version.match(/^\d+\.\d+\.\d+\.\d+$/)).toBeTruthy();
  else
    expect(version.match(/^\d+\.\d+/)).toBeTruthy();
});
