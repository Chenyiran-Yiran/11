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

import * as types from '../../types';
import { BrowserTypeChannel, BrowserTypeInitializer } from '../channels';
import { Browser } from './browser';
import { BrowserContext } from './browserContext';
import { ChannelOwner } from './channelOwner';
import { BrowserServer } from './browserServer';
import { LoggerSink } from '../../loggerSink';

export class BrowserType extends ChannelOwner<BrowserTypeChannel, BrowserTypeInitializer> {

  static from(browserType: BrowserTypeChannel): BrowserType {
    return (browserType as any)._object;
  }

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: BrowserTypeInitializer) {
    super(parent, type, guid, initializer, true);
  }

  executablePath(): string {
    return this._initializer.executablePath;
  }

  name(): string {
    return this._initializer.name;
  }

  async launch(options: types.LaunchOptions & { logger?: LoggerSink } = {}): Promise<Browser> {
    const logger = options.logger;
    options = { ...options, logger: undefined };
    const browser = Browser.from(await this._channel.launch(options));
    browser._logger = logger;
    return browser;
  }

  async launchServer(options: types.LaunchServerOptions & { logger?: LoggerSink } = {}): Promise<BrowserServer> {
    options = { ...options, logger: undefined };
    return BrowserServer.from(await this._channel.launchServer(options));
  }

  async launchPersistentContext(userDataDir: string, options: types.LaunchOptions & types.BrowserContextOptions & { logger?: LoggerSink } = {}): Promise<BrowserContext> {
    const logger = options.logger;
    options = { ...options, logger: undefined };
    const context = BrowserContext.from(await this._channel.launchPersistentContext({ userDataDir, ...options }));
    context._logger = logger;
    return context;
  }

  async connect(options: types.ConnectOptions & { logger?: LoggerSink }): Promise<Browser> {
    const logger = options.logger;
    options = { ...options, logger: undefined };
    const browser = Browser.from(await this._channel.connect(options));
    browser._logger = logger;
    return browser;
  }
}
