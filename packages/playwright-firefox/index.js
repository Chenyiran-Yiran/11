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
const path = require('path');
const {Playwright} = require('playwright-core/lib/server/playwright.js');

const playwright = new Playwright({
  browsers: ['firefox'],
});
module.exports = playwright;

try {
  const downloadedBrowsers = require(path.join(__dirname, '.downloaded-browsers.json'));
  playwright.firefox._executablePath = downloadedBrowsers.ffExecutablePath;
} catch (e) {
  throw new Error('playwright-firefox has not downloaded Firefox.');
}

