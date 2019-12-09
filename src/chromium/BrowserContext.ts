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

import { assert } from '../helper';
import { filterCookies, NetworkCookie, rewriteCookies, SetNetworkCookieParam } from '../network';
import { Browser } from './Browser';
import { CDPSession } from './Connection';
import { Permissions } from './features/permissions';
import { Page } from '../page';

export class BrowserContext {
  readonly permissions: Permissions;

  private _browser: Browser;
  private _id: string;

  constructor(client: CDPSession, browser: Browser, contextId: string | null) {
    this._browser = browser;
    this._id = contextId;
    this.permissions = new Permissions(client, contextId);
  }

  pages(): Promise<Page<Browser, BrowserContext>[]> {
    return this._browser._pages(this);
  }

  isIncognito(): boolean {
    return !!this._id;
  }

  newPage(): Promise<Page<Browser, BrowserContext>> {
    return this._browser._createPageInContext(this._id);
  }

  browser(): Browser {
    return this._browser;
  }

  async cookies(...urls: string[]): Promise<NetworkCookie[]> {
    const { cookies } = await this._browser._client.send('Storage.getCookies', { browserContextId: this._id || undefined });
    return filterCookies(cookies.map(c => {
      const copy: any = { sameSite: 'None', ...c };
      delete copy.size;
      return copy as NetworkCookie;
    }), urls);
  }

  async clearCookies() {
    await this._browser._client.send('Storage.clearCookies', { browserContextId: this._id || undefined });
  }

  async setCookies(cookies: SetNetworkCookieParam[]) {
    cookies = rewriteCookies(cookies);
    await this._browser._client.send('Storage.setCookies', { cookies, browserContextId: this._id || undefined });
  }

  async close() {
    assert(this._id, 'Non-incognito profiles cannot be closed!');
    await this._browser._disposeContext(this._id);
  }
}
