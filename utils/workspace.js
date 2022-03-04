#!/usr/bin/env node
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
// @ts-check

/**
 * Use the following command to typescheck this file:
 * npx tsc --target es2020  --watch --checkjs --noemit --moduleResolution node workspace.js
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const url = require('url');

const readJSON = async (filePath) => JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
const writeJSON = async (filePath, json) => {
  await fs.promises.writeFile(filePath, JSON.stringify(json, null, 2) + '\n');
}

class PWPackage {
  constructor(descriptor) {
    this.name = descriptor.name;
    this.path = descriptor.path;
    this.files = descriptor.files;
    this.packageJSONPath = path.join(this.path, 'package.json');
    this.packageJSON = JSON.parse(fs.readFileSync(this.packageJSONPath, 'utf8'));
    this.isPrivate = !!this.packageJSON.private;
  }
}

class Workspace {
  /**
   * @param {string} rootDir
   * @param {PWPackage[]} packages
   */
  constructor(rootDir, packages) {
    this._rootDir = rootDir;
    this._packages = packages;
  }

  /**
   * @returns {PWPackage[]}
   */
  packages() {
    return this._packages;
  }

  /**
   * @param {string} version
   */
  async setVersion(version) {
    if (version.startsWith('v'))
      throw new Error('version must not start with "v"');

    // 1. update workspace's package.json (playwright-internal) with the new version
    const workspacePackageJSON = await readJSON(path.join(this._rootDir, 'package.json'));
    workspacePackageJSON.version = version;
    await writeJSON(path.join(this._rootDir, 'package.json'), workspacePackageJSON);
    // 2. make workspace consistent.
    await this.ensureConsistent();
  }

  async ensureConsistent() {
    let hasChanges = false;

    const maybeWriteJSON = async (jsonPath, json) => {
      const oldJson = await readJSON(jsonPath);
      if (JSON.stringify(json) === JSON.stringify(oldJson))
        return;
      hasChanges = true;
      console.warn('Updated', jsonPath);
      await writeJSON(jsonPath, json);
    };

    const workspacePackageJSON = await readJSON(path.join(this._rootDir, 'package.json'));
    const packageLockPath = path.join(this._rootDir, 'package-lock.json');
    const packageLock = JSON.parse(await fs.promises.readFile(packageLockPath, 'utf8'));
    const version = workspacePackageJSON.version;

    // Make sure package-lock version is consistent with root package.json version.
    packageLock.version = version;
    packageLock.packages[""].version = version;

    for (const pkg of this._packages) {
      // 1. Copy package files.
      for (const file of pkg.files) {
        const fromPath = path.join(this._rootDir, file);
        const toPath = path.join(pkg.path, file);
        await fs.promises.mkdir(path.dirname(pkg.path), { recursive: true });
        await fs.promises.copyFile(fromPath, toPath);
      }

      // 2. Make sure package-lock and package's package.json are consistent.
      //    All manual package-lock management is a workaround for
      //    https://github.com/npm/cli/issues/3940
      const pkgLockEntry = packageLock['packages']['packages/' + path.basename(pkg.path)];
      const depLockEntry = packageLock['dependencies'][pkg.name];
      if (!pkg.isPrivate) {
        pkgLockEntry.version = version;
        pkg.packageJSON.version = version;
        pkg.packageJSON.repository = workspacePackageJSON.repository;
        pkg.packageJSON.engines = workspacePackageJSON.engines;
        pkg.packageJSON.homepage = workspacePackageJSON.homepage;
        pkg.packageJSON.author = workspacePackageJSON.author;
        pkg.packageJSON.license = workspacePackageJSON.license;
      }
      for (const otherPackage of this._packages) {
        if (pkgLockEntry.dependencies && pkgLockEntry.dependencies[otherPackage.name])
          pkgLockEntry.dependencies[otherPackage.name] = version;
        if (depLockEntry.requires && depLockEntry.requires[otherPackage.name])
          depLockEntry.requires[otherPackage.name] = version;
        if (pkg.packageJSON.dependencies && pkg.packageJSON.dependencies[otherPackage.name])
          pkg.packageJSON.dependencies[otherPackage.name] = version;
      }
      await maybeWriteJSON(pkg.packageJSONPath, pkg.packageJSON);
    }
    await maybeWriteJSON(packageLockPath, packageLock);
    return hasChanges;
  }
}

const ROOT_PATH = path.join(__dirname, '..');
const LICENCE_FILES = ['NOTICE', 'LICENSE'];
const workspace = new Workspace(ROOT_PATH, [
  new PWPackage({
    name: 'playwright',
    path: path.join(ROOT_PATH, 'packages', 'playwright'),
    // We copy README.md additionally for Playwright so that it looks nice on NPM.
    files: [...LICENCE_FILES, 'README.md'],
  }),
  new PWPackage({
    name: 'playwright-core',
    path: path.join(ROOT_PATH, 'packages', 'playwright-core'),
    files: LICENCE_FILES,
  }),
  new PWPackage({
    name: '@playwright/test',
    path: path.join(ROOT_PATH, 'packages', 'playwright-test'),
    files: LICENCE_FILES,
  }),
  new PWPackage({
    name: 'playwright-webkit',
    path: path.join(ROOT_PATH, 'packages', 'playwright-webkit'),
    files: LICENCE_FILES,
  }),
  new PWPackage({
    name: 'playwright-firefox',
    path: path.join(ROOT_PATH, 'packages', 'playwright-firefox'),
    files: LICENCE_FILES,
  }),
  new PWPackage({
    name: 'playwright-chromium',
    path: path.join(ROOT_PATH, 'packages', 'playwright-chromium'),
    files: LICENCE_FILES,
  }),
  new PWPackage({
    name: 'html-reporter',
    path: path.join(ROOT_PATH, 'packages', 'html-reporter'),
    files: [],
  }),
  new PWPackage({
    name: '@playwright/ct-react',
    path: path.join(ROOT_PATH, 'packages', 'playwright-ct-react'),
    files: [],
  }),
  new PWPackage({
    name: '@playwright/ct-svelte',
    path: path.join(ROOT_PATH, 'packages', 'playwright-ct-svelte'),
    files: [],
  }),
  new PWPackage({
    name: '@playwright/ct-vue',
    path: path.join(ROOT_PATH, 'packages', 'playwright-ct-vue'),
    files: [],
  }),
]);

if (require.main === module) {
  parseCLI();
} else {
  module.exports = {workspace};
}

function die(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

async function parseCLI() {
  const commands = {
    '--ensure-consistent': async () => {
      const hasChanges = await workspace.ensureConsistent();
      if (hasChanges)
        die(`\n  ERROR: workspace is inconsistent! Run '//utils/workspace.js --ensure-consistent' and commit changes!`);
    },
    '--list-public-package-paths': () => {
      for (const pkg of workspace.packages()) {
        if (!pkg.isPrivate)
          console.log(pkg.path);
      }
    },
    '--set-version': async (version) => {
      if (!version)
        die('ERROR: Please specify version! e.g. --set-version 1.99.2');
      await workspace.setVersion(version);
    },
    '--help': () => {
      console.log([
        `Available commands:`,
        ...Object.keys(commands).map(cmd => '  ' + cmd),
      ].join('\n'));
    },
  };
  const handler = commands[process.argv[2]];
  if (!handler)
    die('ERROR: wrong usage! Run with --help to list commands');
  await handler(process.argv[3]);
}
