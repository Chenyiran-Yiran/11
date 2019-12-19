const path = require('path');
const fs = require('fs');
const playwright = require('../..');
const {TestServer} = require('../testserver/');
const {TestRunner, Reporter, Matchers} = require('../testrunner/');

const playwrightWebPath = path.join(__dirname, 'playwright-web.js');
if (!fs.existsSync(playwrightWebPath))
  throw new Error(`playwright-web is not built; run "npm run bundle"`);
const playwrightWeb = fs.readFileSync(playwrightWebPath, 'utf8');

const testRunner = new TestRunner();
const {describe, fdescribe, xdescribe} = testRunner;
const {it, xit, fit} = testRunner;
const {afterAll, beforeAll, afterEach, beforeEach} = testRunner;
const {expect} = new Matchers();

beforeAll(async state => {
  const assetsPath = path.join(__dirname, '..', '..', 'test', 'assets');
  const port = 8998;
  state.server = await TestServer.create(assetsPath, port);
  state.serverConfig = {
    PREFIX: `http://localhost:${port}`,
    EMPTY_PAGE: `http://localhost:${port}/empty.html`,
  };
  state.browser = await playwright.launch();
});

afterAll(async state => {
  await Promise.all([
    state.server.stop(),
    state.browser.close()
  ]);
  state.browser = null;
  state.server = null;
});

beforeEach(async state => {
  state.page = await state.browser.defaultContext().newPage();
  await state.page.evaluateOnNewDocument(playwrightWeb);
  await state.page.addScriptTag({
    content: playwrightWeb + '\n//# sourceURL=playwright-web.js'
  });
});

afterEach(async state => {
  await state.page.close();
  state.page = null;
});

describe('Playwright-Web', () => {
  it('should work over web socket', async({page, serverConfig}) => {
    const browserServer = await playwright.launchServer();
    // Use in-page playwright to create a new page and navigate it to the EMPTY_PAGE
    await page.evaluate(async(browserWSEndpoint, serverConfig) => {
      const playwright = require('playwright');
      const browser = await playwright.connect({browserWSEndpoint});
      const page = await browser.defaultContext().newPage();
      await page.goto(serverConfig.EMPTY_PAGE);
    }, browserServer.wsEndpoint(), serverConfig);
    const browser = await browserServer.connect();
    const pageURLs = (await browser.defaultContext().pages()).map(page => page.url()).sort();
    expect(pageURLs).toEqual([
      'about:blank',
      serverConfig.EMPTY_PAGE
    ]);
    await browserServer.close();
  });
  it('should work over exposed DevTools protocol', async({browser, page, serverConfig}) => {
    // Expose devtools protocol binding into page.
    const session = await browser.browserTarget().createCDPSession();
    const pageInfo = (await session.send('Target.getTargets')).targetInfos.find(info => info.attached);
    await session.send('Target.exposeDevToolsProtocol', {targetId: pageInfo.targetId});
    await session.detach();

    // Use in-page playwright to create a new page and navigate it to the EMPTY_PAGE
    await page.evaluate(async serverConfig  => {
      const playwright = require('playwright');
      window.cdp.close = () => {};
      const browser = await playwright.connect({transport: window.cdp});
      const page = await browser.defaultContext().newPage();
      await page.goto(serverConfig.EMPTY_PAGE);
    }, serverConfig);
    const pageURLs = (await browser.defaultContext().pages()).map(page => page.url()).sort();
    expect(pageURLs).toEqual([
      'about:blank',
      'about:blank',
      serverConfig.EMPTY_PAGE
    ]);
  });
});

if (process.env.CI && testRunner.hasFocusedTestsOrSuites()) {
  console.error('ERROR: "focused" tests/suites are prohibitted on bots. Remove any "fit"/"fdescribe" declarations.');
  process.exit(1);
}

new Reporter(testRunner);
testRunner.run();
