/**
 * Copyright 2018 Google Inc. All rights reserved.
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

import { test as it, expect } from './pageTest';
import { verifyViewport, attachFrame } from '../config/utils';
import path from 'path';
import fs from 'fs';
import os from 'os';

it.describe('page screenshot', () => {
  it.skip(({ browserName, headless }) => browserName === 'firefox' && !headless, 'Firefox headed produces a different image.');
  it.skip(({ isAndroid }) => isAndroid, 'Different viewport');

  it('should work @smoke', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const screenshot = await page.screenshot();
    expect(screenshot).toMatchSnapshot('screenshot-sanity.png');
  });

  it('should not capture blinking caret by default', async ({ page, server }) => {
    await page.setContent(`
      <!-- Refer to stylesheet from other origin. Accessing this
           stylesheet rules will throw.
      -->
      <link rel=stylesheet href="${server.CROSS_PROCESS_PREFIX + '/injectedstyle.css'}">
      <!-- make life harder: define caret color in stylesheet -->
      <style>
        div {
          caret-color: #000 !important;
        }
      </style>
      <div contenteditable="true"></div>
    `);
    const div = page.locator('div');
    await div.type('foo bar');
    const screenshot = await div.screenshot();
    for (let i = 0; i < 10; ++i) {
      // Caret blinking time is set to 500ms.
      // Try to capture variety of screenshots to make
      // sure we don't capture blinking caret.
      await new Promise(x => setTimeout(x, 150));
      const newScreenshot = await div.screenshot();
      expect(newScreenshot.equals(screenshot)).toBe(true);
    }
  });

  it('should capture blinking caret if explicitly asked for', async ({ page, server }) => {
    await page.setContent(`
      <!-- Refer to stylesheet from other origin. Accessing this
           stylesheet rules will throw.
      -->
      <link rel=stylesheet href="${server.CROSS_PROCESS_PREFIX + '/injectedstyle.css'}">
      <!-- make life harder: define caret color in stylesheet -->
      <style>
        div {
          caret-color: #000 !important;
        }
      </style>
      <div contenteditable="true"></div>
    `);
    const div = page.locator('div');
    await div.type('foo bar');
    const screenshot = await div.screenshot();
    let hasDifferentScreenshots = false;
    for (let i = 0; !hasDifferentScreenshots && i < 10; ++i) {
      // Caret blinking time is set to 500ms.
      // Try to capture variety of screenshots to make
      // sure we capture blinking caret.
      await new Promise(x => setTimeout(x, 150));
      const newScreenshot = await div.screenshot({ caret: 'blink' });
      hasDifferentScreenshots = !newScreenshot.equals(screenshot);
    }
    expect(hasDifferentScreenshots).toBe(true);
  });

  it('should clip rect', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const screenshot = await page.screenshot({
      clip: {
        x: 50,
        y: 100,
        width: 150,
        height: 100
      }
    });
    expect(screenshot).toMatchSnapshot('screenshot-clip-rect.png');
  });

  it('should clip rect with fullPage', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    await page.evaluate(() => window.scrollBy(150, 200));
    const screenshot = await page.screenshot({
      fullPage: true,
      clip: {
        x: 50,
        y: 100,
        width: 150,
        height: 100,
      },
    });
    expect(screenshot).toMatchSnapshot('screenshot-clip-rect.png');
  });

  it('should clip elements to the viewport', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const screenshot = await page.screenshot({
      clip: {
        x: 50,
        y: 450,
        width: 1000,
        height: 100
      }
    });
    expect(screenshot).toMatchSnapshot('screenshot-offscreen-clip.png');
  });

  it('should throw on clip outside the viewport', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const screenshotError = await page.screenshot({
      clip: {
        x: 50,
        y: 650,
        width: 100,
        height: 100
      }
    }).catch(error => error);
    expect(screenshotError.message).toContain('Clipped area is either empty or outside the resulting image');
  });

  it('should run in parallel', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const promises = [];
    for (let i = 0; i < 3; ++i) {
      promises.push(page.screenshot({
        clip: {
          x: 50 * i,
          y: 0,
          width: 50,
          height: 50
        }
      }));
    }
    const screenshots = await Promise.all(promises);
    expect(screenshots[1]).toMatchSnapshot('grid-cell-1.png');
  });

  it('should take fullPage screenshots', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const screenshot = await page.screenshot({
      fullPage: true
    });
    expect(screenshot).toMatchSnapshot('screenshot-grid-fullpage.png');
  });

  it('should restore viewport after fullPage screenshot', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot).toBeInstanceOf(Buffer);
    await verifyViewport(page, 500, 500);
  });

  it('should allow transparency', async ({ page, browserName }) => {
    it.fail(browserName === 'firefox');

    await page.setViewportSize({ width: 50, height: 150 });
    await page.setContent(`
      <style>
        body { margin: 0 }
        div { width: 50px; height: 50px; }
      </style>
      <div style="background:black"></div>
      <div style="background:white"></div>
      <div style="background:transparent"></div>
    `);
    const screenshot = await page.screenshot({ omitBackground: true });
    expect(screenshot).toMatchSnapshot('transparent.png');
  });

  it('should render white background on jpeg file', async ({ page, server, isElectron }) => {
    it.fixme(isElectron, 'omitBackground with jpeg does not work');

    await page.setViewportSize({ width: 100, height: 100 });
    await page.goto(server.EMPTY_PAGE);
    const screenshot = await page.screenshot({ omitBackground: true, type: 'jpeg' });
    expect(screenshot).toMatchSnapshot('white.jpg');
  });

  it('should work with odd clip size on Retina displays', async ({ page, isElectron }) => {
    it.fixme(isElectron, 'Scale is wrong');

    const screenshot = await page.screenshot({
      clip: {
        x: 0,
        y: 0,
        width: 11,
        height: 11,
      }
    });
    expect(screenshot).toMatchSnapshot('screenshot-clip-odd-size.png');
  });

  it('should work for canvas', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/screenshots/canvas.html');
    const screenshot = await page.screenshot();
    expect(screenshot).toMatchSnapshot('screenshot-canvas.png', { threshold: 0.4 });
  });

  it('should capture canvas changes', async ({ page, isElectron, browserName, isMac }) => {
    it.fail(browserName === 'webkit' && isMac && parseInt(os.release(), 10) <= 20, 'https://github.com/microsoft/playwright/issues/8796');
    it.skip(isElectron);
    await page.goto('data:text/html,<canvas></canvas>');
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      canvas.width = 600;
      canvas.height = 600;
    });

    async function addLine(step: number) {
      await page.evaluate(n => {
        const canvas = document.querySelector('canvas');
        const ctx = canvas.getContext('2d');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, n * 100);
        ctx.lineTo(300, n * 100);
        ctx.stroke();
      }, step);
    }

    for (let i = 0; i < 3; i++) {
      await addLine(i);
      // With the slight delay WebKit stops reflecting changes in the screenshots on macOS.
      await new Promise(f => setTimeout(f, 100));
      const screenshot = await page.screenshot();
      expect(screenshot).toMatchSnapshot(`canvas-changes-${i}.png`);
    }
  });

  it('should work for webgl', async ({ page, server, browserName }) => {
    it.fixme(browserName === 'firefox' || browserName === 'webkit');

    await page.setViewportSize({ width: 640, height: 480 });
    await page.goto(server.PREFIX + '/screenshots/webgl.html');
    const screenshot = await page.screenshot();
    expect(screenshot).toMatchSnapshot('screenshot-webgl.png');
  });

  it('should work for translateZ', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/screenshots/translateZ.html');
    const screenshot = await page.screenshot();
    expect(screenshot).toMatchSnapshot('screenshot-translateZ.png');
  });

  it('should work while navigating', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/redirectloop1.html');
    for (let i = 0; i < 10; i++) {
      const screenshot = await page.screenshot({ fullPage: true }).catch(e => {
        if (e.message.includes('Cannot take a screenshot while page is navigating'))
          return Buffer.from('');
        throw e;
      });
      expect(screenshot).toBeInstanceOf(Buffer);
    }
  });

  it('should work with iframe in shadow', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid-iframe-in-shadow.html');
    expect(await page.screenshot()).toMatchSnapshot('screenshot-iframe.png');
  });

  it('path option should work', async ({ page, server }, testInfo) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const outputPath = testInfo.outputPath('screenshot.png');
    await page.screenshot({ path: outputPath });
    expect(await fs.promises.readFile(outputPath)).toMatchSnapshot('screenshot-sanity.png');
  });

  it('path option should create subdirectories', async ({ page, server }, testInfo) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const outputPath = testInfo.outputPath(path.join('these', 'are', 'directories', 'screenshot.png'));
    await page.screenshot({ path: outputPath });
    expect(await fs.promises.readFile(outputPath)).toMatchSnapshot('screenshot-sanity.png');
  });

  it('path option should detect jpeg', async ({ page, server, isElectron }, testInfo) => {
    it.fixme(isElectron, 'omitBackground with jpeg does not work');

    await page.setViewportSize({ width: 100, height: 100 });
    await page.goto(server.EMPTY_PAGE);
    const outputPath = testInfo.outputPath('screenshot.jpg');
    const screenshot = await page.screenshot({ omitBackground: true, path: outputPath });
    expect(await fs.promises.readFile(outputPath)).toMatchSnapshot('white.jpg');
    expect(screenshot).toMatchSnapshot('white.jpg');
  });

  it('path option should throw for unsupported mime type', async ({ page }) => {
    const error = await page.screenshot({ path: 'file.txt' }).catch(e => e);
    expect(error.message).toContain('path: unsupported mime type "text/plain"');
  });

  it('quality option should throw for png', async ({ page }) => {
    const error = await page.screenshot({ quality: 10 }).catch(e => e);
    expect(error.message).toContain('options.quality is unsupported for the png');
  });

  it('zero quality option should throw for png', async ({ page }) => {
    const error = await page.screenshot({ quality: 0, type: 'png' }).catch(e => e);
    expect(error.message).toContain('options.quality is unsupported for the png');
  });

  it('should prefer type over extension', async ({ page }, testInfo) => {
    const outputPath = testInfo.outputPath('file.png');
    const buffer = await page.screenshot({ path: outputPath, type: 'jpeg' });
    expect([buffer[0], buffer[1], buffer[2]]).toEqual([0xFF, 0xD8, 0xFF]);
  });

  it('should not issue resize event', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/grid.html');
    let resizeTriggered = false;
    await page.exposeFunction('resize', () => {
      resizeTriggered = true;
    });
    await page.evaluate(() => {
      window.addEventListener('resize', () => (window as any).resize());
    });
    await page.screenshot();
    expect(resizeTriggered).toBeFalsy();
  });

  it('should work with Array deleted', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    await page.evaluate(() => delete window.Array);
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot).toMatchSnapshot('screenshot-grid-fullpage.png');
  });

  it('should take fullPage screenshots during navigation', async ({ page, server }) => {
    await page.setViewportSize({ width: 500, height: 500 });
    await page.goto(server.PREFIX + '/grid.html');
    const reloadSeveralTimes = async () => {
      for (let i = 0; i < 5; ++i)
        await page.reload();
    };
    const screenshotSeveralTimes = async () => {
      for (let i = 0; i < 5; ++i)
        await page.screenshot({ fullPage: true });
    };
    await Promise.all([
      reloadSeveralTimes(),
      screenshotSeveralTimes()
    ]);
  });

  it.describe('mask option', () => {
    it('should work', async ({ page, server }) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.goto(server.PREFIX + '/grid.html');
      expect(await page.screenshot({
        mask: [ page.locator('div').nth(5) ],
      })).toMatchSnapshot('mask-should-work.png');
    });

    it('should work with locator', async ({ page, server }) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.goto(server.PREFIX + '/grid.html');
      const bodyLocator = page.locator('body');
      expect(await bodyLocator.screenshot({
        mask: [ page.locator('div').nth(5) ],
      })).toMatchSnapshot('mask-should-work-with-locator.png');
    });

    it('should work with elementhandle', async ({ page, server }) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.goto(server.PREFIX + '/grid.html');
      const bodyHandle = await page.$('body');
      expect(await bodyHandle.screenshot({
        mask: [ page.locator('div').nth(5) ],
      })).toMatchSnapshot('mask-should-work-with-elementhandle.png');
    });

    it('should mask multiple elements', async ({ page, server }) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.goto(server.PREFIX + '/grid.html');
      expect(await page.screenshot({
        mask: [
          page.locator('div').nth(5),
          page.locator('div').nth(12),
        ],
      })).toMatchSnapshot('should-mask-multiple-elements.png');
    });

    it('should mask inside iframe', async ({ page, server }) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.goto(server.PREFIX + '/grid.html');
      await attachFrame(page, 'frame1', server.PREFIX + '/grid.html');
      await page.addStyleTag({ content: 'iframe { border: none; }' });
      expect(await page.screenshot({
        mask: [
          page.locator('div').nth(5),
          page.frameLocator('#frame1').locator('div').nth(12),
        ],
      })).toMatchSnapshot('should-mask-inside-iframe.png');
    });

    it('should mask in parallel', async ({ page, server }) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await attachFrame(page, 'frame1', server.PREFIX + '/grid.html');
      await attachFrame(page, 'frame2', server.PREFIX + '/grid.html');
      await page.addStyleTag({ content: 'iframe { border: none; }' });
      const screenshots = await Promise.all([
        page.screenshot({
          mask: [ page.frameLocator('#frame1').locator('div').nth(1) ],
        }),
        page.screenshot({
          mask: [ page.frameLocator('#frame2').locator('div').nth(3) ],
        }),
      ]);
      expect(screenshots[0]).toMatchSnapshot('should-mask-in-parallel-1.png');
      expect(screenshots[1]).toMatchSnapshot('should-mask-in-parallel-2.png');
    });

    it('should remove mask after screenshot', async ({ page, server }) => {
      await page.setViewportSize({ width: 500, height: 500 });
      await page.goto(server.PREFIX + '/grid.html');
      const screenshot1 = await page.screenshot();
      await page.screenshot({
        mask: [ page.locator('div').nth(1) ],
      });
      const screenshot2 = await page.screenshot();
      expect(screenshot1.equals(screenshot2)).toBe(true);
    });
  });
});

async function rafraf(page) {
  // Do a double raf since single raf does not
  // actually guarantee a new animation frame.
  await page.evaluate(() => new Promise(x => {
    requestAnimationFrame(() => requestAnimationFrame(x));
  }));
}

declare global {
  interface Window {
    animation?: Animation;
    _EVENTS?: string[];
  }
}

it.describe('page screenshot animations', () => {
  it('should not capture infinite css animation', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/rotate-z.html');
    const div = page.locator('div');
    const screenshot = await div.screenshot({
      animations: 'disabled',
    });
    for (let i = 0; i < 10; ++i) {
      await rafraf(page);
      const newScreenshot = await div.screenshot({
        animations: 'disabled',
      });
      expect(newScreenshot.equals(screenshot)).toBe(true);
    }
  });

  it('should not capture pseudo element css animation', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/rotate-pseudo.html');
    const div = page.locator('div');
    const screenshot = await div.screenshot({
      animations: 'disabled',
    });
    for (let i = 0; i < 10; ++i) {
      await rafraf(page);
      const newScreenshot = await div.screenshot({
        animations: 'disabled',
      });
      expect(newScreenshot.equals(screenshot)).toBe(true);
    }
  });

  it('should not capture css animations in shadow DOM', async ({ page, server, isAndroid }) => {
    it.skip(isAndroid, 'Different viewport');
    await page.goto(server.PREFIX + '/rotate-z-shadow-dom.html');
    const screenshot = await page.screenshot({
      animations: 'disabled',
    });
    for (let i = 0; i < 4; ++i) {
      await rafraf(page);
      const newScreenshot = await page.screenshot({
        animations: 'disabled',
      });
      expect(newScreenshot.equals(screenshot)).toBe(true);
    }
  });

  it('should stop animations that happen right before screenshot', async ({ page, server, mode, isAndroid }) => {
    it.skip(mode !== 'default');
    it.skip(isAndroid, 'Different viewport');
    await page.goto(server.PREFIX + '/rotate-z.html');
    // Stop rotating bar.
    await page.$eval('div', el => el.style.setProperty('animation', 'none'));
    const buffer1 = await page.screenshot({
      animations: 'disabled',
      // Start rotating bar right before screenshot.
      __testHookBeforeScreenshot: async () => {
        await page.$eval('div', el => el.style.removeProperty('animation'));
      },
    } as any);
    await rafraf(page);
    const buffer2 = await page.screenshot({
      animations: 'disabled',
    });
    expect(buffer1.equals(buffer2)).toBe(true);
  });

  it('should resume infinite animations', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/rotate-z.html');
    await page.screenshot({
      animations: 'disabled',
    });
    const buffer1 = await page.screenshot();
    await rafraf(page);
    const buffer2 = await page.screenshot();
    expect(buffer1.equals(buffer2)).toBe(false);
  });

  it('should not capture infinite web animations', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/web-animation.html');
    const div = page.locator('div');
    const screenshot = await div.screenshot({
      animations: 'disabled',
    });
    for (let i = 0; i < 10; ++i) {
      await rafraf(page);
      const newScreenshot = await div.screenshot({
        animations: 'disabled',
      });
      expect(newScreenshot.equals(screenshot)).toBe(true);
    }
    // Should resume infinite web animation.
    const buffer1 = await page.screenshot();
    await rafraf(page);
    const buffer2 = await page.screenshot();
    expect(buffer1.equals(buffer2)).toBe(false);
  });

  it('should fire transitionend for finite transitions', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/css-transition.html');
    const div = page.locator('div');
    await div.evaluate(el => {
      el.addEventListener('transitionend', () => window['__TRANSITION_END'] = true, false);
    });

    await it.step('make sure transition is actually running', async () => {
      const screenshot1 = await page.screenshot();
      await rafraf(page);
      const screenshot2 = await page.screenshot();
      expect(screenshot1.equals(screenshot2)).toBe(false);
    });

    // Make a screenshot that finishes all finite animations.
    const screenshot1 = await div.screenshot({
      animations: 'disabled',
    });
    await rafraf(page);
    // Make sure finite transition is not restarted.
    const screenshot2 = await div.screenshot({ animations: 'allow' });
    expect(screenshot1.equals(screenshot2)).toBe(true);

    expect(await page.evaluate(() => window['__TRANSITION_END'])).toBe(true);
  });

  it('should capture screenshots after layoutchanges in transitionend event', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/css-transition.html');
    const div = page.locator('div');
    await div.evaluate(el => {
      el.addEventListener('transitionend', () => {
        const time = Date.now();
        // Block main thread for 200ms, emulating heavy layout.
        while (Date.now() - time < 200) ;
        const h1 = document.createElement('h1');
        h1.textContent = 'woof-woof';
        document.body.append(h1);
      }, false);
    });

    await it.step('make sure transition is actually running', async () => {
      const screenshot1 = await page.screenshot();
      await rafraf(page);
      const screenshot2 = await page.screenshot();
      expect(screenshot1.equals(screenshot2)).toBe(false);
    });

    // 1. Make a screenshot that finishes all finite animations
    //    and triggers layout.
    const screenshot1 = await page.screenshot({
      animations: 'disabled',
    });

    // 2. Make a second screenshot after h1 is on screen.
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('h1')).toHaveText('woof-woof');
    const screenshot2 = await page.screenshot();

    // 3. Make sure both screenshots are equal, meaning that
    //    first screenshot actually was taken after transitionend
    //    changed layout.
    expect(screenshot1.equals(screenshot2)).toBe(true);
  });

  it('should not change animation with playbackRate equal to 0', async ({ page, server, isAndroid }) => {
    it.skip(isAndroid, 'Different viewport');
    await page.goto(server.PREFIX + '/rotate-z.html');
    await page.evaluate(async () => {
      window.animation = document.getAnimations()[0];
      await window.animation.ready;
      window.animation.updatePlaybackRate(0);
      await window.animation.ready;
      window.animation.currentTime = 500;
    });
    const screenshot1 = await page.screenshot({
      animations: 'disabled',
    });
    await rafraf(page);
    const screenshot2 = await page.screenshot({
      animations: 'disabled',
    });
    expect(screenshot1.equals(screenshot2)).toBe(true);
    expect(await page.evaluate(() => ({
      playbackRate: window.animation.playbackRate,
      currentTime: window.animation.currentTime,
    }))).toEqual({
      playbackRate: 0,
      currentTime: 500,
    });
  });

  it('should trigger particular events for css transitions', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/css-transition.html');
    const div = page.locator('div');
    await div.evaluate(async el => {
      window._EVENTS = [];
      el.addEventListener('transitionend', () => {
        window._EVENTS.push('transitionend');
        console.log('transitionend');
      }, false);
      const animation = el.getAnimations()[0];
      animation.oncancel = () => window._EVENTS.push('oncancel');
      animation.onfinish = () => window._EVENTS.push('onfinish');
      animation.onremove = () => window._EVENTS.push('onremove');
      await animation.ready;
    });
    await Promise.all([
      page.screenshot({ animations: 'disabled' }),
      page.waitForEvent('console', msg => msg.text() === 'transitionend'),
    ]);
    expect(await page.evaluate(() => window._EVENTS)).toEqual([
      'onfinish', 'transitionend'
    ]);
  });

  it('should trigger particular events for INfinite css animation', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/rotate-z.html');
    const div = page.locator('div');
    await div.evaluate(async el => {
      window._EVENTS = [];
      el.addEventListener('animationcancel', () => {
        window._EVENTS.push('animationcancel');
        console.log('animationcancel');
      }, false);
      const animation = el.getAnimations()[0];
      animation.oncancel = () => window._EVENTS.push('oncancel');
      animation.onfinish = () => window._EVENTS.push('onfinish');
      animation.onremove = () => window._EVENTS.push('onremove');
      await animation.ready;
    });
    await Promise.all([
      page.screenshot({ animations: 'disabled' }),
      page.waitForEvent('console', msg => msg.text() === 'animationcancel'),
    ]);
    expect(await page.evaluate(() => window._EVENTS)).toEqual([
      'oncancel', 'animationcancel'
    ]);
  });

  it('should trigger particular events for finite css animation', async ({ page, server }) => {
    await page.goto(server.PREFIX + '/rotate-z.html');
    const div = page.locator('div');
    await div.evaluate(async el => {
      window._EVENTS = [];
      // Make CSS animation to be finite.
      el.style.setProperty('animation-iteration-count', '1000');
      el.addEventListener('animationend', () => {
        window._EVENTS.push('animationend');
        console.log('animationend');
      }, false);
      const animation = el.getAnimations()[0];
      animation.oncancel = () => window._EVENTS.push('oncancel');
      animation.onfinish = () => window._EVENTS.push('onfinish');
      animation.onremove = () => window._EVENTS.push('onremove');
      await animation.ready;
    });
    // Ensure CSS animation is finite.
    expect(await div.evaluate(async el => Number.isFinite(el.getAnimations()[0].effect.getComputedTiming().endTime))).toBe(true);
    await Promise.all([
      page.screenshot({ animations: 'disabled' }),
      page.waitForEvent('console', msg => msg.text() === 'animationend'),
    ]);
    expect(await page.evaluate(() => window._EVENTS)).toEqual([
      'onfinish', 'animationend'
    ]);
  });

  it('should respect fonts option', async ({ page, server, isWindows }) => {
    it.fixme(isWindows, 'This requires a windows-specific test expectations. https://github.com/microsoft/playwright/issues/12707');
    await page.setViewportSize({ width: 500, height: 500 });
    let serverRequest, serverResponse;
    // Stall font loading.
    server.setRoute('/webfont/iconfont.woff2', (req, res) => {
      serverRequest = req;
      serverResponse = res;
    });
    await page.goto(server.PREFIX + '/webfont/webfont.html', {
      waitUntil: 'domcontentloaded', // 'load' will not happen if webfont is pending
    });
    // Make sure we can take screenshot.
    const noIconsScreenshot = await page.screenshot();
    // Make sure screenshot times out while webfont is stalled.
    const error = await page.screenshot({
      fonts: 'ready',
      timeout: 200,
    }).catch(e => e);
    expect(error.message).toContain('waiting for fonts to load...');
    expect(error.message).toContain('Timeout 200ms exceeded');
    const [iconsScreenshot] = await Promise.all([
      page.screenshot({ fonts: 'ready' }),
      server.serveFile(serverRequest, serverResponse),
    ]);
    expect(iconsScreenshot).toMatchSnapshot('screenshot-web-font.png', {
      maxDiffPixels: 3,
    });
    expect(noIconsScreenshot).not.toMatchSnapshot('screenshot-web-font.png', {
      maxDiffPixels: 3,
    });
  });

});

