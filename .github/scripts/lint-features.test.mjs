import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintFeatures, lintRepository } from './lint-features.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The reported lines and rules of feature files given as [path, source] pairs. */
function findings(...files) {
  return lintFeatures(files.map(([path, source]) => ({ path, source }))).map(({ path, line, rule }) => `${path}:${line}:${rule}`);
}

const VALID = `@endpoint:token
Feature: Client authentication at the token endpoint
  ja: トークンエンドポイントのクライアント認証

  Background:
    Given a registered confidential client:
      | client_id | client_secret | redirect_uri                    |
      | client-1  | secret-1      | https://rp.example.com/callback |

  @id:token-invalid-client-secret @spec:RFC6749-5.2 @auth @hono @nextjs
  Scenario: Reject invalid client credentials with invalid_client
    ja: 無効なクライアント認証情報を invalid_client で拒否する
    When the client "client-1" requests the token endpoint with grant_type "authorization_code"
    Then the HTTP status is 401

  @id:token-missing-required-parameter @hono
  Scenario Outline: Reject a request without <parameter>
    When the client "client-1" redeems the authorization code "code-1" without <parameter>
    Then the error code is "<error>"

    Examples:
      | parameter | error           |
      | code      | invalid_request |

  @function:verifyClientSecret
  Rule: Secrets compare in constant time
    @id:verify-client-secret-mismatch @http
    Scenario: Reject a secret of another length
      Then the HTTP status is 401
`;

describe('feature files', () => {
  it('should accept scenarios with an id, a subject and a target, the Feature and Rule tags included', () => {
    assert.deepEqual(findings(['tests/features/token/valid.feature', VALID]), []);
  });

  it('should reject a file without a Feature and a Feature without scenarios', () => {
    assert.deepEqual(findings(
      ['tests/features/empty.feature', ''],
      ['tests/features/comment.feature', '# nothing but a comment\n'],
      ['tests/features/background.feature', '@endpoint:token\nFeature: Only a background\n  Background:\n    Given a registered confidential client:\n'],
    ), [
      'tests/features/empty.feature:1:empty-file',
      'tests/features/comment.feature:1:empty-file',
      'tests/features/background.feature:2:no-scenarios',
    ]);
  });

  it('should reject a file the parser cannot read at the line of the error', () => {
    const source = '@endpoint:token\nFeature: Broken\n  Scenario: Broken table\n    Given a registered confidential client:\n      | a |\n      | a | b |\n';
    assert.deepEqual(findings(['tests/features/broken.feature', source]), ['tests/features/broken.feature:6:parse-error']);
  });

  it('should require exactly one kebab-case id on every scenario', () => {
    const source = `@endpoint:token
Feature: Ids
  @hono
  Scenario: Without an id
    Then the HTTP status is 200

  @id:first @id:second @hono
  Scenario: With two ids
    Then the HTTP status is 200

  @id:Not_Kebab @hono
  Scenario: With a malformed id
    Then the HTTP status is 200
`;
    assert.deepEqual(findings(['tests/features/ids.feature', source]), [
      'tests/features/ids.feature:4:scenario-id',
      'tests/features/ids.feature:8:scenario-id',
      'tests/features/ids.feature:12:scenario-id',
    ]);
  });

  it('should require a subject and a target, a target on every Examples block counting', () => {
    const source = `Feature: Tags
  @id:no-subject @hono
  Scenario: Without a subject
    Then the HTTP status is 200

  @id:no-target @endpoint:token
  Scenario: Without a target
    Then the HTTP status is 200

  @id:target-per-examples @endpoint:token
  Scenario Outline: With a target on each Examples block <status>
    Then the HTTP status is <status>

    @hono
    Examples:
      | status |
      | 200    |

    @http
    Examples:
      | status |
      | 400    |
`;
    assert.deepEqual(findings(['tests/features/tags.feature', source]), [
      'tests/features/tags.feature:3:scenario-subject',
      'tests/features/tags.feature:7:scenario-target',
    ]);
  });

  it('should reject a column of the Examples that is not used and a variable that no column defines', () => {
    const source = `@endpoint:token
Feature: Variables
  @id:outline @hono
  Scenario Outline: Reject a request without <parameter>
    When the client "client-1" redeems the authorization code "<code>" without <parameter>
    Then the error code is "<error>"

    Examples:
      | parameter | error           | unused |
      | code      | invalid_request | x      |
`;
    assert.deepEqual(findings(['tests/features/variables.feature', source]), [
      'tests/features/variables.feature:9:unused-variable',
      'tests/features/variables.feature:4:unused-variable',
    ]);
  });

  it('should reject the same scenario name and the same id in two files', () => {
    const scenario = (id) => `@endpoint:token\nFeature: ${id}\n  @id:${id} @hono\n  Scenario: Reject invalid client credentials\n    Then the HTTP status is 401\n`;
    const other = '@endpoint:token\nFeature: other\n  @id:first @hono\n  Scenario: Another name\n    Then the HTTP status is 401\n';
    assert.deepEqual(findings(
      ['tests/features/a.feature', scenario('first')],
      ['tests/features/b.feature', scenario('second')],
      ['tests/features/c.feature', other],
    ), [
      'tests/features/b.feature:4:duplicate-scenario-name',
      'tests/features/c.feature:4:duplicate-id',
    ]);
  });

  it('should find the feature files of the repository free of violations', () => {
    assert.deepEqual(lintRepository(REPOSITORY_ROOT), []);
  });
});
