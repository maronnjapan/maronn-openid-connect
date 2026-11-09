import { describe, expect, it } from 'vitest';
import { aspectsOf, hasWord, parseAspects } from '../aspects.js';
import { readFeatureTags, readFeatureTests, specOfTag } from '../read-feature.js';
import { checkTranslations, holesOf, japaneseKeyword, readDefinitions, Translations, Vocabulary } from '../vocabulary.js';

const FEATURE = [
  '@endpoint:token',
  'Feature: Client authentication at the token endpoint',
  '  ja: トークンエンドポイントのクライアント認証',
  '',
  '  Background:',
  '    Given a registered confidential client:',
  '      | client_id | secret   |',
  '      | client-1  | secret-1 |',
  '',
  '  @id:token-invalid-client-secret @spec:RFC6749-5.2 @auth @hono @nextjs',
  '  Scenario: Reject invalid client credentials with invalid_client',
  '    ja: 無効なクライアント認証情報を invalid_client で拒否する',
  '    Given the client "client-1" presents invalid credentials',
  '    When the client requests the token endpoint with grant_type "authorization_code"',
  '    Then the HTTP status is 401',
  '    And the error code is "invalid_client"',
  '',
  '  @id:token-missing-required-parameter @hono',
  '  Scenario Outline: Reject a request without <param> with invalid_request',
  '    When the client requests the token endpoint without <param>',
  '    Then the HTTP status is 400',
  '',
  '    Examples:',
  '      | param        |',
  '      | code         |',
  '      | redirect_uri |',
].join('\n');

describe('readFeatureTests', () => {
  it('should read a scenario with its id, its Japanese name, the background steps first and the kind of each And', () => {
    const [scenario] = readFeatureTests(FEATURE);
    expect(scenario?.id).toBe('token-invalid-client-secret');
    expect(scenario?.ja).toBe('無効なクライアント認証情報を invalid_client で拒否する');
    expect(scenario?.featureJa).toBe('トークンエンドポイントのクライアント認証');
    expect(scenario?.steps.map((step) => [step.type, step.text])).toEqual([
      ['context', 'a registered confidential client:'],
      ['context', 'the client "client-1" presents invalid credentials'],
      ['action', 'the client requests the token endpoint with grant_type "authorization_code"'],
      ['outcome', 'the HTTP status is 401'],
      ['outcome', 'the error code is "invalid_client"'],
    ]);
    expect(scenario?.steps[0]?.table).toEqual([
      ['client_id', 'secret'],
      ['client-1', 'secret-1'],
    ]);
  });

  it('should make a case of each row of an outline, numbered from 1, its columns put in', () => {
    const rows = readFeatureTests(FEATURE).slice(1);
    expect(rows.map((row) => [row.id, row.title, row.path, row.steps[1]?.text])).toEqual([
      ['token-missing-required-parameter-1', 'Reject a request without code with invalid_request', ['Client authentication at the token endpoint', 'Reject a request without <param> with invalid_request'], 'the client requests the token endpoint without code'],
      ['token-missing-required-parameter-2', 'Reject a request without redirect_uri with invalid_request', ['Client authentication at the token endpoint', 'Reject a request without <param> with invalid_request'], 'the client requests the token endpoint without redirect_uri'],
    ]);
  });

  it('should give the tags of the feature to its scenarios', () => {
    expect(readFeatureTests(FEATURE)[0]?.tags).toEqual(['@endpoint:token', '@id:token-invalid-client-secret', '@spec:RFC6749-5.2', '@auth', '@hono', '@nextjs']);
  });
});

describe('readFeatureTags and specOfTag', () => {
  it('should read the subjects, the sections, the aspects and the targets of the tags', () => {
    expect(readFeatureTags(['@endpoint:token', '@function:core:verifyClientSecret', '@spec:OAuth2.1-2.3', '@auth', '@http', '@id:x'])).toEqual({
      endpoints: ['token'],
      functions: ['core:verifyClientSecret'],
      scenarios: [],
      spec: ['OAuth 2.1 §2.3'],
      aspects: ['auth'],
      targets: ['http'],
    });
  });

  it('should read explicit feature tags separately from test aspects', () => {
    expect(readFeatureTags(['@feature:par', '@auth']).features).toEqual(['par']);
    expect(readFeatureTags(['@feature:par', '@auth']).aspects).toEqual(['auth']);
  });

  it('should write a section of a tag the way the catalog writes it', () => {
    expect([specOfTag('RFC6749-5.2'), specOfTag('OIDC-Core-11'), specOfTag('OAuth2.1-2.3')]).toEqual(['RFC 6749 §5.2', 'OIDC Core 1.0 §11', 'OAuth 2.1 §2.3']);
  });
});

describe('the vocabulary and its Japanese', () => {
  const steps = [
    "Then('the HTTP status is {int}', async ({ run }, status: number) => {});",
    "Then('the error code is {string}', async () => {});",
    'Given(/^a regexp$/, async () => {});',
  ].join('\n');

  it('should read the expressions of the step definitions, and the ones that are not a string literal', () => {
    const read = readDefinitions(steps, 'tests/steps/token.ts');
    expect(read.definitions.map((definition) => [definition.keyword, definition.expression, definition.line])).toEqual([
      ['Then', 'the HTTP status is {int}', 1],
      ['Then', 'the error code is {string}', 2],
    ]);
    expect(read.invalid).toEqual([{ file: 'tests/steps/token.ts', line: 3, keyword: 'Given' }]);
  });

  it('should match a step to its expression with the holes as written, and translate it', () => {
    const vocabulary = new Vocabulary(readDefinitions(steps, 'steps.ts').definitions);
    const [match] = vocabulary.matches('the error code is "invalid_client"');
    expect(match?.holes).toEqual(['"invalid_client"']);
    const translations = Translations.parse("'the error code is {string}': 'エラーコードが {0} である'\n");
    expect(translations.translate(match?.definition.expression ?? '', match?.holes ?? [])).toBe('エラーコードが "invalid_client" である');
    expect(translations.translate('the HTTP status is {int}', ['401'])).toBeUndefined();
  });

  it('should find a key of the table that names no phrase, and a template that does not use each hole once', () => {
    const translations = Translations.parse(["'the HTTP status is {int}': 'HTTP ステータスが {0} である'", "'the {string} header is {string}': '{0} ヘッダーが {0} である'", "'no such phrase': 'x'"].join('\n'));
    expect(checkTranslations(translations, new Set(['the HTTP status is {int}', 'the {string} header is {string}']))).toEqual([
      'tests/steps/ja.yaml: "the {string} header is {string}" uses its hole {0} 2 times in its Japanese (once is right)',
      'tests/steps/ja.yaml: "the {string} header is {string}" uses its hole {1} 0 times in its Japanese (once is right)',
      'tests/steps/ja.yaml: "no such phrase" is no step expression of tests/steps and no phrase of an expectation',
    ]);
    expect(holesOf('the {string} header is {string} \\{not}')).toEqual(['string', 'string']);
  });

  it('should take the Japanese keywords from the dictionary of Gherkin, one for each kind', () => {
    expect(['Feature', 'Scenario', 'Given', 'When', 'Then', 'And'].map(japaneseKeyword)).toEqual(['機能', 'シナリオ', '前提', 'もし', 'ならば', 'かつ']);
  });
});

describe('aspectsOf', () => {
  const table = parseAspects(
    [
      'aspects:',
      '  boundary:',
      '    label: 境界値',
      '    tags: [boundary]',
      '    words: [expired, at the limit]',
      '  authentication:',
      '    label: 認証',
      '    tags: [auth]',
      '    errors: [invalid_client]',
      '    statuses: [401]',
      'required: [authentication]',
    ].join('\n'),
  );

  it('should take the declared aspects, the words of the names and what the expectations check', () => {
    expect(aspectsOf(table, { declared: ['auth'], names: [], errors: [], statuses: [], headers: [] })).toEqual(['authentication']);
    expect(aspectsOf(table, { declared: [], names: ['parseToken', 'should reject an expired code'], errors: [], statuses: [], headers: [] })).toEqual(['boundary']);
    expect(aspectsOf(table, { declared: [], names: [], errors: [], statuses: [401], headers: [] })).toEqual(['authentication']);
    expect(aspectsOf(table, { declared: [], names: ['should keep the state'], errors: [], statuses: [200], headers: [] })).toEqual([]);
    expect(table.required).toEqual(['authentication']);
  });

  it('should match a word between word boundaries only', () => {
    expect([hasWord('should reject an expired code', 'expired'), hasWord('should reject unexpiredness', 'expired'), hasWord('at the limit.', 'at the limit')]).toEqual([true, false, true]);
  });
});
