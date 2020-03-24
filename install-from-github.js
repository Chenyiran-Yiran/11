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

 // This file is only run when someone installs via the github repo

const {execSync} = require('child_process');

try {
  console.log('Building playwright...');
  execSync('npm run build', {
    stdio: 'ignore'
  });
} catch (e) {
}

const path = require('path');
const fs = require('fs');
const util = require('util');
const rmAsync = util.promisify(require('rimraf'));
const existsAsync = path => fs.promises.access(path).then(() => true, e => false);
const {downloadBrowserWithProgressBar, localDownloadOptions} = require('./download-browser');
const protocolGenerator = require('./utils/protocol-types-generator');

(async function() {
  const chromiumOptions = localDownloadOptions('chromium');
  const firefoxOptions = localDownloadOptions('firefox');
  const webkitOptions = localDownloadOptions('webkit');
  if (!(await existsAsync(chromiumOptions.downloadPath))) {
    await downloadBrowserWithProgressBar(chromiumOptions);
    await protocolGenerator.generateChromiumProtocol(chromiumOptions.executablePath).catch(console.warn);
  }
  if (!(await existsAsync(firefoxOptions.downloadPath))) {
    await downloadBrowserWithProgressBar(firefoxOptions);
    await protocolGenerator.generateFirefoxProtocol(firefoxOptions.executablePath).catch(console.warn);
  }
  if (!(await existsAsync(webkitOptions.downloadPath))) {
    await downloadBrowserWithProgressBar(webkitOptions);
    await protocolGenerator.generateWebKitProtocol(webkitOptions.downloadPath).catch(console.warn);
  }

  // Cleanup stale revisions.
  const directories = new Set(await readdirAsync(path.join(__dirname, '.local-browsers')));
  directories.delete(chromiumOptions.downloadPath);
  directories.delete(firefoxOptions.downloadPath);
  directories.delete(webkitOptions.downloadPath);
  // cleanup old browser directories.
  directories.add(path.join(__dirname, '.local-chromium'));
  directories.add(path.join(__dirname, '.local-firefox'));
  directories.add(path.join(__dirname, '.local-webkit'));
  await Promise.all([...directories].map(directory => rmAsync(directory)));

  try {
    console.log('Generating types...');
    execSync('npm run generate-types');
  } catch (e) {
  }

  async function readdirAsync(dirpath) {
    return fs.promises.readdir(dirpath).then(dirs => dirs.map(dir => path.join(dirpath, dir)));
  }
})();
