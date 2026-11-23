import { describe, expect, it } from 'vitest';
import type { RootRequests, WaySample } from '../types';
import { basicCredentials, statusLine, statusTone, wayRequestsOf } from './requests';

const sample: WaySample = {
  method: 'POST',
  path: '/token',
  params: [
    { name: 'grant_type', value: 'refresh_token', in: 'form' },
    { name: 'refresh_token', value: 'refresh-1', in: 'form' },
  ],
  headers: [['content-type', 'application/x-www-form-urlencoded']],
  status: 200,
};

const requests: RootRequests = {
  version: 2,
  root: 'endpoint:token',
  source: 'hono',
  endpoint: 'token',
  ways: [
    { id: 'c-refresh', kind: 'step', name: 'refresh_token グラントを検証する', target: 's0b9', sample },
    { id: 'c-exit-a', kind: 'exit', name: 'return a', target: 's0b9s0', sample },
    { id: 'c-exit-b', kind: 'exit', name: 'return b', target: 's0b9s0', sample },
  ],
};

describe('wayRequestsOf', () => {
  it('should find the request of a way by its kind and target, by its name too when several share them', () => {
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
