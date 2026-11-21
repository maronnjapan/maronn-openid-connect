import { describe, expect, it } from 'vitest';
import type { RootRequests, WayRequest } from '../types';
import { basicCredentials, fileName, paramGroups, shortValue, statusLine, statusTone, testsLink, wayRequestsOf } from './requests';

const example: WayRequest = {
  test: { id: 't-1', title: 'should rotate the refresh token', file: 'apps/hono/src/oidc-provider/endpoints/token/pipeline.test.ts', line: 378, code: "const whileLoggedIn = await refresh(first.refresh_token ?? '');" },
  method: 'POST',
  path: '/token',
  params: [
    { name: 'grant_type', value: 'refresh_token', in: 'form' },
    { name: 'refresh_token', value: 'rt-1', in: 'form' },
  ],
  headers: [['content-type', 'application/x-www-form-urlencoded']],
  status: 200,
};

const requests: RootRequests = {
  version: 1,
  root: 'endpoint:token',
  source: 'hono',
  endpoint: 'token',
  ways: [
    { id: 'c-refresh', kind: 'step', name: 'refresh_token グラントを検証する', target: 's0b9', count: 3, examples: [example] },
    { id: 'c-exit-a', kind: 'exit', name: 'return a', target: 's0b9s0', count: 1, examples: [example] },
    { id: 'c-exit-b', kind: 'exit', name: 'return b', target: 's0b9s0', count: 1, examples: [example] },
  ],
};

describe('wayRequestsOf', () => {
  it('should find the requests of a way by its kind and target, by its name too when several share them', () => {
    expect([
      wayRequestsOf(requests, { kind: 'step', name: 'refresh_token グラントを検証する', target: 's0b9' })?.id,
      wayRequestsOf(requests, { kind: 'step', name: 'a name the catalog said otherwise', target: 's0b9' })?.id,
      wayRequestsOf(requests, { kind: 'exit', name: 'return b', target: 's0b9s0' })?.id,
      wayRequestsOf(requests, { kind: 'exit', name: 'return c', target: 's0b9s0' })?.id,
    ]).toEqual(['c-refresh', 'c-refresh', 'c-exit-b', 'c-exit-a']);
  });

  it('should find none for no way, a way no request took, or no requests', () => {
    expect([
      wayRequestsOf(requests, undefined),
      wayRequestsOf(requests, { kind: 'failure', name: 'x', target: 's0b9' }),
      wayRequestsOf(undefined, { kind: 'step', name: 'refresh_token グラントを検証する', target: 's0b9' }),
    ]).toEqual([undefined, undefined, undefined]);
  });
});

describe('paramGroups', () => {
  it('should group the parameters by where they were sent, each group in the order sent', () => {
    expect(
      paramGroups([
        { name: 'client_id', value: 'c', in: 'query' },
        { name: 'grant_type', value: 'g', in: 'form' },
        { name: 'scope', value: 's', in: 'query' },
      ]),
    ).toEqual([
      {
        in: 'query',
        label: 'クエリ',
        params: [
          { name: 'client_id', value: 'c', in: 'query' },
          { name: 'scope', value: 's', in: 'query' },
        ],
      },
      { in: 'form', label: 'フォーム', params: [{ name: 'grant_type', value: 'g', in: 'form' }] },
    ]);
  });
});

describe('shortValue', () => {
  it('should cut a long value in the middle to the limit, and leave a short one whole', () => {
    const long = `${'a'.repeat(40)}${'b'.repeat(40)}`;
    expect([shortValue('short'), shortValue(long).text.length, shortValue(long).text.startsWith('aaaa'), shortValue(long).text.endsWith('bbbb'), shortValue(long).cut]).toEqual([{ text: 'short', cut: false }, 48, true, true, true]);
  });
});

describe('statusLine and statusTone', () => {
  it('should give the status with its own reason phrase, else the usual one, and how it reads', () => {
    expect([statusLine({ status: 401 }), statusLine({ status: 200, statusText: 'Fine' }), statusLine({ status: 299 })]).toEqual(['401 Unauthorized', '200 Fine', '299']);
    expect([statusTone(200), statusTone(302), statusTone(400), statusTone(500)]).toEqual(['ok', 'redirect', 'error', 'error']);
  });
});

describe('basicCredentials', () => {
  it('should give the client a Basic header names, and none for another scheme or a broken value', () => {
    expect([basicCredentials(`Basic ${btoa('client%3A1:secret')}`), basicCredentials(`basic ${btoa('client-1:s')}`), basicCredentials('Bearer at-1'), basicCredentials('Basic !!'), basicCredentials(`Basic ${btoa('nocolon')}`)]).toEqual([
      { client: 'client:1' },
      { client: 'client-1' },
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('testsLink and fileName', () => {
  it('should open the case on the tests page with the test in the panel and its line marked', () => {
    expect(testsLink(requests, { id: 'c-refresh' }, example)).toBe('./tests/#/endpoint/hono/token?case=c-refresh&test=t-1&line=378');
    expect(fileName(example.test.file)).toBe('pipeline.test.ts');
  });
});
