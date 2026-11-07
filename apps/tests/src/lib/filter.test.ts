import { describe, expect, it } from 'vitest';
import { buildDb } from './data';
import { codeParts, filterTests, searchTests, textOf, titleOf } from './filter';
import { entry, index } from './fixture';

const tests = [
  entry('u1', { title: 'should sign the ID token', ja: 'ID トークンに署名する', outcome: 'success' }),
  entry('u2', { title: 'should reject an unknown client', outcome: 'failure', path: ['authenticateClient'] }),
  entry('a1', { kind: 'api', title: 'should answer 405', outcome: 'failure', file: 'apps/hono/src/app.test.ts' }),
  entry('x1', { kind: 'tool', title: 'should build', outcome: 'unknown' }),
];

describe('filterTests', () => {
  it('should keep everything without a filter', () => {
    expect(filterTests(tests, {})).toHaveLength(4);
  });

  it('should keep the tests of a kind and of an outcome', () => {
    expect(filterTests(tests, { kind: 'unit' }).map((test) => test.id)).toEqual(['u1', 'u2']);
    expect(filterTests(tests, { outcome: 'failure' }).map((test) => test.id)).toEqual(['u2', 'a1']);
    expect(filterTests(tests, { kind: 'unit', outcome: 'failure' }).map((test) => test.id)).toEqual(['u2']);
  });
});

describe('searchTests', () => {
  const db = buildDb(index(tests));

  it('should find the tests that hold every word in their titles, file or describe path, ignoring case', () => {
    expect(searchTests(db, 'ID token').map((test) => test.id)).toEqual(['u1']);
    expect(searchTests(db, '署名').map((test) => test.id)).toEqual(['u1']);
    expect(searchTests(db, 'apps/hono').map((test) => test.id)).toEqual(['a1']);
    expect(searchTests(db, 'AUTHENTICATECLIENT').map((test) => test.id)).toEqual(['u2']);
    expect(searchTests(db, 'token 405')).toEqual([]);
  });

  it('should find nothing for an empty query', () => {
    expect(searchTests(db, '   ')).toEqual([]);
  });
});

describe('titleOf and textOf', () => {
  it('should show the Japanese when it is chosen and there is one, else the English', () => {
    expect(titleOf(tests[0] as never, 'ja')).toBe('ID トークンに署名する');
    expect(titleOf(tests[0] as never, 'en')).toBe('should sign the ID token');
    expect(titleOf(tests[1] as never, 'ja')).toBe('should reject an unknown client');
    expect(textOf({ text: 'the HTTP status is 401', ja: 'HTTP ステータスが 401 である' }, 'ja')).toBe('HTTP ステータスが 401 である');
    expect(textOf({ text: 'the HTTP status is 401', ja: '' }, 'ja')).toBe('the HTTP status is 401');
  });
});

describe('codeParts', () => {
  it('should split a text at its backquotes', () => {
    expect(codeParts('the `Allow` header is `POST`')).toEqual([
      { code: false, text: 'the ' },
      { code: true, text: 'Allow' },
      { code: false, text: ' header is ' },
      { code: true, text: 'POST' },
    ]);
  });

  it('should keep an unmatched backquote as text', () => {
    expect(codeParts('a `b')).toEqual([{ code: false, text: 'a `b' }]);
    expect(codeParts('')).toEqual([]);
  });

  it('should read a code span of a template literal in a longer fence, without its padding', () => {
    expect(codeParts('`page.url()` is `` `${issuer}/authorize` ``')).toEqual([
      { code: true, text: 'page.url()' },
      { code: false, text: ' is ' },
      { code: true, text: '`${issuer}/authorize`' },
    ]);
  });

  it('should keep backquotes of another width inside a span', () => {
    expect(codeParts('the URL matches ``new RegExp(`^${escapeRegExp(issuer)}/login$`)``')).toEqual([
      { code: false, text: 'the URL matches ' },
      { code: true, text: 'new RegExp(`^${escapeRegExp(issuer)}/login$`)' },
    ]);
    // A run of two that nothing closes is text; the span after it still reads.
    expect(codeParts('a `` b `c`')).toEqual([
      { code: false, text: 'a `` b ' },
      { code: true, text: 'c' },
    ]);
  });

  it('should show an empty string in words, not as an empty span', () => {
    expect(codeParts('`response.text()` が 空文字列 である')).toEqual([
      { code: true, text: 'response.text()' },
      { code: false, text: ' が 空文字列 である' },
    ]);
    expect(codeParts('`openid` スコープ')).toEqual([
      { code: true, text: 'openid' },
      { code: false, text: ' スコープ' },
    ]);
  });
});
