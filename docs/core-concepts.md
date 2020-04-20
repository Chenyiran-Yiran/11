# Core concepts

Playwright provides a set of APIs to automate Chromium, Firefox and WebKit
browsers. By using the Playwright API, you can write JavaScript code to create
new browser pages, navigate to URLs and then interact with elements on a page.

Along with a test runner Playwright can be used to automate user interactions to
validate and test web applications. The Playwright API enables this through
the following primitives.

#### Contents
  - [Browser](#browser)
  - [Browser contexts](#browser-contexts)
  - [Pages and frames](#pages-and-frames)
  - [Selectors](#selectors)
  - [Auto-waiting](#auto-waiting)
  - [Execution contexts](#execution-contexts)
  - [Object & element handles](#object--element-handles)

<br/>

## Browser

A [`Browser`](../api.md#class-browser) refers to an instance of Chromium, Firefox
or WebKit. Playwright scripts generally start with launching a browser instance
and end with closing the browser. Browser instances can be launched in headless
(without a GUI) or headful mode.

```js
const { chromium } = require('playwright');  // Or 'firefox' or 'webkit'.

const browser = await chromium.launch({ headless: false });
await browser.close();
```

Launching a browser instance can be expensive, and Playwright is designed to
maximize what a single instance can do through multiple browser contexts.

<br/>

## Browser contexts

A [`BrowserContext`](../api.md#class-browsercontext) is an isolated incognito-alike
session within a browser instance. Browser contexts are fast and cheap to create.
Browser contexts can be used to parallelize isolated test executions.

```js
const browser = await chromium.launch();
const context = await browser.newContext();
```

Browser contexts can also be used to emulate multi-page scenarios involving
mobile devices, permissions, locale and color scheme. 

```js
const { devices } = require('playwright');
const iPhone = devices['iPhone 11 Pro'];

const context = await browser.newContext({
  ...iPhone,
  permissions: ['geolocation'],
  geolocation: { latitude: 52.52, longitude: 13.39},
  colorScheme: 'dark',
  locale: 'de-DE'
});
```

<br/>

## Pages and frames

A Browser context can have multiple pages. A [`Page`](../api.md#class-page)
refers to a single tab or a popup window within a browser context. A page can be used to navigate
to URLs and then interact with elements.

```js
const page = await context.newPage();
await page.goto('http://example.com');
await page.click('#submit');
```

A page can have one or more [Frame](../api.md#class-frame) objects attached to
it. Each page has a main frame and page-level interactions (like `click`) are
assumed to operate in the main frame.

A page can have additional frames attached with the `iframe` HTML tag. These
frames can be accessed for interactions inside the frame.

```js
// To interact with elements in an iframe
const frame = page.frame('frame-name');
await frame.fill('#username-input');
```

<br/>

## Selectors

<br/>

## Auto-waiting

<br/>

## Execution contexts

Playwright scripts run in your Node.js environment. You page scripts run in the page environment. Those environments don't intersect, they are running in different virtual machines in different processes and potentially on different computers.

IMAGE PLACEHOLDER

The [`page.evaluate`](https://github.com/microsoft/playwright/blob/master/docs/api.md#pageevaluatepagefunction-arg) API can run a JavaScript function in the context
of the web page and bring results back to the Node.js environment. Globals like
`window` and `document` along with the web page runtime can be used in `evaluate`.

Right:

```js
const data = { text: 'some data', value: 1 };
// Pass |data| as a parameter.
const result = await page.evaluate(data => {
  window.myApp.use(data);
}, data);
```

Wrong:

```js
const data = { text: 'some data', value: 1 };
const result = await page.evaluate(() => {
  // There is no |data| in the web page.
  window.myApp.use(data);
});
```

Evaluation parameters are serialized and sent into your web page over the wire.
You can pass primitive types, JSON-alike objects and remote object handles received from the page.

<br/>

## Object & element handles

<br/>

