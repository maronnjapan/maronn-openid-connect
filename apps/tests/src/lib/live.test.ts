import { describe, expect, it } from 'vitest';
import type { LiveExchange } from '@maronn-openid-connect/live-op/api';
import { exampleRequestOf, exchangeResponse, locationPath, mapExchangeLink, outcomeDifferences } from './live';

const ORIGIN = 'https://map.example.com';

/** An exchange of the live OP that answered with a status, an error and headers. */
function exchange(status: number, headers: Array<[string, string]> = [], error?: string): Pick<LiveExchange, 'status' | 'error' | 'response'> {
  return { status, ...(error === undefined ? {} : { error }), response: { status, headers, body: '{}' } };
}

describe('exampleRequestOf', () => {
  it('should write a request of the live OP as the page shows a request, at the page host', () => {
    expect(exampleRequestOf({ method: 'POST', path: '/token', headers: [['content-type', 'application/x-www-form-urlencoded']], body: 'grant_type=refresh_token' }, 'map.example.com')).toEqual({
      method: 'POST',
      path: '/token',
      host: 'map.example.com',
      headers: [['content-type', 'application/x-www-form-urlencoded']],
      body: 'grant_type=refresh_token',
    });
  });
});

describe('exchangeResponse', () => {
  it('should give the response the OP answered with, and none when it threw', () => {
    expect([exchangeResponse({ response: { status: 302, statusText: 'Found', headers: [['location', '/login']], truncated: true } }), exchangeResponse({})]).toEqual([
      { status: 302, statusText: 'Found', headers: [['location', '/login']], truncated: true },
      undefined,
    ]);
  });
});

describe('locationPath', () => {
  it('should read the path of a Location against the origin of the OP', () => {
    expect([locationPath(exchange(302, [['location', '/login?transaction_id=t']]), ORIGIN), locationPath(exchange(302, [['location', 'https://rp.example.com/callback?code=c']]), ORIGIN), locationPath(exchange(200), ORIGIN)]).toEqual([
      '/login',
      '/callback',
      undefined,
    ]);
  });
});

describe('outcomeDifferences', () => {
  it('should find none for an answer the case expects, and read the error only when the case names one', () => {
    expect([
      outcomeDifferences({ status: 400, description: '', error: 'invalid_grant' }, exchange(400, [], 'invalid_grant'), ORIGIN),
      outcomeDifferences({ status: 401, description: '' }, exchange(401, [], 'invalid_token'), ORIGIN),
    ]).toEqual([[], []]);
  });

  it('should say how the status, the error and the path redirected to differ', () => {
    expect(outcomeDifferences({ status: 302, description: '', redirectPath: '/login' }, exchange(302, [['location', '/consent']], 'access_denied'), ORIGIN)).toEqual([
      { what: 'エラー', expected: 'なし', actual: 'access_denied' },
      { what: 'リダイレクト先', expected: '/login', actual: '/consent' },
    ]);
    expect(outcomeDifferences({ status: 200, description: '' }, { status: undefined, error: undefined }, ORIGIN)).toEqual([{ what: 'ステータス', expected: '200', actual: 'なし' }]);
  });
});

describe('mapExchangeLink', () => {
  it('should open the exchange on the flow of the endpoint, on hono for a case of Next.js', () => {
    expect([mapExchangeLink('hono', 'token', 'x7'), mapExchangeLink('nextjs', 'device-authorization', 'x12')]).toEqual(['../#hono--token;x=x7', '../#hono--device-authorization;x=x12']);
  });
});
