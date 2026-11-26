import { describe, expect, it } from 'vitest';
import type { ExchangeSummary, LiveRecord } from '@maronn-openid-connect/live-op/api';
import { agoWords, browserPath, codeChallengeOf, endpointForPath, exchangesFor, expectationGaps, newCodeVerifier, offsetWords, pathOf, recordOf, recordsByCollection } from './live';

const ENDPOINTS = [
  { id: 'login', path: '/login' },
  { id: 'login-google', path: '/login/google' },
  { id: 'device', path: '/device' },
  { id: 'device-authorization', path: '/device_authorization' },
  { id: 'logout', path: '/logout' },
  { id: 'discovery', path: '/.well-known/openid-configuration' },
];

/** A summary of an exchange of a workspace. */
function summary(id: string, path: string, more: Partial<ExchangeSummary> = {}): ExchangeSummary {
  return { id, source: 'http', at: 0, method: 'GET', path, ...more };
}

describe('endpointForPath', () => {
  it('should find the endpoint of a path, of a path below it, and the longest one above it', () => {
    expect(['/login?transaction_id=t', '/login/google', '/device/login', '/device_authorization', '/logout/approve', '/.well-known/openid-configuration', '/token', '/devices'].map((path) => endpointForPath(ENDPOINTS, path)?.id)).toEqual([
      'login',
      'login-google',
      'device',
      'device-authorization',
      'logout',
      'discovery',
      undefined,
      undefined,
    ]);
  });

  it('should read a path without its query and fragment', () => {
    expect([pathOf('/token?x=1'), pathOf('/cb#code=1'), pathOf('/plain')]).toEqual(['/token', '/cb', '/plain']);
  });
});

describe('exchangesFor', () => {
  it('should give the exchanges of one endpoint, its sub-paths included, or all of them, the newest first', () => {
    const list = [summary('x1', '/authorize?client_id=c'), summary('x2', '/device/login'), summary('x3', '/device_authorization'), summary('x4', '/device')];

    expect([exchangesFor(list, ENDPOINTS, 'device').map((item) => item.id), exchangesFor(list, ENDPOINTS, undefined).map((item) => item.id)]).toEqual([
      ['x4', 'x2'],
      ['x4', 'x3', 'x2', 'x1'],
    ]);
  });
});

describe('the clock in words', () => {
  it('should say how long ago a time of the OP clock was', () => {
    expect([agoWords(10_000, 12_000), agoWords(0, 42_000), agoWords(0, 185_000), agoWords(0, 7_300_000), agoWords(0, 3 * 86_400_000), agoWords(5_000, 1_000)]).toEqual(['いま', '42 秒前', '3 分前', '2 時間前', '3 日前', 'いま']);
  });

  it('should say how far the clock was moved on', () => {
    expect([offsetWords(0), offsetWords(60), offsetWords(600), offsetWords(3600), offsetWords(601)]).toEqual(['進めていない', '+60 秒（1 分）', '+600 秒（10 分）', '+3600 秒（1 時間）', '+601 秒']);
  });
});

describe('the records of a workspace', () => {
  it('should group the records by collection in the order they come, and find one by its collection and key', () => {
    const records: LiveRecord[] = [
      { collection: 'codes', key: 'c1', value: {}, addedBy: 'x4' },
      { collection: 'clients', key: 'client-1', value: {} },
      { collection: 'codes', key: 'c2', value: {}, addedBy: 'x9', changedBy: ['x10'] },
    ];

    expect(recordsByCollection(records).map((group) => [group.collection, group.records.map((record) => record.key)])).toEqual([
      ['codes', ['c1', 'c2']],
      ['clients', ['client-1']],
    ]);
    expect([recordOf(records, 'codes', 'c2')?.addedBy, recordOf(records, 'codes', 'c3'), recordOf(undefined, 'codes', 'c1')]).toEqual(['x9', undefined, undefined]);
  });
});

describe('expectationGaps', () => {
  it('should find nothing for a response as its case expects', () => {
    expect([
      expectationGaps({ status: 302, redirectPath: '/login' }, { status: 302, location: 'http://127.0.0.1:3610/login?transaction_id=t' }),
      expectationGaps({ status: 400, error: 'invalid_grant' }, { status: 400, error: 'invalid_grant' }),
      expectationGaps({ status: 400 }, { status: 400, error: 'invalid_request' }),
    ]).toEqual([[], [], []]);
  });

  it('should name another status, another error or none, an error where none is expected, and another redirect', () => {
    expect([
      expectationGaps({ status: 302, redirectPath: '/consent' }, { status: 200 }),
      expectationGaps({ status: 400, error: 'invalid_grant' }, { status: 401, error: 'invalid_client' }),
      expectationGaps({ status: 302, error: 'login_required' }, { status: 302, location: 'https://rp.example.com/callback?code=c' }),
      expectationGaps({ status: 302, redirectPath: '/callback' }, { status: 302, error: 'access_denied', location: 'https://rp.example.com/oops?error=access_denied' }),
    ]).toEqual([
      ['ステータスが 302 ではなく 200', '/consent へリダイレクトしない'],
      ['ステータスが 400 ではなく 401', 'エラーが invalid_grant ではなく invalid_client'],
      ['エラー login_required が無い'],
      ['エラー access_denied を返した', 'リダイレクト先が /callback ではなく /oops'],
    ]);
  });
});

describe('browserPath', () => {
  it('should open a GET of an endpoint a browser opens, and nothing else', () => {
    expect([
      browserPath('authorize', { method: 'GET', path: '/authorize?client_id=client-1' }),
      browserPath('logout', { method: 'get', path: '/logout' }),
      browserPath('login', { method: 'POST', path: '/login' }),
      browserPath('token', { method: 'GET', path: '/token' }),
    ]).toEqual(['/authorize?client_id=client-1', '/logout', undefined, undefined]);
  });
});

describe('PKCE', () => {
  it('should give the S256 challenge of a verifier as RFC 7636 Appendix B does', async () => {
    const challenge = await codeChallengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('should make a verifier of 43 unreserved characters, a new one each time', () => {
    const [a, b] = [newCodeVerifier(), newCodeVerifier()];
    expect([/^[A-Za-z0-9_-]{43}$/.test(a), a === b]).toEqual([true, false]);
  });
});
