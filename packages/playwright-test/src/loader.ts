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

import { installTransform, setCurrentlyLoadingTestFile } from './transform';
import type { Config, Project, ReporterDescription, FullProjectInternal, GlobalInfo } from './types';
import type { FullConfigInternal } from './types';
import { getPackageJsonPath, mergeObjects, errorWithFile } from './util';
import { setCurrentlyLoadingFileSuite } from './globals';
import { Suite } from './test';
import type { SerializedLoaderData } from './ipc';
import * as path from 'path';
import * as url from 'url';
import * as fs from 'fs';
import * as os from 'os';
import type { BuiltInReporter, ConfigCLIOverrides } from './runner';
import type { Reporter } from '../types/testReporter';
import { builtInReporters } from './runner';
import { isRegExp } from 'playwright-core/lib/utils';
import { serializeError } from './util';
import { _legacyWebServer } from './plugins/webServerPlugin';
import { hostPlatform } from 'playwright-core/lib/utils/hostPlatform';
import { pluginLogger } from './util';

export const defaultTimeout = 30000;

// To allow multiple loaders in the same process without clearing require cache,
// we make these maps global.
const cachedFileSuites = new Map<string, Suite>();

export class Loader {
  private _configCLIOverrides: ConfigCLIOverrides;
  private _fullConfig: FullConfigInternal;
  private _configDir: string = '';
  private _configFile: string | undefined;

  constructor(configCLIOverrides?: ConfigCLIOverrides) {
    this._configCLIOverrides = configCLIOverrides || {};
    this._fullConfig = { ...baseFullConfig };
  }

  static async deserialize(data: SerializedLoaderData): Promise<Loader> {
    if (process.env.PLAYWRIGHT_LEGACY_CONFIG_MODE) {
      const loader = new Loader(data.overridesForLegacyConfigMode);
      if (data.configFile)
        await loader.loadConfigFile(data.configFile);
      else
        await loader.loadEmptyConfig(data.configDir);
      return loader;
    } else {
      const loader = new Loader();
      loader._configFile = data.configFile;
      loader._configDir = data.configDir;
      loader._fullConfig = data.config;
      return loader;
    }
  }

  async loadConfigFile(file: string): Promise<FullConfigInternal> {
    if (this._configFile)
      throw new Error('Cannot load two config files');
    let config = await this._requireOrImport(file) as Config;
    if (config && typeof config === 'object' && ('default' in config))
      config = (config as any)['default'];
    this._configFile = file;
    await this._processConfigObject(config, path.dirname(file));
    return this._fullConfig;
  }

  async loadEmptyConfig(configDir: string): Promise<Config> {
    await this._processConfigObject({}, configDir);
    return {};
  }

  private async _processConfigObject(config: Config, configDir: string) {
    if (config.webServer) {
      config.plugins = config.plugins || [];
      config.plugins.push(_legacyWebServer(config.webServer));
    }

    // 1. Validate data provided in the config file.
    validateConfig(this._configFile || '<default config>', config);

    // 2. Override settings from CLI.
    config.forbidOnly = takeFirst(this._configCLIOverrides.forbidOnly, config.forbidOnly);
    config.fullyParallel = takeFirst(this._configCLIOverrides.fullyParallel, config.fullyParallel);
    config.globalTimeout = takeFirst(this._configCLIOverrides.globalTimeout, config.globalTimeout);
    config.grep = takeFirst(this._configCLIOverrides.grep, config.grep);
    config.grepInvert = takeFirst(this._configCLIOverrides.grepInvert, config.grepInvert);
    config.maxFailures = takeFirst(this._configCLIOverrides.maxFailures, config.maxFailures);
    config.outputDir = takeFirst(this._configCLIOverrides.outputDir, config.outputDir);
    config.quiet = takeFirst(this._configCLIOverrides.quiet, config.quiet);
    config.repeatEach = takeFirst(this._configCLIOverrides.repeatEach, config.repeatEach);
    config.retries = takeFirst(this._configCLIOverrides.retries, config.retries);
    if (this._configCLIOverrides.reporter)
      config.reporter = toReporters(this._configCLIOverrides.reporter as any);
    config.shard = takeFirst(this._configCLIOverrides.shard, config.shard);
    config.timeout = takeFirst(this._configCLIOverrides.timeout, config.timeout);
    config.updateSnapshots = takeFirst(this._configCLIOverrides.updateSnapshots, config.updateSnapshots);
    if (this._configCLIOverrides.projects && config.projects)
      throw new Error(`Cannot use --browser option when configuration file defines projects. Specify browserName in the projects instead.`);
    config.projects = takeFirst(this._configCLIOverrides.projects, config.projects as any);
    config.workers = takeFirst(this._configCLIOverrides.workers, config.workers);
    config.use = mergeObjects(config.use, this._configCLIOverrides.use);
    for (const project of config.projects || [])
      this._applyCLIOverridesToProject(project);

    // 3. Run configure plugins phase.
    for (const plugin of config.plugins || []) {
      if (plugin.configure) {
        pluginLogger(plugin)('Running configure');
        await plugin.configure(config, configDir);
        pluginLogger(plugin)('Finished configure');
      }
    }

    // 4. Resolve config.
    this._configDir = configDir;
    const packageJsonPath = getPackageJsonPath(configDir);
    const packageJsonDir = packageJsonPath ? path.dirname(packageJsonPath) : undefined;
    const throwawayArtifactsPath = packageJsonDir || process.cwd();

    // Resolve script hooks relative to the root dir.
    if (config.globalSetup)
      config.globalSetup = resolveScript(config.globalSetup, configDir);
    if (config.globalTeardown)
      config.globalTeardown = resolveScript(config.globalTeardown, configDir);
    // Resolve all config dirs relative to configDir.
    if (config.testDir !== undefined)
      config.testDir = path.resolve(configDir, config.testDir);
    if (config.outputDir !== undefined)
      config.outputDir = path.resolve(configDir, config.outputDir);
    if ((config as any).screenshotsDir !== undefined)
      (config as any).screenshotsDir = path.resolve(configDir, (config as any).screenshotsDir);
    if (config.snapshotDir !== undefined)
      config.snapshotDir = path.resolve(configDir, config.snapshotDir);
    if (config.webServer)
      config.webServer.cwd = config.webServer.cwd ? path.resolve(configDir, config.webServer.cwd) : configDir;

    this._fullConfig._configDir = configDir;
    this._fullConfig.rootDir = config.testDir || this._configDir;
    this._fullConfig._globalOutputDir = takeFirst(config.outputDir, throwawayArtifactsPath, baseFullConfig._globalOutputDir);
    this._fullConfig.forbidOnly = takeFirst(config.forbidOnly, baseFullConfig.forbidOnly);
    this._fullConfig.fullyParallel = takeFirst(config.fullyParallel, baseFullConfig.fullyParallel);
    this._fullConfig.globalSetup = takeFirst(config.globalSetup, baseFullConfig.globalSetup);
    this._fullConfig.globalTeardown = takeFirst(config.globalTeardown, baseFullConfig.globalTeardown);
    this._fullConfig.globalTimeout = takeFirst(config.globalTimeout, baseFullConfig.globalTimeout);
    this._fullConfig.grep = takeFirst(config.grep, baseFullConfig.grep);
    this._fullConfig.grepInvert = takeFirst(config.grepInvert, baseFullConfig.grepInvert);
    this._fullConfig.maxFailures = takeFirst(config.maxFailures, baseFullConfig.maxFailures);
    this._fullConfig.preserveOutput = takeFirst(config.preserveOutput, baseFullConfig.preserveOutput);
    this._fullConfig.reporter = takeFirst(resolveReporters(config.reporter, configDir), baseFullConfig.reporter);
    this._fullConfig.reportSlowTests = takeFirst(config.reportSlowTests, baseFullConfig.reportSlowTests);
    this._fullConfig.quiet = takeFirst(config.quiet, baseFullConfig.quiet);
    this._fullConfig.shard = takeFirst(config.shard, baseFullConfig.shard);
    this._fullConfig.updateSnapshots = takeFirst(config.updateSnapshots, baseFullConfig.updateSnapshots);
    this._fullConfig.workers = takeFirst(config.workers, baseFullConfig.workers);
    this._fullConfig.webServer = takeFirst(config.webServer, baseFullConfig.webServer);
    this._fullConfig._plugins = takeFirst(config.plugins, baseFullConfig._plugins);
    this._fullConfig.projects = (config.projects || [config]).map(p => this._resolveProject(config, p, throwawayArtifactsPath));
  }

  async loadTestFile(file: string, environment: 'runner' | 'worker') {
    if (cachedFileSuites.has(file))
      return cachedFileSuites.get(file)!;
    const suite = new Suite(path.relative(this._fullConfig.rootDir, file) || path.basename(file));
    suite._requireFile = file;
    suite.location = { file, line: 0, column: 0 };

    setCurrentlyLoadingTestFile(file);
    setCurrentlyLoadingFileSuite(suite);
    try {
      await this._requireOrImport(file);
      cachedFileSuites.set(file, suite);
    } catch (e) {
      if (environment === 'worker')
        throw e;
      suite._loadError = serializeError(e);
    } finally {
      setCurrentlyLoadingTestFile(null);
      setCurrentlyLoadingFileSuite(undefined);
    }

    {
      // Test locations that we discover potentially have different file name.
      // This could be due to either
      //   a) use of source maps or due to
      //   b) require of one file from another.
      // Try fixing (a) w/o regressing (b).

      const files = new Set<string>();
      suite.allTests().map(t => files.add(t.location.file));
      if (files.size === 1) {
        // All tests point to one file.
        const mappedFile = files.values().next().value;
        if (suite.location.file !== mappedFile) {
          // The file is different, check for a likely source map case.
          if (path.extname(mappedFile) !== path.extname(suite.location.file))
            suite.location.file = mappedFile;
        }
      }
    }

    return suite;
  }

  async loadGlobalHook(file: string, name: string): Promise<(config: FullConfigInternal, globalInfo?: GlobalInfo) => any> {
    let hook = await this._requireOrImport(file);
    if (hook && typeof hook === 'object' && ('default' in hook))
      hook = hook['default'];
    if (typeof hook !== 'function')
      throw errorWithFile(file, `${name} file must export a single function.`);
    return hook;
  }

  async loadReporter(file: string): Promise<new (arg?: any) => Reporter> {
    let func = await this._requireOrImport(path.resolve(this._fullConfig.rootDir, file));
    if (func && typeof func === 'object' && ('default' in func))
      func = func['default'];
    if (typeof func !== 'function')
      throw errorWithFile(file, `reporter file must export a single class.`);
    return func;
  }

  fullConfig(): FullConfigInternal {
    return this._fullConfig;
  }

  serialize(): SerializedLoaderData {
    const result: SerializedLoaderData = {
      configFile: this._configFile,
      configDir: this._configDir,
      config: this._fullConfig,
    };
    if (process.env.PLAYWRIGHT_LEGACY_CONFIG_MODE)
      result.overridesForLegacyConfigMode = this._configCLIOverrides;
    return result;
  }

  private _applyCLIOverridesToProject(projectConfig: Project) {
    projectConfig.fullyParallel = takeFirst(this._configCLIOverrides.fullyParallel, projectConfig.fullyParallel);
    projectConfig.grep = takeFirst(this._configCLIOverrides.grep, projectConfig.grep);
    projectConfig.grepInvert = takeFirst(this._configCLIOverrides.grepInvert, projectConfig.grepInvert);
    projectConfig.outputDir = takeFirst(this._configCLIOverrides.outputDir, projectConfig.outputDir);
    projectConfig.repeatEach = takeFirst(this._configCLIOverrides.repeatEach, projectConfig.repeatEach);
    projectConfig.retries = takeFirst(this._configCLIOverrides.retries, projectConfig.retries);
    projectConfig.timeout = takeFirst(this._configCLIOverrides.timeout, projectConfig.timeout);
    projectConfig.use = mergeObjects(projectConfig.use, this._configCLIOverrides.use);
  }

  private _resolveProject(config: Config, projectConfig: Project, throwawayArtifactsPath: string): FullProjectInternal {
    // Resolve all config dirs relative to configDir.
    if (projectConfig.testDir !== undefined)
      projectConfig.testDir = path.resolve(this._configDir, projectConfig.testDir);
    if (projectConfig.outputDir !== undefined)
      projectConfig.outputDir = path.resolve(this._configDir, projectConfig.outputDir);
    if ((projectConfig as any).screenshotsDir !== undefined)
      (projectConfig as any).screenshotsDir = path.resolve(this._configDir, (projectConfig as any).screenshotsDir);
    if (projectConfig.snapshotDir !== undefined)
      projectConfig.snapshotDir = path.resolve(this._configDir, projectConfig.snapshotDir);

    const testDir = takeFirst(projectConfig.testDir, config.testDir, this._configDir);

    const outputDir = takeFirst(projectConfig.outputDir, config.outputDir, path.join(throwawayArtifactsPath, 'test-results'));
    const snapshotDir = takeFirst(projectConfig.snapshotDir, config.snapshotDir, testDir);
    const name = takeFirst(projectConfig.name, config.name, '');
    const screenshotsDir = takeFirst((projectConfig as any).screenshotsDir, (config as any).screenshotsDir, path.join(testDir, '__screenshots__', process.platform, name));
    return {
      _fullyParallel: takeFirst(projectConfig.fullyParallel, config.fullyParallel, undefined),
      _expect: takeFirst(projectConfig.expect, config.expect, undefined),
      grep: takeFirst(projectConfig.grep, config.grep, baseFullConfig.grep),
      grepInvert: takeFirst(projectConfig.grepInvert, config.grepInvert, baseFullConfig.grepInvert),
      outputDir,
      repeatEach: takeFirst(projectConfig.repeatEach, config.repeatEach, 1),
      retries: takeFirst(projectConfig.retries, config.retries, 0),
      metadata: takeFirst(projectConfig.metadata, config.metadata, undefined),
      name,
      testDir,
      snapshotDir,
      _screenshotsDir: screenshotsDir,
      testIgnore: takeFirst(projectConfig.testIgnore, config.testIgnore, []),
      testMatch: takeFirst(projectConfig.testMatch, config.testMatch, '**/?(*.)@(spec|test).*'),
      timeout: takeFirst(projectConfig.timeout, config.timeout, defaultTimeout),
      use: mergeObjects(config.use, projectConfig.use),
    };
  }

  private async _requireOrImport(file: string) {
    const revertBabelRequire = installTransform();
    const isModule = fileIsModule(file);
    try {
      const esmImport = () => eval(`import(${JSON.stringify(url.pathToFileURL(file))})`);
      if (isModule)
        return await esmImport();
      return require(file);
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('Did you mean to import')) {
        const didYouMean = /Did you mean to import (.*)\?/.exec(error.message)?.[1];
        if (didYouMean?.endsWith('.ts'))
          throw errorWithFile(file, 'Cannot import a typescript file from an esmodule.');
      }
      if (error.code === 'ERR_UNKNOWN_FILE_EXTENSION' && error.message.includes('.ts')) {
        throw errorWithFile(file, `Cannot import a typescript file from an esmodule.\n${'='.repeat(80)}\nMake sure that:
  - you are using Node.js 16+,
  - your package.json contains "type": "module",
  - you are using TypeScript for playwright.config.ts.
${'='.repeat(80)}\n`);
      }

      if (error instanceof SyntaxError && error.message.includes('Cannot use import statement outside a module'))
        throw errorWithFile(file, 'JavaScript files must end with .mjs to use import.');

      throw error;
    } finally {
      revertBabelRequire();
    }
  }
}

function takeFirst<T>(...args: (T | undefined)[]): T {
  for (const arg of args) {
    if (arg !== undefined)
      return arg;
  }
  return undefined as any as T;
}

function toReporters(reporters: BuiltInReporter | ReporterDescription[] | undefined): ReporterDescription[] | undefined {
  if (!reporters)
    return;
  if (typeof reporters === 'string')
    return [ [reporters] ];
  return reporters;
}

function validateConfig(file: string, config: Config) {
  if (typeof config !== 'object' || !config)
    throw errorWithFile(file, `Configuration file must export a single object`);

  validateProject(file, config, 'config');

  if ('forbidOnly' in config && config.forbidOnly !== undefined) {
    if (typeof config.forbidOnly !== 'boolean')
      throw errorWithFile(file, `config.forbidOnly must be a boolean`);
  }

  if ('globalSetup' in config && config.globalSetup !== undefined) {
    if (typeof config.globalSetup !== 'string')
      throw errorWithFile(file, `config.globalSetup must be a string`);
  }

  if ('globalTeardown' in config && config.globalTeardown !== undefined) {
    if (typeof config.globalTeardown !== 'string')
      throw errorWithFile(file, `config.globalTeardown must be a string`);
  }

  if ('globalTimeout' in config && config.globalTimeout !== undefined) {
    if (typeof config.globalTimeout !== 'number' || config.globalTimeout < 0)
      throw errorWithFile(file, `config.globalTimeout must be a non-negative number`);
  }

  if ('grep' in config && config.grep !== undefined) {
    if (Array.isArray(config.grep)) {
      config.grep.forEach((item, index) => {
        if (!isRegExp(item))
          throw errorWithFile(file, `config.grep[${index}] must be a RegExp`);
      });
    } else if (!isRegExp(config.grep)) {
      throw errorWithFile(file, `config.grep must be a RegExp`);
    }
  }

  if ('grepInvert' in config && config.grepInvert !== undefined) {
    if (Array.isArray(config.grepInvert)) {
      config.grepInvert.forEach((item, index) => {
        if (!isRegExp(item))
          throw errorWithFile(file, `config.grepInvert[${index}] must be a RegExp`);
      });
    } else if (!isRegExp(config.grepInvert)) {
      throw errorWithFile(file, `config.grep must be a RegExp`);
    }
  }

  if ('maxFailures' in config && config.maxFailures !== undefined) {
    if (typeof config.maxFailures !== 'number' || config.maxFailures < 0)
      throw errorWithFile(file, `config.maxFailures must be a non-negative number`);
  }

  if ('preserveOutput' in config && config.preserveOutput !== undefined) {
    if (typeof config.preserveOutput !== 'string' || !['always', 'never', 'failures-only'].includes(config.preserveOutput))
      throw errorWithFile(file, `config.preserveOutput must be one of "always", "never" or "failures-only"`);
  }

  if ('projects' in config && config.projects !== undefined) {
    if (!Array.isArray(config.projects))
      throw errorWithFile(file, `config.projects must be an array`);
    config.projects.forEach((project, index) => {
      validateProject(file, project, `config.projects[${index}]`);
    });
  }

  if ('quiet' in config && config.quiet !== undefined) {
    if (typeof config.quiet !== 'boolean')
      throw errorWithFile(file, `config.quiet must be a boolean`);
  }

  if ('reporter' in config && config.reporter !== undefined) {
    if (Array.isArray(config.reporter)) {
      config.reporter.forEach((item, index) => {
        if (!Array.isArray(item) || item.length <= 0 || item.length > 2 || typeof item[0] !== 'string')
          throw errorWithFile(file, `config.reporter[${index}] must be a tuple [name, optionalArgument]`);
      });
    } else if (typeof config.reporter !== 'string') {
      throw errorWithFile(file, `config.reporter must be a string`);
    }
  }

  if ('reportSlowTests' in config && config.reportSlowTests !== undefined && config.reportSlowTests !== null) {
    if (!config.reportSlowTests || typeof config.reportSlowTests !== 'object')
      throw errorWithFile(file, `config.reportSlowTests must be an object`);
    if (!('max' in config.reportSlowTests) || typeof config.reportSlowTests.max !== 'number' || config.reportSlowTests.max < 0)
      throw errorWithFile(file, `config.reportSlowTests.max must be a non-negative number`);
    if (!('threshold' in config.reportSlowTests) || typeof config.reportSlowTests.threshold !== 'number' || config.reportSlowTests.threshold < 0)
      throw errorWithFile(file, `config.reportSlowTests.threshold must be a non-negative number`);
  }

  if ('shard' in config && config.shard !== undefined && config.shard !== null) {
    if (!config.shard || typeof config.shard !== 'object')
      throw errorWithFile(file, `config.shard must be an object`);
    if (!('total' in config.shard) || typeof config.shard.total !== 'number' || config.shard.total < 1)
      throw errorWithFile(file, `config.shard.total must be a positive number`);
    if (!('current' in config.shard) || typeof config.shard.current !== 'number' || config.shard.current < 1 || config.shard.current > config.shard.total)
      throw errorWithFile(file, `config.shard.current must be a positive number, not greater than config.shard.total`);
  }

  if ('updateSnapshots' in config && config.updateSnapshots !== undefined) {
    if (typeof config.updateSnapshots !== 'string' || !['all', 'none', 'missing'].includes(config.updateSnapshots))
      throw errorWithFile(file, `config.updateSnapshots must be one of "all", "none" or "missing"`);
  }

  if ('workers' in config && config.workers !== undefined) {
    if (typeof config.workers !== 'number' || config.workers <= 0)
      throw errorWithFile(file, `config.workers must be a positive number`);
  }
}

function validateProject(file: string, project: Project, title: string) {
  if (typeof project !== 'object' || !project)
    throw errorWithFile(file, `${title} must be an object`);

  if ('name' in project && project.name !== undefined) {
    if (typeof project.name !== 'string')
      throw errorWithFile(file, `${title}.name must be a string`);
  }

  if ('outputDir' in project && project.outputDir !== undefined) {
    if (typeof project.outputDir !== 'string')
      throw errorWithFile(file, `${title}.outputDir must be a string`);
  }

  if ('repeatEach' in project && project.repeatEach !== undefined) {
    if (typeof project.repeatEach !== 'number' || project.repeatEach < 0)
      throw errorWithFile(file, `${title}.repeatEach must be a non-negative number`);
  }

  if ('retries' in project && project.retries !== undefined) {
    if (typeof project.retries !== 'number' || project.retries < 0)
      throw errorWithFile(file, `${title}.retries must be a non-negative number`);
  }

  if ('testDir' in project && project.testDir !== undefined) {
    if (typeof project.testDir !== 'string')
      throw errorWithFile(file, `${title}.testDir must be a string`);
  }

  for (const prop of ['testIgnore', 'testMatch'] as const) {
    if (prop in project && project[prop] !== undefined) {
      const value = project[prop];
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item !== 'string' && !isRegExp(item))
            throw errorWithFile(file, `${title}.${prop}[${index}] must be a string or a RegExp`);
        });
      } else if (typeof value !== 'string' && !isRegExp(value)) {
        throw errorWithFile(file, `${title}.${prop} must be a string or a RegExp`);
      }
    }
  }

  if ('timeout' in project && project.timeout !== undefined) {
    if (typeof project.timeout !== 'number' || project.timeout < 0)
      throw errorWithFile(file, `${title}.timeout must be a non-negative number`);
  }

  if ('use' in project && project.use !== undefined) {
    if (!project.use || typeof project.use !== 'object')
      throw errorWithFile(file, `${title}.use must be an object`);
  }
}

const cpus = os.cpus().length;
const workers = hostPlatform.startsWith('mac') && hostPlatform.endsWith('arm64') ? cpus : Math.ceil(cpus / 2);

export const baseFullConfig: FullConfigInternal = {
  forbidOnly: false,
  fullyParallel: false,
  globalSetup: null,
  globalTeardown: null,
  globalTimeout: 0,
  grep: /.*/,
  grepInvert: null,
  maxFailures: 0,
  preserveOutput: 'always',
  projects: [],
  reporter: [ [process.env.CI ? 'dot' : 'list'] ],
  reportSlowTests: { max: 5, threshold: 15000 },
  rootDir: path.resolve(process.cwd()),
  quiet: false,
  shard: null,
  updateSnapshots: 'missing',
  version: require('../package.json').version,
  workers,
  webServer: null,
  _globalOutputDir: path.resolve(process.cwd()),
  _configDir: '',
  _testGroupsCount: 0,
  _plugins: [],
};

function resolveReporters(reporters: Config['reporter'], rootDir: string): ReporterDescription[]|undefined {
  return toReporters(reporters as any)?.map(([id, arg]) => {
    if (builtInReporters.includes(id as any))
      return [id, arg];
    return [require.resolve(id, { paths: [ rootDir ] }), arg];
  });
}

function resolveScript(id: string, rootDir: string) {
  const localPath = path.resolve(rootDir, id);
  if (fs.existsSync(localPath))
    return localPath;
  return require.resolve(id, { paths: [rootDir] });
}

export function fileIsModule(file: string): boolean {
  if (file.endsWith('.mjs'))
    return true;

  const folder = path.dirname(file);
  return folderIsModule(folder);
}

export function folderIsModule(folder: string): boolean {
  const packageJsonPath = getPackageJsonPath(folder);
  if (!packageJsonPath)
    return false;
  // Rely on `require` internal caching logic.
  return require(packageJsonPath).type === 'module';
}
