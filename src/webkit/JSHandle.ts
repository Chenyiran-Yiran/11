/**
 * Copyright 2019 Google Inc. All rights reserved.
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

import * as fs from 'fs';
import { assert, debugError, helper } from '../helper';
import * as input from '../input';
import { TargetSession } from './Connection';
import { JSHandle, ExecutionContext, ExecutionContextDelegate, markJSHandle } from './ExecutionContext';
import { FrameManager } from './FrameManager';
import { Page } from './Page';
import { Protocol } from './protocol';
import Injected from '../injected/injected';
import * as types from '../types';
import * as js from '../javascript';

type SelectorRoot = Element | ShadowRoot | Document;

const writeFileAsync = helper.promisify(fs.writeFile);

export function createJSHandle(context: ExecutionContext, remoteObject: Protocol.Runtime.RemoteObject) {
  const delegate = context._delegate as ExecutionContextDelegate;
  const frame = context.frame();
  if (remoteObject.subtype === 'node' && frame) {
    const frameManager = frame._delegate as FrameManager;
    return new ElementHandle(context, delegate._session, remoteObject, frameManager.page(), frameManager);
  }
  const handle = new js.JSHandle(context);
  markJSHandle(handle, remoteObject);
  return handle;
}

export class ElementHandle extends js.JSHandle<ElementHandle> {
  private _client: TargetSession;
  private _remoteObject: Protocol.Runtime.RemoteObject;
  private _page: Page;
  private _frameManager: FrameManager;

  constructor(context: ExecutionContext, client: TargetSession, remoteObject: Protocol.Runtime.RemoteObject, page: Page, frameManager: FrameManager) {
    super(context);
    this._client = client;
    this._remoteObject = remoteObject;
    this._page = page;
    this._frameManager = frameManager;
    markJSHandle(this, remoteObject);
  }

  asElement(): ElementHandle | null {
    return this;
  }

  async _scrollIntoViewIfNeeded() {
    const error = await this.evaluate(async (element, pageJavascriptEnabled) => {
      if (!element.isConnected)
        return 'Node is detached from document';
      if (element.nodeType !== Node.ELEMENT_NODE)
        return 'Node is not of type HTMLElement';
      // force-scroll if page's javascript is disabled.
      if (!pageJavascriptEnabled) {
        element.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
        return false;
      }
      const visibleRatio = await new Promise(resolve => {
        const observer = new IntersectionObserver(entries => {
          resolve(entries[0].intersectionRatio);
          observer.disconnect();
        });
        observer.observe(element);
      });
      if (visibleRatio !== 1.0)
        element.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
      return false;
    }, this._page._javascriptEnabled);
    if (error)
      throw new Error(error);
  }

  async _clickablePoint() {
    const [result, viewport] = await Promise.all([
      this._client.send('DOM.getContentQuads', {
        objectId: this._remoteObject.objectId
      }).catch(debugError),
      this._page.evaluate(() => ({ clientWidth: innerWidth, clientHeight: innerHeight })),
    ]);
    if (!result || !result.quads.length)
      throw new Error('Node is either not visible or not an HTMLElement');
    // Filter out quads that have too small area to click into.
    const {clientWidth, clientHeight} = viewport;
    const quads = result.quads.map(quad => this._fromProtocolQuad(quad)).map(quad => this._intersectQuadWithViewport(quad, clientWidth, clientHeight)).filter(quad => computeQuadArea(quad) > 1);
    if (!quads.length)
      throw new Error('Node is either not visible or not an HTMLElement');
    // Return the middle point of the first quad.
    const quad = quads[0];
    let x = 0;
    let y = 0;
    for (const point of quad) {
      x += point.x;
      y += point.y;
    }
    return {
      x: x / 4,
      y: y / 4
    };
  }

  _fromProtocolQuad(quad: number[]): Array<{ x: number; y: number; }> {
    return [
      {x: quad[0], y: quad[1]},
      {x: quad[2], y: quad[3]},
      {x: quad[4], y: quad[5]},
      {x: quad[6], y: quad[7]}
    ];
  }

  _intersectQuadWithViewport(quad: Array<{ x: number; y: number; }>, width: number, height: number): Array<{ x: number; y: number; }> {
    return quad.map(point => ({
      x: Math.min(Math.max(point.x, 0), width),
      y: Math.min(Math.max(point.y, 0), height),
    }));
  }

  async hover(): Promise<void> {
    await this._scrollIntoViewIfNeeded();
    const {x, y} = await this._clickablePoint();
    await this._page.mouse.move(x, y);
  }

  async click(options?: input.ClickOptions): Promise<void> {
    await this._scrollIntoViewIfNeeded();
    const {x, y} = await this._clickablePoint();
    await this._page.mouse.click(x, y, options);
  }

  async dblclick(options?: input.MultiClickOptions): Promise<void> {
    await this._scrollIntoViewIfNeeded();
    const {x, y} = await this._clickablePoint();
    await this._page.mouse.dblclick(x, y, options);
  }

  async tripleclick(options?: input.MultiClickOptions): Promise<void> {
    await this._scrollIntoViewIfNeeded();
    const {x, y} = await this._clickablePoint();
    await this._page.mouse.tripleclick(x, y, options);
  }

  async select(...values: (string | ElementHandle | input.SelectOption)[]): Promise<string[]> {
    const options = values.map(value => typeof value === 'object' ? value : { value });
    for (const option of options) {
      if (option instanceof ElementHandle)
        continue;
      if (option.value !== undefined)
        assert(helper.isString(option.value), 'Values must be strings. Found value "' + option.value + '" of type "' + (typeof option.value) + '"');
      if (option.label !== undefined)
        assert(helper.isString(option.label), 'Labels must be strings. Found label "' + option.label + '" of type "' + (typeof option.label) + '"');
      if (option.index !== undefined)
        assert(helper.isNumber(option.index), 'Indices must be numbers. Found index "' + option.index + '" of type "' + (typeof option.index) + '"');
    }
    return this.evaluate(input.selectFunction, ...options);
  }

  async fill(value: string): Promise<void> {
    assert(helper.isString(value), 'Value must be string. Found value "' + value + '" of type "' + (typeof value) + '"');
    const error = await this.evaluate(input.fillFunction);
    if (error)
      throw new Error(error);
    await this.focus();
    await this._page.keyboard.sendCharacters(value);
  }

  async setInputFiles(...files: (string|input.FilePayload)[]) {
    const multiple = await this.evaluate((element: HTMLInputElement) => !!element.multiple);
    assert(multiple || files.length <= 1, 'Non-multiple file input can only accept single file!');
    await this.evaluate(input.setFileInputFunction, await input.loadFiles(files));
  }

  async focus() {
    await this.evaluate(element => element.focus());
  }

  async type(text: string, options: { delay: (number | undefined); } | undefined) {
    await this.focus();
    await this._page.keyboard.type(text, options);
  }

  async press(key: string, options: { delay?: number; text?: string; } | undefined) {
    await this.focus();
    await this._page.keyboard.press(key, options);
  }

  async screenshot(options: {path?: string} = {}): Promise<string | Buffer> {
    const objectId = this._remoteObject.objectId;
    this._client.send('DOM.getDocument');
    const {nodeId} = await this._client.send('DOM.requestNode', {objectId});
    const result = await this._client.send('Page.snapshotNode', {nodeId});
    const prefix = 'data:image/png;base64,';
    const buffer = Buffer.from(result.dataURL.substr(prefix.length), 'base64');
    if (options.path)
      await writeFileAsync(options.path, buffer);
    return buffer;
  }

  async $(selector: string): Promise<ElementHandle | null> {
    const handle = await this.evaluateHandle(
        (root: SelectorRoot, selector: string, injected: Injected) => injected.querySelector('css=' + selector, root),
        selector, await this._context._injected()
    );
    const element = handle.asElement();
    if (element)
      return element;
    await handle.dispose();
    return null;
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const arrayHandle = await this.evaluateHandle(
        (element, selector) => element.querySelectorAll(selector),
        selector
    );
    const properties = await arrayHandle.getProperties();
    await arrayHandle.dispose();
    const result = [];
    for (const property of properties.values()) {
      const elementHandle = property.asElement();
      if (elementHandle)
        result.push(elementHandle);
    }
    return result;
  }

  $eval: types.$Eval<JSHandle> = async (selector, pageFunction, ...args) => {
    const elementHandle = await this.$(selector);
    if (!elementHandle)
      throw new Error(`Error: failed to find element matching selector "${selector}"`);
    const result = await elementHandle.evaluate(pageFunction, ...args as any);
    await elementHandle.dispose();
    return result;
  }

  $$eval: types.$$Eval<JSHandle> = async (selector, pageFunction, ...args) => {
    const arrayHandle = await this.evaluateHandle(
        (root: SelectorRoot, selector: string, injected: Injected) => injected.querySelectorAll('css=' + selector, root),
        selector, await this._context._injected()
    );

    const result = await arrayHandle.evaluate(pageFunction, ...args as any);
    await arrayHandle.dispose();
    return result;
  }

  async $x(expression: string): Promise<ElementHandle[]> {
    const arrayHandle = await this.evaluateHandle(
        (root: SelectorRoot, expression: string, injected: Injected) => injected.querySelectorAll('xpath=' + expression, root),
        expression, await this._context._injected()
    );
    const properties = await arrayHandle.getProperties();
    await arrayHandle.dispose();
    const result = [];
    for (const property of properties.values()) {
      const elementHandle = property.asElement();
      if (elementHandle)
        result.push(elementHandle);
    }
    return result;
  }

  isIntersectingViewport(): Promise<boolean> {
    return this.evaluate(async element => {
      const visibleRatio = await new Promise(resolve => {
        const observer = new IntersectionObserver(entries => {
          resolve(entries[0].intersectionRatio);
          observer.disconnect();
        });
        observer.observe(element);
      });
      return visibleRatio > 0;
    });
  }
}

function computeQuadArea(quad) {
  // Compute sum of all directed areas of adjacent triangles
  // https://en.wikipedia.org/wiki/Polygon#Simple_polygons
  let area = 0;
  for (let i = 0; i < quad.length; ++i) {
    const p1 = quad[i];
    const p2 = quad[(i + 1) % quad.length];
    area += (p1.x * p2.y - p2.x * p1.y) / 2;
  }
  return Math.abs(area);
}
