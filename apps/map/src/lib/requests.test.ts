import { describe, expect, it } from 'vitest';
import type { RootRequests } from '../types';
import { basicCredentials, briefBody, statusLine, statusTone, wayRequestsOf } from './requests';

const requests: RootRequests = {
  version: 4,
  root: 'endpoint:token',
  source: 'hono',
  endpoint: 'token',
  ways: [
    { id: 'c-refresh', kind: 'step', name: 'refresh_token グラントを検証する', target: 's0b9', scenarios: ['token-refresh'] },
    { id: 'c-exit-a', kind: 'exit', name: 'return a', target: 's0b9s0', scenarios: ['token-refresh'] },
    { id: 'c-exit-b', kind: 'exit', name: 'return b', target: 's0b9s0', scenarios: [] },
  ],
  cases: [{ id: 'token-refresh', status: 200, ways: ['c-refresh', 'c-exit-a'], rootRan: true, mismatches: 0, assumed: 0 }],
};

describe('wayRequestsOf', () => {
  it('should find the request of the exact code path', () => {
    expect([
      wayRequestsOf(requests, { kind: 'step', name: 'refresh_token グラントを検証する', target: 's0b9' })?.id,
      wayRequestsOf(requests, { kind: 'exit', name: 'return b', target: 's0b9s0' })?.id,
    ]).toEqual(['c-refresh', 'c-exit-b']);
  });

  it('should leave a path without a request when only a different path to its node was observed', () => {
    const onlyOne: RootRequests = { ...requests, ways: requests.ways.filter((way) => way.id === 'c-exit-a') };
    expect(wayRequestsOf(onlyOne, { kind: 'exit', name: 'return b', target: 's0b9s0' })).toBeUndefined();
  });

  it('should find none for no way, a way no request took, or no requests', () => {
    expect([
      wayRequestsOf(requests, undefined),
      wayRequestsOf(requests, { kind: 'failure', name: 'x', target: 's0b9' }),
      wayRequestsOf(undefined, { kind: 'step', name: 'refresh_token グラントを検証する', target: 's0b9' }),
    ]).toEqual([undefined, undefined, undefined]);
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

describe('briefBody', () => {
  it('should write a short JSON body without spaces, and keep short text as it is', () => {
    expect(briefBody('{\n  "active": false\n}')).toBe('{"active":false}');
    expect(briefBody(' Not Found ')).toBe('Not Found');
  });

  it('should give none for no body, an empty one, one of several lines, or a long one', () => {
    expect([briefBody(undefined), briefBody('  '), briefBody('<p>\n</p>'), briefBody(JSON.stringify({ access_token: 'x'.repeat(80) }))]).toEqual([undefined, undefined, undefined, undefined]);
    expect(briefBody('{"error":"invalid_grant"}', 20)).toBeUndefined();
  });
});
