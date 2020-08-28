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

import { options } from './playwright.fixtures';

function crash(pageImpl, browserName) {
  if (browserName === 'chromium')
    pageImpl.mainFrame().goto('chrome://crash').catch(e => {});
  else if (browserName === 'webkit')
    pageImpl._delegate._session.send('Page.crash', {}).catch(e => {});
  else if (browserName === 'firefox')
    pageImpl._delegate._session.send('Page.crash', {}).catch(e => {});
}

it.fail(options.WIRE)('should emit crash event when page crashes', async ({page, browserName, toImpl}) => {
  await page.setContent(`<div>This page should crash</div>`);
  crash(toImpl(page), browserName);
  await new Promise(f => page.on('crash', f));
});

it.fail(options.WIRE).flaky(options.FIREFOX && WIN)('should throw on any action after page crashes', async ({page, browserName, toImpl}) => {
  await page.setContent(`<div>This page should crash</div>`);
  crash(toImpl(page), browserName);
  await page.waitForEvent('crash');
  const err = await page.evaluate(() => {}).then(() => null, e => e);
  expect(err).toBeTruthy();
  expect(err.message).toContain('crash');
});

it.fail(options.WIRE)('should cancel waitForEvent when page crashes', async ({page, browserName, toImpl}) => {
  await page.setContent(`<div>This page should crash</div>`);
  const promise = page.waitForEvent('response').catch(e => e);
  crash(toImpl(page), browserName);
  const error = await promise;
  expect(error.message).toContain('Page crashed');
});

it.fixme(options.WIRE)('should cancel navigation when page crashes', async ({page, browserName, toImpl, server}) => {
  await page.setContent(`<div>This page should crash</div>`);
  server.setRoute('/one-style.css', () => {});
  const promise = page.goto(server.PREFIX + '/one-style.html').catch(e => e);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  crash(toImpl(page), browserName);
  const error = await promise;
  expect(error.message).toContain('Navigation failed because page crashed');
});

it.fixme(options.WIRE).flaky(options.FIREFOX && WIN)('should be able to close context when page crashes', async ({page, browserName, toImpl}) => {
  await page.setContent(`<div>This page should crash</div>`);
  crash(toImpl(page), browserName);
  await page.waitForEvent('crash');
  await page.context().close();
});
