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

import { execSync } from 'child_process';
import * as extract from 'extract-zip';
import * as fs from 'fs';
import * as ProxyAgent from 'https-proxy-agent';
import * as os from 'os';
import * as path from 'path';
import * as ProgressBar from 'progress';
import { getProxyForUrl } from 'proxy-from-env';
import * as URL from 'url';
import * as util from 'util';
import { assert, logPolitely } from '../helper';

const unlinkAsync = util.promisify(fs.unlink.bind(fs));
const chmodAsync = util.promisify(fs.chmod.bind(fs));
const existsAsync = (path: string): Promise<boolean> => new Promise(resolve => fs.stat(path, err => resolve(!err)));

export type OnProgressCallback = (downloadedBytes: number, totalBytes: number) => void;
export type BrowserName = ('chromium'|'webkit'|'firefox');
export type BrowserPlatform = ('win32'|'win64'|'mac10.13'|'mac10.14'|'mac10.15'|'linux');

const DEFAULT_DOWNLOAD_HOSTS = {
  chromium: 'https://storage.googleapis.com',
  firefox: 'https://playwright.azureedge.net',
  webkit: 'https://playwright.azureedge.net',
};

const hostPlatform = ((): BrowserPlatform => {
  const platform = os.platform();
  if (platform === 'darwin') {
    const macVersion = execSync('sw_vers -productVersion').toString('utf8').trim().split('.').slice(0, 2).join('.');
    return `mac${macVersion}` as BrowserPlatform;
  }
  if (platform === 'linux')
    return 'linux';
  if (platform === 'win32')
    return os.arch() === 'x64' ? 'win64' : 'win32';
  return platform as BrowserPlatform;
})();

function getDownloadUrl(browserName: BrowserName, platform?: BrowserPlatform): string | undefined {
  platform = platform || hostPlatform;
  if (browserName === 'chromium') {
    return new Map<BrowserPlatform, string>([
      ['linux', '%s/chromium-browser-snapshots/Linux_x64/%d/chrome-linux.zip'],
      ['mac10.13', '%s/chromium-browser-snapshots/Mac/%d/chrome-mac.zip'],
      ['mac10.14', '%s/chromium-browser-snapshots/Mac/%d/chrome-mac.zip'],
      ['mac10.15', '%s/chromium-browser-snapshots/Mac/%d/chrome-mac.zip'],
      ['win32', '%s/chromium-browser-snapshots/Win/%d/chrome-win.zip'],
      ['win64', '%s/chromium-browser-snapshots/Win_x64/%d/chrome-win.zip'],
    ]).get(platform);
  }

  if (browserName === 'firefox') {
    return new Map<BrowserPlatform, string>([
      ['linux', '%s/builds/firefox/%s/firefox-linux.zip'],
      ['mac10.13', '%s/builds/firefox/%s/firefox-mac.zip'],
      ['mac10.14', '%s/builds/firefox/%s/firefox-mac.zip'],
      ['mac10.15', '%s/builds/firefox/%s/firefox-mac.zip'],
      ['win32', '%s/builds/firefox/%s/firefox-win32.zip'],
      ['win64', '%s/builds/firefox/%s/firefox-win64.zip'],
    ]).get(platform);
  }

  if (browserName === 'webkit') {
    return new Map<BrowserPlatform, string | undefined>([
      ['linux', '%s/builds/webkit/%s/minibrowser-gtk-wpe.zip'],
      ['mac10.13', undefined],
      ['mac10.14', '%s/builds/webkit/%s/minibrowser-mac-10.14.zip'],
      ['mac10.15', '%s/builds/webkit/%s/minibrowser-mac-10.15.zip'],
      ['win32', '%s/builds/webkit/%s/minibrowser-win64.zip'],
      ['win64', '%s/builds/webkit/%s/minibrowser-win64.zip'],
    ]).get(platform);
  }
}

function getRelativeExecutablePath(browserName: BrowserName): string[] | undefined {
  if (browserName === 'chromium') {
    return new Map<BrowserPlatform, string[]>([
      ['linux', ['chrome-linux', 'chrome']],
      ['mac10.13', ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']],
      ['mac10.14', ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']],
      ['mac10.15', ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']],
      ['win32', ['chrome-win', 'chrome.exe']],
      ['win64', ['chrome-win', 'chrome.exe']],
    ]).get(hostPlatform);
  }

  if (browserName === 'firefox') {
    return new Map<BrowserPlatform, string[]>([
      ['linux', ['firefox', 'firefox']],
      ['mac10.13', ['firefox', 'Nightly.app', 'Contents', 'MacOS', 'firefox']],
      ['mac10.14', ['firefox', 'Nightly.app', 'Contents', 'MacOS', 'firefox']],
      ['mac10.15', ['firefox', 'Nightly.app', 'Contents', 'MacOS', 'firefox']],
      ['win32', ['firefox', 'firefox.exe']],
      ['win64', ['firefox', 'firefox.exe']],
    ]).get(hostPlatform);
  }

  if (browserName === 'webkit') {
    return new Map<BrowserPlatform, string[] | undefined>([
      ['linux', ['pw_run.sh']],
      ['mac10.13', undefined],
      ['mac10.14', ['pw_run.sh']],
      ['mac10.15', ['pw_run.sh']],
      ['win32', ['Playwright.exe']],
      ['win64', ['Playwright.exe']],
    ]).get(hostPlatform);
  }
}

export type DownloadOptions = {
  baseDir: string,
  browserName: BrowserName,
  browserRevision: string,
  serverHost?: string,
};

function revisionURL(options: DownloadOptions, platform?: BrowserPlatform): string {
  const {
    browserName,
    browserRevision,
    serverHost = DEFAULT_DOWNLOAD_HOSTS[browserName],
  } = options;
  assert(browserRevision, `'revision' must be specified`);
  const urlTemplate = getDownloadUrl(browserName, platform);
  assert(urlTemplate, `ERROR: Playwright does not support ${browserName} on ${hostPlatform}`);
  return util.format(urlTemplate, serverHost, browserRevision);
}

export function targetDirectory(baseDir: string, browserName: string, browserRevision: string): string {
  return path.join(baseDir, `${browserName}-${browserRevision}`);
}

export function executablePath(baseDir: string, browserName: BrowserName, browserRevision: string): string {
  const relativePath = getRelativeExecutablePath(browserName);
  assert(relativePath, `Unsupported platform for ${browserName}: ${hostPlatform}`);
  return path.join(targetDirectory(baseDir, browserName, browserRevision), ...relativePath);
}

export async function downloadBrowserWithProgressBar(options: DownloadOptions): Promise<boolean> {
  const {
    baseDir,
    browserName,
    browserRevision,
  } = options;
  const progressBarName = `${browserName} v${browserRevision}`;
  assert(baseDir, '`baseDir` must be provided');
  const targetDir = targetDirectory(baseDir, browserName, browserRevision);
  if (await existsAsync(targetDir)) {
    // Already downloaded.
    return false;
  }

  let progressBar: ProgressBar;
  let lastDownloadedBytes = 0;

  function progress(downloadedBytes: number, totalBytes: number) {
    if (!progressBar) {
      progressBar = new ProgressBar(`Downloading ${progressBarName} - ${toMegabytes(totalBytes)} [:bar] :percent :etas `, {
        complete: '=',
        incomplete: ' ',
        width: 20,
        total: totalBytes,
      });
    }
    const delta = downloadedBytes - lastDownloadedBytes;
    lastDownloadedBytes = downloadedBytes;
    progressBar.tick(delta);
  }

  const url = revisionURL(options);
  const zipPath = path.join(os.tmpdir(), `playwright-download-${browserName}-${hostPlatform}-${browserRevision}.zip`);
  try {
    await downloadFile(url, zipPath, progress);
    await extract(zipPath, {dir: targetDir});
    await chmodAsync(executablePath(baseDir, browserName, browserRevision), 0o755);
  } catch (e) {
    process.exitCode = 1;
    throw e;
  } finally {
    if (await existsAsync(zipPath))
      await unlinkAsync(zipPath);
  }
  logPolitely(`${progressBarName} downloaded to ${targetDir}`);
  return true;
}

function toMegabytes(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return `${Math.round(mb * 10) / 10} Mb`;
}

export async function canDownload(browserName: BrowserName, browserRevision: string, platform: BrowserPlatform): Promise<boolean> {
  const url = revisionURL({
    baseDir: '',
    browserName,
    browserRevision
  }, platform);
  let resolve: (result: boolean) => void = () => {};
  const promise = new Promise<boolean>(x => resolve = x);
  const request = httpRequest(url, 'HEAD', response => {
    resolve(response.statusCode === 200);
  });
  request.on('error', (error: any) => {
    console.error(error);  // eslint-disable-line no-console
    resolve(false);
  });
  return promise;
}

function downloadFile(url: string, destinationPath: string, progressCallback: OnProgressCallback | undefined): Promise<any> {
  let fulfill: () => void = () => {};
  let reject: (error: any) => void = () => {};
  let downloadedBytes = 0;
  let totalBytes = 0;

  const promise = new Promise((x, y) => { fulfill = x; reject = y; });

  const request = httpRequest(url, 'GET', response => {
    if (response.statusCode !== 200) {
      const error = new Error(`Download failed: server returned code ${response.statusCode}. URL: ${url}`);
      // consume response data to free up memory
      response.resume();
      reject(error);
      return;
    }
    const file = fs.createWriteStream(destinationPath);
    file.on('finish', () => fulfill());
    file.on('error', error => reject(error));
    response.pipe(file);
    totalBytes = parseInt(response.headers['content-length'], 10);
    if (progressCallback)
      response.on('data', onData);
  });
  request.on('error', (error: any) => reject(error));
  return promise;

  function onData(chunk: string) {
    downloadedBytes += chunk.length;
    progressCallback!(downloadedBytes, totalBytes);
  }
}

function httpRequest(url: string, method: string, response: (r: any) => void) {
  let options: any = URL.parse(url);
  options.method = method;

  const proxyURL = getProxyForUrl(url);
  if (proxyURL) {
    if (url.startsWith('http:')) {
      const proxy = URL.parse(proxyURL);
      options = {
        path: options.href,
        host: proxy.hostname,
        port: proxy.port,
      };
    } else {
      const parsedProxyURL: any = URL.parse(proxyURL);
      parsedProxyURL.secureProxy = parsedProxyURL.protocol === 'https:';

      options.agent = new ProxyAgent(parsedProxyURL);
      options.rejectUnauthorized = false;
    }
  }

  const requestCallback = (res: any) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
      httpRequest(res.headers.location, method, response);
    else
      response(res);
  };
  const request = options.protocol === 'https:' ?
    require('https').request(options, requestCallback) :
    require('http').request(options, requestCallback);
  request.end();
  return request;
}
