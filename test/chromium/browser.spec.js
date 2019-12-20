// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const path = require('path');
const {spawn, execSync} = require('child_process');

module.exports.describe = function({testRunner, expect, defaultBrowserOptions, playwright, playwrightPath}) {
  const {describe, xdescribe, fdescribe} = testRunner;
  const {it, fit, xit, dit} = testRunner;
  const {beforeAll, beforeEach, afterAll, afterEach} = testRunner;

  describe('CRBrowser', function() {
    it('should close all belonging targets once closing context', async function({browser, newContext}) {
      const targets = async () => (await browser.targets()).filter(t => t.type() === 'page');
      expect((await targets()).length).toBe(1);

      const context = await newContext();
      await context.newPage();
      expect((await targets()).length).toBe(2);
      expect((await context.pages()).length).toBe(1);

      await context.close();
      expect((await targets()).length).toBe(1);
    });
    it('should close the browser when the node process closes', async({ server }) => {
      const options = Object.assign({}, defaultBrowserOptions, {
        // Disable DUMPIO to cleanly read stdout.
        dumpio: false,
      });
      const res = spawn('node', [path.join(__dirname, '..', 'fixtures', 'closeme.js'), playwrightPath, JSON.stringify(options)]);
      let wsEndPointCallback;
      const wsEndPointPromise = new Promise(x => wsEndPointCallback = x);
      let output = '';
      res.stdout.on('data', data => {
        output += data;
        if (output.indexOf('\n'))
          wsEndPointCallback(output.substring(0, output.indexOf('\n')));
      });
      const browser = await playwright.connect({ browserWSEndpoint: await wsEndPointPromise });
      const promises = [
        new Promise(resolve => browser.once('disconnected', resolve)),
        new Promise(resolve => res.on('close', resolve))
      ];
      if (process.platform === 'win32')
        execSync(`taskkill /pid ${res.pid} /T /F`);
      else
        process.kill(res.pid);
      await Promise.all(promises);
    });
  });
};
