import { describe, expect, it } from 'vitest';
import type { RawExchange } from '../model.js';
import { authOf, lineCode, recordedRequests, requestParams, sentLine } from '../sent.js';

const TEST = { source: { file: 'apps/hono/src/token.test.ts', lines: [40, 60] as [number, number], form: 'code' as const } };

/** A request recorded with the call sites of its send; a status of null: the send threw. */
function recorded(from: Array<[string, number]> | undefined, extra: Partial<RawExchange['request']> = {}, status: number | null = 200): RawExchange {
  return {
    request: { method: 'POST', url: 'https://op.example.com/token', headers: [['content-type', 'application/x-www-form-urlencoded']], body: 'grant_type=refresh_token&refresh_token=rt-1', ...extra },
    ...(status === null ? { error: 'TypeError: boom' } : { response: { status, headers: [] } }),
    ...(from === undefined ? {} : { from }),
    ran: {},
  };
}

describe('sentLine', () => {
  it('should take the innermost frame in the test file inside the test, past the helpers of the file outside it and of other files', () => {
    const from: Array<[string, number]> = [
      ['apps/hono/src/token.test.ts', 12],
      ['apps/hono/src/test-support/token.ts', 30],
      ['apps/hono/src/token.test.ts', 45],
      ['apps/hono/src/token.test.ts', 58],
    ];
    expect(sentLine(TEST, { from })).toBe(45);
  });

  it('should give no line for a send with no frame of the test: a hook, a framework that forwarded it, or no stack', () => {
    expect([
      sentLine(TEST, { from: [['apps/hono/src/token.test.ts', 12]] }),
      sentLine(TEST, { from: [['apps/hono/src/web/fastify/apply.ts', 55]] }),
      sentLine(TEST, { from: [['apps/hono/src/other.test.ts', 45]] }),
      sentLine(TEST, {}),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('lineCode', () => {
  it('should give the line trimmed, cut at 240 characters, and nothing past the end of the file', () => {
    const long = `  const x = ${'a'.repeat(300)};`;
    expect([lineCode(['a', '   await post(fields);  '], 2), lineCode([long], 1).length, lineCode([long], 1).endsWith('…'), lineCode(['a'], 3), lineCode(undefined, 1)]).toEqual(['await post(fields);', 240, true, '', '']);
  });

  it('should read on while the line leaves a bracket open, as the call reads on one line, the brackets of strings and the comments left out', () => {
    const lines = [
      '    const response = await app.request(',
      "      introspect({ token: 'at-1' }, { Accept: 'application/token-introspection+jwt' }),",
      '    );',
      "    const other = await post({ text: '(  not a bracket', // a ( comment",
      '      grant_type: `client_credentials`,',
      '    });',
      "    expect(response.status).toBe(200); // OIDC Core 1.0 https://openid.net/specs",
    ];
    expect([lineCode(lines, 1), lineCode(lines, 4), lineCode(lines, 7)]).toEqual([
      "const response = await app.request(introspect({ token: 'at-1' }, { Accept: 'application/token-introspection+jwt' }));",
      "const other = await post({ text: '(  not a bracket', grant_type: `client_credentials` });",
      'expect(response.status).toBe(200);',
    ]);
  });

  it('should stop after 8 lines of a statement that never closes', () => {
    expect(lineCode(Array.from({ length: 20 }, (_, index) => (index === 0 ? 'call(' : `a${index},`)), 1)).toBe('call(a1, a2, a3, a4, a5, a6, a7,');
  });
});

describe('requestParams', () => {
  it('should list the query, then the fields of a form body, in order', () => {
    expect(requestParams({ path: '/authorize?client_id=c-1&scope=openid+email', headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: 'prompt=none&state=s' })).toEqual([
      { name: 'client_id', value: 'c-1', in: 'query' },
      { name: 'scope', value: 'openid email', in: 'query' },
      { name: 'prompt', value: 'none', in: 'form' },
      { name: 'state', value: 's', in: 'form' },
    ]);
  });

  it('should list the top-level members of a JSON object, a value other than a string as JSON, and nothing of a cut or another body', () => {
    const json = { path: '/register', headers: [['content-type', 'application/json; charset=utf-8']] as Array<[string, string]> };
    expect([
      requestParams({ ...json, body: '{"redirect_uris":["https://rp.example.com/cb"],"client_name":"RP","tenant_id":1}' }),
      requestParams({ ...json, body: '{"redirect_uris":[', truncated: true }),
      requestParams({ ...json, body: '[1,2]' }),
      requestParams({ path: '/upload', headers: [['content-type', 'text/plain']], body: 'a=b' }),
    ]).toEqual([
      [
        { name: 'redirect_uris', value: '["https://rp.example.com/cb"]', in: 'json' },
        { name: 'client_name', value: 'RP', in: 'json' },
        { name: 'tenant_id', value: '1', in: 'json' },
      ],
      [],
      [],
      [],
    ]);
  });
});

describe('authOf', () => {
  it('should give the scheme, and for Basic the client id it names, decoded', () => {
    const basic = Buffer.from('client%3A1:secret').toString('base64');
    expect([authOf([['authorization', `Basic ${basic}`]]), authOf([['Authorization', 'Bearer at-1']]), authOf([['authorization', 'DPoP at-1']]), authOf([['authorization', 'Basic !!!']]), authOf([])]).toEqual([
      'Basic client:1',
      'Bearer',
      'DPoP',
      'Basic',
      undefined,
    ]);
  });
});

describe('recordedRequests', () => {
  it('should keep the requests a line of the test sent, in the order sent, with the line, the parameters, the auth and the status, and count the others', () => {
    const own: Array<[string, number]> = [['apps/hono/src/token.test.ts', 48]];
    const { recorded: requests, unpinned } = recordedRequests(TEST, [
      recorded([['apps/hono/src/web/fastify/apply.ts', 55]]),
      recorded(own, { headers: [['content-type', 'application/x-www-form-urlencoded'], ['authorization', `Basic ${Buffer.from('client-1:s').toString('base64')}`]] }),
      recorded([['apps/hono/src/token.test.ts', 52]], { method: 'GET', url: 'https://op.example.com/userinfo', headers: [['authorization', 'Bearer at-1']], body: undefined }, null),
      recorded(undefined),
    ]);
    expect([requests, unpinned]).toEqual([
      [
        {
          line: 48,
          method: 'POST',
          path: '/token',
          params: [
            { name: 'grant_type', value: 'refresh_token', in: 'form' },
            { name: 'refresh_token', value: 'rt-1', in: 'form' },
          ],
          auth: 'Basic client-1',
          status: 200,
        },
        { line: 52, method: 'GET', path: '/userinfo', auth: 'Bearer' },
      ],
      2,
    ]);
  });
});
