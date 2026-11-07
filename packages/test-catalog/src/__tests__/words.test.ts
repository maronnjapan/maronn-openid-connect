import { describe, expect, it } from 'vitest';
import { actualWords, expectationPhrases, expectedErrors, expectsFailure, sayExpectation, valueWords, type Expectation, type Value } from '../words.js';

const string = (value: string): Value => ({ kind: 'string', value });
const number = (value: number): Value => ({ kind: 'number', value });
const expectation = (actual: string, matcher: string, args: Value[] = [], extra: Partial<Expectation> = {}): Expectation => ({ actual, matcher, args, negated: false, ...extra });

describe('sayExpectation', () => {
  it('should say the status of a response with the phrase the steps use', () => {
    expect(sayExpectation(expectation('response.status', 'toBe', [number(401)]))).toEqual({ text: 'the HTTP status is 401', phrase: 'the HTTP status is {int}', holes: ['401'] });
    expect(sayExpectation(expectation('res.statusCode', 'toBe', [number(200)], { negated: true })).text).toBe('the HTTP status is not 200');
  });

  it('should say a failure by the error it names: a code of an object, a class, or nothing', () => {
    const object: Value = { kind: 'object', entries: [['error', string('invalid_client')]] };
    expect(sayExpectation(expectation('authenticate()', 'toMatchObject', [object], { mode: 'rejects' }))).toEqual({ text: 'fails with `invalid_client`', phrase: 'fails with {string}', holes: ['invalid_client'] });
    expect(sayExpectation(expectation('() => parse()', 'toThrow', [{ kind: 'code', code: 'TokenError' }])).text).toBe('fails with `TokenError`');
    expect(sayExpectation(expectation('() => parse()', 'toThrow')).text).toBe('fails');
    expect(sayExpectation(expectation('() => parse()', 'toThrow', [], { negated: true })).text).toBe('does not fail');
  });

  it('should say the headers of a response by their names', () => {
    expect(sayExpectation(expectation("response.headers.get('Cache-Control')", 'toBe', [string('no-store')]))).toEqual({
      text: 'the `Cache-Control` header is `no-store`',
      phrase: 'the {string} header is {string}',
      holes: ['Cache-Control', 'no-store'],
    });
    expect(sayExpectation(expectation("res.headers['www-authenticate']", 'toBeUndefined')).text).toBe('there is no `www-authenticate` header');
    expect(sayExpectation(expectation("response.headers.get('Set-Cookie')", 'toMatch', [string('HttpOnly')], { negated: true })).phrase).toBe('the {string} header does not match {string}');
  });

  it('should say an object that names an error as the error code, and other objects key by key', () => {
    expect(sayExpectation(expectation('await response.json()', 'toEqual', [{ kind: 'object', entries: [['error', string('invalid_grant')]] }])).text).toBe('the error code is `invalid_grant`');
    const token: Value = { kind: 'object', entries: [['token_type', string('Bearer')], ['expires_in', number(3600)]] };
    expect(sayExpectation(expectation('body', 'toMatchObject', [token])).text).toBe('the body has `token_type` `Bearer` and `expires_in` 3600');
  });

  it('should say the URL a page ends on from the regular expression it is matched with', () => {
    expect(sayExpectation(expectation('page', 'toHaveURL', [{ kind: 'regexp', source: '\\/consent$' }]))).toEqual({ text: 'the URL ends with `/consent`', phrase: 'the URL ends with {string}', holes: ['/consent'] });
    expect(sayExpectation(expectation('page', 'toHaveURL', [{ kind: 'regexp', source: 'code=' }])).text).toBe('the URL matches /code=/');
  });

  it('should say the other matchers about the code of the value, and keep the code of a matcher no rule knows', () => {
    expect(sayExpectation(expectation('result.scope', 'toBe', [string('openid')])).text).toBe('`result.scope` is `openid`');
    expect(sayExpectation(expectation('result', 'toBeUndefined', [], { mode: 'resolves' })).text).toBe('`result` resolves to undefined');
    expect(sayExpectation(expectation('lookup()', 'toMatchObject', [{ kind: 'object', entries: [['sub', string('u-1')]] }], { mode: 'resolves' })).text).toBe('`lookup()` resolves to a value with `sub` `u-1`');
    expect(sayExpectation(expectation('tokens', 'toHaveLength', [number(43)])).text).toBe('the length of `tokens` is 43');
    expect(sayExpectation(expectation('lookup()', 'toBeNull', [], { mode: 'resolves', negated: true })).text).toBe('`lookup()` does not resolve to null');
    expect(sayExpectation(expectation('rows', 'toHaveCount', [number(2)], { negated: true })).text).toBe('`rows` does not have 2 elements');
    expect(sayExpectation(expectation('ratio', 'toBeCloseTo', [number(3)]))).toEqual({ text: '`ratio` toBeCloseTo 3', phrase: '', holes: [] });
  });
});

describe('expectsFailure', () => {
  it('should take a rejection, a throw, a status of 400 or more and an error code as a failure', () => {
    expect(
      [
        expectation('p', 'toBeInstanceOf', [{ kind: 'code', code: 'TokenError' }], { mode: 'rejects' }),
        expectation('() => f()', 'toThrow'),
        expectation('response.status', 'toBe', [number(400)]),
        expectation('body', 'toMatchObject', [{ kind: 'object', entries: [['error', string('invalid_request')]] }]),
      ].map(expectsFailure),
    ).toEqual([true, true, true, true]);
  });

  it('should take a success status, a value and a function that does not throw as no failure', () => {
    expect([expectation('response.status', 'toBe', [number(302)]), expectation('x', 'toBe', [number(1)]), expectation('() => f()', 'toThrow', [], { negated: true })].map(expectsFailure)).toEqual([false, false, false]);
  });
});

describe('expectedErrors', () => {
  it('should give the codes and the classes a failure names', () => {
    expect(expectedErrors(expectation('p', 'toMatchObject', [{ kind: 'object', entries: [['error', string('invalid_target')]] }], { mode: 'rejects' }))).toEqual(['invalid_target']);
    expect(expectedErrors(expectation('() => f()', 'toThrow', [{ kind: 'code', code: 'TokenError' }]))).toEqual(['TokenError']);
    expect(expectedErrors(expectation('x', 'toBe', [string('invalid_target')]))).toEqual([]);
    expect(expectedErrors(expectation('typed.code', 'toBe', [string('slow_down')]))).toEqual(['slow_down']);
    expect(expectedErrors(expectation('params.code', 'toBe', [string('code-1')]))).toEqual([]);
    expect(expectedErrors(expectation('error?.error', 'toBe', [string('invalid_request')]))).toEqual(['invalid_request']);
    expect(expectedErrors(expectation('() => f()', 'toThrowError', [{ kind: 'code', code: "new CibaGrantError('unauthorized_client', 'no')" }]))).toEqual(['unauthorized_client']);
  });
});

describe('actualWords and valueWords', () => {
  it('should call the parsed body of a response the body, and show other code in backticks', () => {
    expect([actualWords('await response.json()'), actualWords('(await response.json())'), actualWords('body'), actualWords('claims.sub')]).toEqual(['the body', 'the body', 'the body', '`claims.sub`']);
  });

  it('should show strings and code in backticks, numbers as they are, and regular expressions between slashes', () => {
    expect([valueWords(string('a')), valueWords(number(1)), valueWords({ kind: 'regexp', source: 'x$' }), valueWords({ kind: 'array', items: [string('code')] })]).toEqual(['`a`', '1', '/x$/', '[`code`]']);
  });
});

describe('expectationPhrases', () => {
  it('should list each phrase the rules say once, the holes as the translation table writes them', () => {
    const phrases = expectationPhrases();
    expect([phrases.has('the HTTP status is {int}'), phrases.has('{code} is {value}'), phrases.has('the {string} header does not match {string}'), phrases.has('')]).toEqual([true, true, true, false]);
    expect([...phrases].filter((phrase) => /\b(matche|has not)\b/.test(phrase))).toEqual([]);
  });
});
