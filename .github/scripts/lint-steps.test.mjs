import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintRepository, lintSource, nonAsciiOutsideHoles } from './lint-steps.mjs';

const path = 'tests/steps/common/fixture.steps.ts';
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The reported lines and rules of a fixture. */
function findings(source) {
  return lintSource({ path, source }).map(({ line, rule }) => ({ line, rule }));
}

describe('nonAsciiOutsideHoles', () => {
  it('should find no character in an English expression with holes, alternatives and optional text', () => {
    assert.deepEqual(nonAsciiOutsideHoles('the {string} header is/was {int} byte(s)'), []);
  });

  it('should leave the name inside a hole alone', () => {
    assert.deepEqual(nonAsciiOutsideHoles('the status is {ステータス}'), []);
  });

  it('should find the characters outside the holes, an escaped one included', () => {
    assert.deepEqual(nonAsciiOutsideHoles('HTTP ステータス {int}'), ['ス', 'テ', 'ー', 'タ', 'ス']);
    assert.deepEqual(nonAsciiOutsideHoles('the \\{é} brace'), ['é']);
  });
});

describe('step definitions', () => {
  it('should accept Cucumber Expressions written as single-quoted literals on one line', () => {
    const source = `const { Given, When, Then, Step } = createBdd(test);
Given('a registered confidential client:', async ({ op }, table) => {});
When('the client {string} redeems the authorization code {string} without {word}', async () => {});
Then('the body has a(n) {word}', async () => {});
Step('the HTTP status is/was {int}', async () => {});
test.step('not a step definition', async () => {});
Before(async () => {});
`;
    assert.deepEqual(findings(source), []);
  });

  it('should reject a step defined with a regular expression', () => {
    const source = `Given('the HTTP status is {int}', async () => {});
Then(/^the HTTP status is (\\d+)$/, async () => {});
`;
    assert.deepEqual(findings(source), [{ line: 2, rule: 'step-regexp' }]);
  });

  it('should reject an expression taken from a template, a variable or a call', () => {
    const source = `const phrase = 'the HTTP status is {int}';
Then(phrase, async () => {});
Then(\`the HTTP status is {int}\`, async () => {});
Then(\`the \${'HTTP'} status is {int}\`, async () => {});
Then(phraseOf('status'), async () => {});
Then();
`;
    assert.deepEqual(findings(source).map(({ line, rule }) => `${line}:${rule}`), [
      '2:step-literal',
      '3:step-literal',
      '4:step-literal',
      '5:step-literal',
      '6:step-literal',
    ]);
  });

  it('should reject double quotes and an expression continued over two lines', () => {
    const source = `Then("the HTTP status is {int}", async () => {});
Then('the HTTP status \\
is {int}', async () => {});
`;
    assert.deepEqual(findings(source), [
      { line: 1, rule: 'step-literal' },
      { line: 2, rule: 'step-literal' },
    ]);
  });

  it('should reject non-ASCII characters outside the holes and name them', () => {
    const [violation] = lintSource({ path, source: "Then('HTTP ステータスが {int} である', async () => {});" });
    assert.equal(violation.rule, 'step-ascii');
    assert.match(violation.message, /\(ステータがである\)/);
    assert.match(violation.message, /ja\.yaml/);
  });

  it('should find the step definitions of the repository free of violations', () => {
    assert.deepEqual(lintRepository(REPOSITORY_ROOT), []);
  });
});
