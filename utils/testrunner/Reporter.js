/**
 * Copyright 2017 Google Inc. All rights reserved.
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

const fs = require('fs');
const colors = require('colors/safe');
const {MatchError} = require('./Matchers.js');

class Reporter {
  constructor(runner, options = {}) {
    const {
      showSlowTests = 3,
      showMarkedAsFailingTests = Infinity,
      verbose = false,
      summary = true,
    } = options;
    this._filePathToLines = new Map();
    this._runner = runner;
    this._showSlowTests = showSlowTests;
    this._showMarkedAsFailingTests = showMarkedAsFailingTests;
    this._verbose = verbose;
    this._summary = summary;
    this._testCounter = 0;
    runner.on('started', this._onStarted.bind(this));
    runner.on('finished', this._onFinished.bind(this));
    runner.on('teststarted', this._onTestStarted.bind(this));
    runner.on('testfinished', this._onTestFinished.bind(this));
  }

  _onStarted(runnableTests) {
    this._testCounter = 0;
    this._timestamp = Date.now();
    const allTests = this._runner.tests();
    if (allTests.length === runnableTests.length) {
      console.log(`Running all ${colors.yellow(runnableTests.length)} tests on ${colors.yellow(this._runner.parallel())} worker${this._runner.parallel() > 1 ? 's' : ''}:\n`);
    } else {
      console.log(`Running ${colors.yellow(runnableTests.length)} focused tests out of total ${colors.yellow(allTests.length)} on ${colors.yellow(this._runner.parallel())} worker${this._runner.parallel() > 1 ? 's' : ''}`);
      console.log('');
      const focusedSuites = this._runner.focusedSuites().map(suite => ({
        id: suite.location.filePath + ':' + suite.location.lineNumber + ':' + suite.location.columnNumber,
        fullName: suite.fullName,
        location: suite.location,
      }));
      const focusedTests = this._runner.focusedTests().map(test => ({
        id: test.location.filePath + ':' + test.location.lineNumber + ':' + test.location.columnNumber,
        fullName: test.fullName,
        location: test.location,
      }));
      const focusedEntities = new Map([
        ...focusedSuites.map(suite => ([suite.id, suite])),
        ...focusedTests.map(test => ([test.id, test])),
      ]);
      if (focusedEntities.size) {
        console.log('Focused Suites and Tests:');
        const entities = [...focusedEntities.values()];
        for (let i = 0; i < entities.length; ++i)
          console.log(`  ${i + 1}) ${entities[i].fullName} (${formatLocation(entities[i].location)})`);
        console.log('');
      }
    }
  }

  _printFailedResult(result) {
    console.log(colors.red(`## ${result.result.toUpperCase()} ##`));
    if (result.message) {
      console.log('Message:');
      console.log(`  ${colors.red(result.message)}`);
    }

    for (let i = 0; i < result.errors.length; i++) {
      const { message, error, workerId, tests } = result.errors[i];
      console.log(`\n${colors.magenta('NON-TEST ERROR #' + i)}: ${message}`);
      if (error && error.stack)
        console.log(padLines(error.stack, 2));
      const lastTests = tests.slice(tests.length - Math.min(10, tests.length));
      if (lastTests.length)
        console.log(`WORKER STATE`);
      for (let j = 0; j < lastTests.length; j++)
        this._printVerboseTestResult(j, lastTests[j], workerId);
    }
    console.log('');
    console.log('');
  }

  _onFinished(result) {
    this._printTestResults();
    if (!result.ok())
      this._printFailedResult(result);
    process.exitCode = result.exitCode;
  }

  _printTestResults() {
    // 2 newlines after completing all tests.
    console.log('\n');

    const failedTests = this._runner.failedTests();
    if (this._summary && failedTests.length > 0) {
      console.log('\nFailures:');
      for (let i = 0; i < failedTests.length; ++i) {
        const test = failedTests[i];
        this._printVerboseTestResult(i + 1, test);
        console.log('');
      }
    }

    const skippedTests = this._runner.skippedTests();
    const markedAsFailingTests = this._runner.markedAsFailingTests();
    if (this._showMarkedAsFailingTests && this._summary && markedAsFailingTests.length) {
      if (markedAsFailingTests.length > 0) {
        console.log('\nMarked as failing:');
        markedAsFailingTests.slice(0, this._showMarkedAsFailingTests).forEach((test, index) => {
          console.log(`${index + 1}) ${test.fullName} (${formatLocation(test.location)})`);
        });
      }
      if (this._showMarkedAsFailingTests < markedAsFailingTests.length) {
        console.log('');
        console.log(`... and ${colors.yellow(markedAsFailingTests.length - this._showMarkedAsFailingTests)} more marked as failing tests ...`);
      }
    }

    if (this._showSlowTests) {
      const slowTests = this._runner.passedTests().sort((a, b) => {
        const aDuration = a.endTimestamp - a.startTimestamp;
        const bDuration = b.endTimestamp - b.startTimestamp;
        return bDuration - aDuration;
      }).slice(0, this._showSlowTests);
      console.log(`\nSlowest tests:`);
      for (let i = 0; i < slowTests.length; ++i) {
        const test = slowTests[i];
        const duration = test.endTimestamp - test.startTimestamp;
        console.log(`  (${i + 1}) ${colors.yellow((duration / 1000) + 's')} - ${test.fullName} (${formatLocation(test.location)})`);
      }
    }

    const tests = this._runner.tests();
    const executedTests = tests.filter(test => test.result);
    const okTestsLength = executedTests.length - failedTests.length - markedAsFailingTests.length - skippedTests.length;
    let summaryText = '';
    if (failedTests.length || markedAsFailingTests.length) {
      const summary = [`ok - ${colors.green(okTestsLength)}`];
      if (failedTests.length)
        summary.push(`failed - ${colors.red(failedTests.length)}`);
      if (markedAsFailingTests.length)
        summary.push(`marked as failing - ${colors.yellow(markedAsFailingTests.length)}`);
      if (skippedTests.length)
        summary.push(`skipped - ${colors.yellow(skippedTests.length)}`);
      summaryText = ` (${summary.join(', ')})`;
    }

    console.log(`\nRan ${executedTests.length}${summaryText} of ${tests.length} test${tests.length > 1 ? 's' : ''}`);
    const milliseconds = Date.now() - this._timestamp;
    const seconds = milliseconds / 1000;
    console.log(`Finished in ${colors.yellow(seconds)} seconds`);
  }

  _onTestStarted(test, workerId) {
  }

  _onTestFinished(test, workerId) {
    if (this._verbose) {
      ++this._testCounter;
      this._printVerboseTestResult(this._testCounter, test, workerId);
    } else {
      if (test.result === 'ok')
        process.stdout.write(colors.green('\u00B7'));
      else if (test.result === 'skipped')
        process.stdout.write(colors.yellow('\u00B7'));
      else if (test.result === 'markedAsFailing')
        process.stdout.write(colors.yellow('\u00D7'));
      else if (test.result === 'failed')
        process.stdout.write(colors.red('F'));
      else if (test.result === 'crashed')
        process.stdout.write(colors.red('C'));
      else if (test.result === 'terminated')
        process.stdout.write(colors.magenta('.'));
      else if (test.result === 'timedout')
        process.stdout.write(colors.red('T'));
    }
  }

  _printVerboseTestResult(resultIndex, test, workerId = undefined) {
    let prefix = `${resultIndex})`;
    if (this._runner.parallel() > 1 && workerId !== undefined)
      prefix += ' ' + colors.gray(`[worker = ${workerId}]`);
    if (test.result === 'ok') {
      console.log(`${prefix} ${colors.green('[OK]')} ${test.fullName} (${formatLocation(test.location)})`);
    } else if (test.result === 'terminated') {
      console.log(`${prefix} ${colors.magenta('[TERMINATED]')} ${test.fullName} (${formatLocation(test.location)})`);
    } else if (test.result === 'crashed') {
      console.log(`${prefix} ${colors.red('[CRASHED]')} ${test.fullName} (${formatLocation(test.location)})`);
    } else if (test.result === 'skipped') {
    } else if (test.result === 'markedAsFailing') {
      console.log(`${prefix} ${colors.yellow('[MARKED AS FAILING]')} ${test.fullName} (${formatLocation(test.location)})`);
    } else if (test.result === 'timedout') {
      console.log(`${prefix} ${colors.red(`[TIMEOUT ${test.timeout}ms]`)} ${test.fullName} (${formatLocation(test.location)})`);
      if (test.output) {
        console.log('  Output:');
        for (const line of test.output)
          console.log('  ' + line);
      }
    } else if (test.result === 'failed') {
      console.log(`${prefix} ${colors.red('[FAIL]')} ${test.fullName} (${formatLocation(test.location)})`);
      if (test.error instanceof MatchError) {
        let lines = this._filePathToLines.get(test.error.location.filePath);
        if (!lines) {
          try {
            lines = fs.readFileSync(test.error.location.filePath, 'utf8').split('\n');
          } catch (e) {
            lines = [];
          }
          this._filePathToLines.set(test.error.location.filePath, lines);
        }
        const lineNumber = test.error.location.lineNumber;
        if (lineNumber < lines.length) {
          const lineNumberLength = (lineNumber + 1 + '').length;
          const FROM = Math.max(test.location.lineNumber - 1, lineNumber - 5);
          const snippet = lines.slice(FROM, lineNumber).map((line, index) => `    ${(FROM + index + 1 + '').padStart(lineNumberLength, ' ')} | ${line}`).join('\n');
          const pointer = `    ` + ' '.repeat(lineNumberLength) + '   ' + '~'.repeat(test.error.location.columnNumber - 1) + '^';
          console.log('\n' + snippet + '\n' + colors.grey(pointer) + '\n');
        }
        console.log(padLines(test.error.formatter(), 4));
        console.log('');
      } else {
        console.log('  Message:');
        let message = '' + (test.error.message || test.error);
        if (test.error.stack && message.includes(test.error.stack))
          message = message.substring(0, message.indexOf(test.error.stack));
        if (message)
          console.log(`    ${colors.red(message)}`);
        if (test.error.stack) {
          console.log('  Stack:');
          let stack = test.error.stack;
          // Highlight first test location, if any.
          const match = stack.match(new RegExp(test.location.filePath + ':(\\d+):(\\d+)'));
          if (match) {
            const [, line, column] = match;
            const fileName = `${test.location.fileName}:${line}:${column}`;
            stack = stack.substring(0, match.index) + stack.substring(match.index).replace(fileName, colors.yellow(fileName));
          }
          console.log(padLines(stack, 4));
        }
      }
      if (test.output) {
        console.log('  Output:');
        for (const line of test.output)
          console.log('  ' + line);
      }
    }
  }
}

function formatLocation(location) {
  if (!location)
    return '';
  return colors.yellow(`${location.fileName}:${location.lineNumber}:${location.columnNumber}`);
}

function padLines(text, spaces = 0) {
  const indent = ' '.repeat(spaces);
  return text.split('\n').map(line => indent + line).join('\n');
}

module.exports = Reporter;
