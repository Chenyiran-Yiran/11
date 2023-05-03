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

import { test, expect } from './playwright-test-fixtures';

const stepHierarchyReporter = `
class Reporter {
  onBegin(config: FullConfig, suite: Suite) {
    this.suite = suite;
  }

  distillStep(step) {
    return {
      ...step,
      startTime: undefined,
      duration: undefined,
      parent: undefined,
      data: undefined,
      location: step.location ? {
        file: step.location.file.substring(step.location.file.lastIndexOf(require('path').sep) + 1).replace('.js', '.ts'),
        line: step.location.line ? typeof step.location.line : 0,
        column: step.location.column ? typeof step.location.column : 0
      } : undefined,
      steps: step.steps.length ? step.steps.map(s => this.distillStep(s)) : undefined,
      error: step.error ? '<error>' : undefined,
    };
  }

  onStdOut(data) {
    process.stdout.write(data.toString());
  }

  onStdErr(data) {
    process.stderr.write(data.toString());
  }

  async onEnd() {
    const processSuite = (suite: Suite) => {
      for (const child of suite.suites)
        processSuite(child);
      for (const test of suite.tests) {
        for (const result of test.results) {
          for (const step of result.steps) {
            console.log('%% ' + JSON.stringify(this.distillStep(step)));
          }
        }
      }
    };
    processSuite(this.suite);
  }
}
module.exports = Reporter;
`;

test('should report api step hierarchy', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('pass', async ({ page }) => {
        await test.step('outer step 1', async () => {
          await test.step('inner step 1.1', async () => {});
          await test.step('inner step 1.2', async () => {});
        });
        await test.step('outer step 2', async () => {
          await test.step('inner step 2.1', async () => {});
          await test.step('inner step 2.2', async () => {});
        });
      });
    `
  }, { reporter: '', workers: 1 });

  expect(result.exitCode).toBe(0);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    {
      category: 'hook',
      title: 'Before Hooks',
      steps: [
        {
          category: 'pw:api',
          title: 'browserType.launch',
        },
        {
          category: 'pw:api',
          title: 'browser.newContext',
        },
        {
          category: 'pw:api',
          title: 'browserContext.newPage',
        },
      ],
    },
    {
      category: 'test.step',
      title: 'outer step 1',
      location: {
        column: 'number',
        file: 'a.test.ts',
        line: 'number',
      },
      steps: [
        {
          category: 'test.step',
          location: {
            column: 'number',
            file: 'a.test.ts',
            line: 'number',
          },
          title: 'inner step 1.1',
        },
        {
          category: 'test.step',
          location: {
            column: 'number',
            file: 'a.test.ts',
            line: 'number',
          },
          title: 'inner step 1.2',
        },
      ],
    },
    {
      category: 'test.step',
      title: 'outer step 2',
      location: {
        column: 'number',
        file: 'a.test.ts',
        line: 'number',
      },
      steps: [
        {
          category: 'test.step',
          location: {
            column: 'number',
            file: 'a.test.ts',
            line: 'number',
          },
          title: 'inner step 2.1',
        },
        {
          category: 'test.step',
          location: {
            column: 'number',
            file: 'a.test.ts',
            line: 'number',
          },
          title: 'inner step 2.2',
        },
      ],
    },
    {
      category: 'hook',
      title: 'After Hooks',
      steps: [
        {
          category: 'pw:api',
          title: 'browserContext.close',
        },
      ],
    },
  ]);
});

test('should report before hooks step error', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test.beforeEach(async ({}) => {
        throw new Error('oh my');
      });
      test('pass', async ({}) => {
      });
    `
  }, { reporter: '', workers: 1 });

  expect(result.exitCode).toBe(1);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    {
      category: 'hook',
      title: 'Before Hooks',
      error: '<error>',
      steps: [
        {
          category: 'hook',
          title: 'beforeEach hook',
          error: '<error>',
          location: {
            column: 'number',
            file: 'a.test.ts',
            line: 'number',
          },
        }
      ],
    },
    {
      category: 'hook',
      title: 'After Hooks',
    },
  ]);
});

test('should not report nested after hooks', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('timeout', async ({ page }) => {
        await test.step('my step', async () => {
          await new Promise(() => {});
        });
      });
    `
  }, { reporter: '', workers: 1, timeout: 2000 });

  expect(result.exitCode).toBe(1);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    {
      category: 'hook',
      title: 'Before Hooks',
      steps: [
        {
          category: 'pw:api',
          title: 'browserType.launch',
        },
        {
          category: 'pw:api',
          title: 'browser.newContext',
        },
        {
          category: 'pw:api',
          title: 'browserContext.newPage',
        },
      ],
    },
    {
      category: 'test.step',
      title: 'my step',
      location: {
        column: 'number',
        file: 'a.test.ts',
        line: 'number',
      },
    },
    {
      category: 'hook',
      title: 'After Hooks',
      steps: [
        {
          category: 'pw:api',
          title: 'browserContext.close',
        },
        {
          category: 'pw:api',
          title: 'browser.close',
        },
      ],
    },
  ]);
});

test('should report test.step from fixtures', async ({ runInlineTest }) => {
  const expectReporterJS = `
    class Reporter {
      onStepBegin(test, result, step) {
        console.log('%% begin ' + step.title);
      }
      onStepEnd(test, result, step) {
        console.log('%% end ' + step.title);
      }
    }
    module.exports = Reporter;
  `;

  const result = await runInlineTest({
    'reporter.ts': expectReporterJS,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      const test = base.extend({
        foo: async ({}, use) => {
          await base.step('setup foo', () => {});
          await use(async () => {
            await test.step('inside foo', () => {});
          });
          await test.step('teardown foo', () => {});
        },
      });
      test('pass', async ({ foo }) => {
        await test.step('test step', async () => {
          await foo();
        });
      });
    `
  }, { reporter: '', workers: 1 });

  expect(result.exitCode).toBe(0);
  expect(result.outputLines).toEqual([
    `begin Before Hooks`,
    `begin setup foo`,
    `end setup foo`,
    `end Before Hooks`,
    `begin test step`,
    `begin inside foo`,
    `end inside foo`,
    `end test step`,
    `begin After Hooks`,
    `begin teardown foo`,
    `end teardown foo`,
    `end After Hooks`,
  ]);
});

test('should report expect step locations', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('pass', async ({ page }) => {
        expect(true).toBeTruthy();
      });
    `
  }, { reporter: '', workers: 1 });

  expect(result.exitCode).toBe(0);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    {
      category: 'hook',
      title: 'Before Hooks',
      steps: [
        {
          category: 'pw:api',
          title: 'browserType.launch',
        },
        {
          category: 'pw:api',
          title: 'browser.newContext',
        },
        {
          category: 'pw:api',
          title: 'browserContext.newPage',
        },
      ],
    },
    {
      category: 'expect',
      title: 'expect.toBeTruthy',
      location: {
        column: 'number',
        file: 'a.test.ts',
        line: 'number',
      },
    },
    {
      category: 'hook',
      title: 'After Hooks',
      steps: [
        {
          category: 'pw:api',
          title: 'browserContext.close',
        },
      ],
    },
  ]);
});

test('should report custom expect steps', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      expect.extend({
        toBeWithinRange(received, floor, ceiling) {
          const pass = received >= floor && received <= ceiling;
          if (pass) {
            return {
              message: () =>
                "expected " + received + " not to be within range " + floor + " - " + ceiling,
              pass: true,
            };
          } else {
            return {
              message: () =>
                "expected " + received + " to be within range " + floor + " - " + ceiling,
              pass: false,
            };
          }
        },
      });

      import { test, expect } from '@playwright/test';
      test('pass', async ({}) => {
        expect(15).toBeWithinRange(10, 20);
      });
    `
  }, { reporter: '', workers: 1 });

  expect(result.exitCode).toBe(0);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    {
      category: 'hook',
      title: 'Before Hooks',
    },
    {
      category: 'expect',
      location: {
        column: 'number',
        file: 'a.test.ts',
        line: 'number',
      },
      title: 'expect.toBeWithinRange',
    },
    {
      category: 'hook',
      title: 'After Hooks',
    },
  ]);
});

test('should not pass arguments and return value from step', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('steps with return values', async ({ page }) => {
        const v1 = await test.step('my step', (...args) => {
          expect(args.length).toBe(0);
          return 10;
        });
        console.log('v1 = ' + v1);
        const v2 = await test.step('my step', async (...args) => {
          expect(args.length).toBe(0);
          return new Promise(f => setTimeout(() => f(v1 + 10), 100));
        });
        console.log('v2 = ' + v2);
      });
    `
  }, { reporter: '', workers: 1 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(1);
  expect(result.output).toContain('v1 = 10');
  expect(result.output).toContain('v2 = 20');
});

test('should mark step as failed when soft expect fails', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('pass', async ({}) => {
        await test.step('outer', async () => {
          await test.step('inner', async () => {
            expect.soft(1).toBe(2);
          });
        });
        await test.step('passing', () => {});
      });
    `
  }, { reporter: '', workers: 1 });

  expect(result.exitCode).toBe(1);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    { title: 'Before Hooks', category: 'hook' },
    {
      title: 'outer',
      category: 'test.step',
      error: '<error>',
      steps: [{
        title: 'inner',
        category: 'test.step',
        error: '<error>',
        steps: [
          {
            title: 'expect.soft.toBe',
            category: 'expect',
            location: { file: 'a.test.ts', line: 'number', column: 'number' },
            error: '<error>'
          }
        ],
        location: { file: 'a.test.ts', line: 'number', column: 'number' }
      }],
      location: { file: 'a.test.ts', line: 'number', column: 'number' }
    },
    {
      title: 'passing',
      category: 'test.step',
      location: { file: 'a.test.ts', line: 'number', column: 'number' }
    },
    { title: 'After Hooks', category: 'hook' }
  ]);
});

test('should nest steps based on zones', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test.beforeAll(async () => {
        await test.step('in beforeAll', () => {});
      });

      test.afterAll(async () => {
        await test.step('in afterAll', () => {});
      });

      test.beforeEach(async () => {
        await test.step('in beforeEach', () => {});
      });

      test.afterEach(async () => {
        await test.step('in afterEach', () => {});
      });

      test.only('foo', async ({ page }) => {
        await test.step('grand', async () => {
          await Promise.all([
            test.step('parent1', async () => {
              await test.step('child1', async () => {
                await page.click('body');
              });
            }),
            test.step('parent2', async () => {
              await test.step('child2', async () => {
                await expect(page.locator('body')).toBeVisible();
              });
            }),
          ]);
        });
      });
    `
  }, { reporter: '', workers: 1 });

  expect(result.exitCode).toBe(0);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    {
      title: 'Before Hooks',
      category: 'hook',
      steps: [
        {
          title: 'beforeAll hook',
          category: 'hook',
          steps: [
            {
              title: 'in beforeAll',
              category: 'test.step',
              location: { file: 'a.test.ts', line: 'number', column: 'number' }
            }
          ],
          location: { file: 'a.test.ts', line: 'number', column: 'number' }
        },
        {
          title: 'beforeEach hook',
          category: 'hook',
          steps: [
            {
              title: 'in beforeEach',
              category: 'test.step',
              location: { file: 'a.test.ts', line: 'number', column: 'number' }
            }
          ],
          location: { file: 'a.test.ts', line: 'number', column: 'number' }
        },
        {
          title: 'browserType.launch',
          category: 'pw:api'
        },
        {
          category: 'pw:api',
          title: 'browser.newContext',
        },
        {
          title: 'browserContext.newPage',
          category: 'pw:api'
        }
      ]
    },
    {
      title: 'grand',
      category: 'test.step',
      steps: [
        {
          title: 'parent1',
          category: 'test.step',
          steps: [
            {
              title: 'child1',
              category: 'test.step',
              location: { file: 'a.test.ts', line: 'number', column: 'number' },
              steps: [
                {
                  title: 'page.click(body)',
                  category: 'pw:api',
                  location: { file: 'a.test.ts', line: 'number', column: 'number' }
                }
              ]
            }
          ],
          location: {
            file: 'a.test.ts',
            line: 'number',
            column: 'number'
          }
        },
        {
          title: 'parent2',
          category: 'test.step',
          steps: [
            {
              title: 'child2',
              category: 'test.step',
              location: { file: 'a.test.ts', line: 'number', column: 'number' },
              steps: [
                {
                  title: 'expect.toBeVisible',
                  category: 'expect',
                  location: { file: 'a.test.ts', line: 'number', column: 'number' }
                }
              ]
            }
          ],
          location: { file: 'a.test.ts', line: 'number', column: 'number' }
        }
      ],
      location: {
        file: 'a.test.ts',
        line: 'number',
        column: 'number'
      }
    },
    {
      title: 'After Hooks',
      category: 'hook',
      steps: [
        {
          title: 'afterEach hook',
          category: 'hook',
          steps: [
            {
              title: 'in afterEach',
              category: 'test.step',
              location: { file: 'a.test.ts', line: 'number', column: 'number' }
            }
          ],
          location: { file: 'a.test.ts', line: 'number', column: 'number' }
        },
        {
          title: 'browserContext.close',
          category: 'pw:api'
        },
        {
          title: 'afterAll hook',
          category: 'hook',
          steps: [
            {
              title: 'in afterAll',
              category: 'test.step',
              location: { file: 'a.test.ts', line: 'number', column: 'number' }
            }
          ],
          location: { file: 'a.test.ts', line: 'number', column: 'number' }
        },
      ]
    }
  ]);
});

test('should not mark page.close as failed when page.click fails', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `
      module.exports = {
        reporter: './reporter',
      };
    `,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      let page: Page;

      test.beforeAll(async ({ browser }) => {
        page = await browser.newPage();
      });

      test.afterAll(async () => {
        await page.close();
      });

      test('fails', async () => {
        test.setTimeout(2000);
        await page.setContent('hello');
        await page.click('div');
      });
    `
  }, { reporter: '' });

  expect(result.exitCode).toBe(1);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    {
      category: 'hook',
      title: 'Before Hooks',
      steps: [
        {
          category: 'hook',
          title: 'beforeAll hook',
          location: {
            column: 'number',
            file: 'a.test.ts',
            line: 'number',
          },
          steps: [
            {
              category: 'pw:api',
              title: 'browserType.launch',
            },
            {
              category: 'pw:api',
              title: 'browser.newPage',
              location: {
                column: 'number',
                file: 'a.test.ts',
                line: 'number',
              },
            },
          ],
        },
      ],
    },
    {
      category: 'pw:api',
      title: 'page.setContent',
      location: {
        column: 'number',
        file: 'a.test.ts',
        line: 'number',
      },
    },
    {
      category: 'pw:api',
      title: 'page.click(div)',
      location: {
        column: 'number',
        file: 'a.test.ts',
        line: 'number',
      },
      error: '<error>',
    },

    {
      category: 'hook',
      title: 'After Hooks',
      steps: [
        {
          category: 'hook',
          title: 'afterAll hook',
          location: {
            column: 'number',
            file: 'a.test.ts',
            line: 'number',
          },
          steps: [
            {
              category: 'pw:api',
              title: 'page.close',
              location: {
                column: 'number',
                file: 'a.test.ts',
                line: 'number',
              },
            },
          ],
        },
        {
          category: 'pw:api',
          title: 'browser.close',
        },
      ],
    },
  ]);
});

test('should nest page.continue insize page.goto steps', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'reporter.ts': stepHierarchyReporter,
    'playwright.config.ts': `module.exports = { reporter: './reporter', };`,
    'a.test.ts': `
      import { test, expect } from '@playwright/test';
      test('pass', async ({ page }) => {
        await page.route('**/*', route => route.fulfill('<html></html>'));
        await page.goto('http://localhost:1234');
      });
    `
  }, { reporter: '' });

  expect(result.exitCode).toBe(0);
  const objects = result.outputLines.map(line => JSON.parse(line));
  expect(objects).toEqual([
    {
      title: 'Before Hooks',
      category: 'hook',
      steps: [
        { title: 'browserType.launch', category: 'pw:api' },
        { title: 'browser.newContext', category: 'pw:api' },
        { title: 'browserContext.newPage', category: 'pw:api' },
      ],
    },
    {
      title: 'page.route',
      category: 'pw:api',
      location: { file: 'a.test.ts', line: 'number', column: 'number' },
    },
    {
      title: 'page.goto(http://localhost:1234)',
      category: 'pw:api',
      location: { file: 'a.test.ts', line: 'number', column: 'number' },
      steps: [
        {
          title: 'route.fulfill',
          category: 'pw:api',
          location: { file: 'a.test.ts', line: 'number', column: 'number' },
        },
      ]
    },
    {
      title: 'After Hooks',
      category: 'hook',
      steps: [
        { title: 'browserContext.close', category: 'pw:api' },
      ],
    },
  ]);
});
