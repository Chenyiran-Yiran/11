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

import { options } from './playwright.fixtures';

it('should not throw', test => {
  test.skip(!options.TRACING);
}, async ({page, server, context, toImpl}) => {
  await page.goto(server.PREFIX + '/snapshot/snapshot-with-css.html');
  await (context as any).__snapshotter.captureSnapshot(toImpl(page), { timeout: 5000, label: 'snapshot' });
});
