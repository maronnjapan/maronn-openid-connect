import type { ExampleRequest, ExampleResponse } from '@maronn-openid-connect/test-catalog/model';
import { describe, expect, it } from 'vitest';
import {
  basicCredentials,
  bodyKind,
  claimDate,
  DECODED_NOTE,
  decodeJwt,
  errorCodeOf,
  formLines,
  headerName,
  jsonLines,
  lineText,
  previewOf,
  reasonPhrase,
  requestBlock,
  responseBlock,
  shorten,
  statusTone,
  TRUNCATED_NOTE,
  valuePieces,
  type HttpLine,
  type Piece,
} from './exchange';

/** The base64url of a text (UTF-8). */
function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A JWS of a header and a payload with a made-up signature. */
function jwt(header: object, payload: object): string {
  return `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}.c2lnbmF0dXJlLW9mLXRoZS10b2tlbg`;
}

const ACCESS_TOKEN = jwt({ alg: 'RS256', typ: 'at+jwt', kid: 'key-1' }, { iss: 'https://op.example.com', sub: 'user-1', iat: 1767225600, exp: 1767229200 });

/** The text of some lines, long values whole. */
function texts(lines: readonly HttpLine[]): string[] {
  return lines.map(lineText);
}

/** The long pieces of some lines. */
function longs(lines: readonly HttpLine[]): Array<Extract<Piece, { kind: 'long' }>> {
  return lines.flatMap((line) => line.pieces.filter((piece): piece is Extract<Piece, { kind: 'long' }> => piece.kind === 'long'));
}

const exchange: { request: ExampleRequest; response: ExampleResponse } = {
  request: {
    method: 'POST',
    path: '/token',
    host: 'op.example.com',
    headers: [
      ['authorization', 'Basic Y2xpZW50LTE6Y2xpZW50LTEtc2VjcmV0LXZhbHVl'],
      ['content-type', 'application/x-www-form-urlencoded'],
    ],
    body: 'grant_type=authorization_code&code=code-1&redirect_uri=https%3A%2F%2Frp.example.com%2Fcallback&code_verifier=verifier-0123456789',
  },
  response: {
    status: 200,
    headers: [
      ['cache-control', 'no-store'],
      ['content-type', 'application/json'],
    ],
    body: JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'openid offline_access' }),
  },
};

describe('requestBlock', () => {
  it('should write a request as the RFCs do: the start line, Host, the headers and the form body one parameter a line, decoded', () => {
    const block = requestBlock(exchange.request);
    expect(texts(block.head)).toEqual([
      'POST /token HTTP/1.1',
      'Host: op.example.com',
      'Authorization: Basic Y2xpZW50LTE6Y2xpZW50LTEtc2VjcmV0LXZhbHVl',
      'Content-Type: application/x-www-form-urlencoded',
    ]);
    expect(block.bodyKind).toBe('form');
    expect(texts(block.body)).toEqual(['grant_type=authorization_code', '&code=code-1', '&redirect_uri=https://rp.example.com/callback', '&code_verifier=verifier-0123456789']);
    expect(block.notes).toEqual([DECODED_NOTE]);
  });

  it('should note the client_id and secret a Basic Authorization carries, and nothing on the other headers', () => {
    const block = requestBlock(exchange.request);
    expect(block.head.map((line) => line.note)).toEqual([undefined, undefined, 'client_id:client_secret をデコードすると client-1:client-1-secret-value', undefined]);
  });

  it('should put the query of a GET one parameter a line under its path, and leave a path of one parameter on its line', () => {
    const many = requestBlock({ method: 'GET', path: '/authorize?response_type=code&client_id=client-1&scope=openid%20profile', host: 'op.example.com', headers: [] });
    expect(texts(many.head)).toEqual(['GET /authorize', '    ?response_type=code', '    &client_id=client-1', '    &scope=openid profile HTTP/1.1', 'Host: op.example.com']);
    expect(many.notes).toEqual([DECODED_NOTE]);
    expect(texts(requestBlock({ method: 'GET', path: '/session/check?sid=1', host: 'op.example.com', headers: [] }).head)[0]).toBe('GET /session/check?sid=1 HTTP/1.1');
  });

  it('should keep a Host the headers have once, shorten a Bearer token after its scheme and say a body was cut', () => {
    const block = requestBlock({
      method: 'GET',
      path: '/userinfo',
      host: 'op.example.com',
      headers: [
        ['authorization', `Bearer ${ACCESS_TOKEN}`],
        ['host', 'op.example.com'],
      ],
      body: '{"a":',
      truncated: true,
    });
    expect(texts(block.head).filter((line) => line.startsWith('Host:'))).toEqual(['Host: op.example.com']);
    const token = longs(block.head)[0];
    expect(token?.text).toBe(ACCESS_TOKEN);
    expect(token?.jwt?.header).toEqual({ alg: 'RS256', typ: 'at+jwt', kid: 'key-1' });
    expect(block.bodyKind).toBe('text');
    expect(block.notes).toEqual([TRUNCATED_NOTE]);
  });
});

describe('responseBlock', () => {
  it('should write the status line with its reason, and pretty-print a JSON body with a JWT shortened in the middle', () => {
    const block = responseBlock(exchange.response);
    expect(texts(block.head)).toEqual(['HTTP/1.1 200 OK', 'Cache-Control: no-store', 'Content-Type: application/json']);
    expect(block.bodyKind).toBe('json');
    expect(texts(block.body)).toEqual(['{', `  "access_token": "${ACCESS_TOKEN}",`, '  "token_type": "Bearer",', '  "expires_in": 3600,', '  "scope": "openid offline_access"', '}']);
    const [token] = longs(block.body);
    expect(token?.head).toBe(ACCESS_TOKEN.slice(0, 20));
    expect(token?.tail).toBe(ACCESS_TOKEN.slice(-8));
    expect(token?.jwt?.payload).toEqual({ iss: 'https://op.example.com', sub: 'user-1', iat: 1767225600, exp: 1767229200 });
    expect(block.notes).toEqual([]);
  });

  it('should show the Location of a redirect with its query one parameter a line, and its fragment the same way', () => {
    const block = responseBlock({
      status: 302,
      headers: [['location', 'https://rp.example.com/callback?code=abc&state=x%20y#id_token=t&state=s']],
    });
    expect(texts(block.head)).toEqual([
      'HTTP/1.1 302 Found',
      'Location: https://rp.example.com/callback',
      '    ?code=abc',
      '    &state=x y',
      '    #id_token=t',
      '    &state=s',
    ]);
    expect(block.body).toEqual([]);
    expect(block.bodyKind).toBeUndefined();
    expect(block.notes).toEqual([DECODED_NOTE]);
  });

  it('should keep the status text the response had, and a Location without a query on one line', () => {
    const block = responseBlock({ status: 303, statusText: 'See Other (custom)', headers: [['location', '/login']] });
    expect(texts(block.head)).toEqual(['HTTP/1.1 303 See Other (custom)', 'Location: /login']);
  });

  it('should show a JWT body (application/jwt) as one long value with its decoded parts', () => {
    const block = responseBlock({ status: 200, headers: [['content-type', 'application/jwt']], body: ACCESS_TOKEN });
    expect(block.bodyKind).toBe('jwt');
    expect(longs(block.body)[0]?.jwt?.header.alg).toBe('RS256');
  });
});

describe('the reading of values', () => {
  it('should write header names as the RFCs do', () => {
    expect(['content-type', 'www-authenticate', 'dpop', 'x-request-id', 'etag', 'Cache-Control'].map(headerName)).toEqual(['Content-Type', 'WWW-Authenticate', 'DPoP', 'X-Request-Id', 'ETag', 'Cache-Control']);
  });

  it('should give a status its reason phrase, and nothing for one it does not know', () => {
    expect([reasonPhrase(200), reasonPhrase(401), reasonPhrase(400, ''), reasonPhrase(599), reasonPhrase(200, 'Fine')]).toEqual(['OK', 'Unauthorized', 'Bad Request', '', 'Fine']);
  });

  it('should tell an answer, a redirect and an error apart by the status', () => {
    expect([200, 204, 302, 400, 401, 500].map(statusTone)).toEqual(['ok', 'ok', 'redirect', 'error', 'error', 'error']);
  });

  it('should decode the credentials of Basic, form-decoding both parts, and nothing for another scheme or a broken value', () => {
    expect(basicCredentials('Basic Y2xpZW50LTE6Y2xpZW50LTEtc2VjcmV0LXZhbHVl')).toBe('client-1:client-1-secret-value');
    expect(basicCredentials(`Basic ${btoa('my%20client:p%40ss')}`)).toBe('my client:p@ss');
    expect(basicCredentials('Bearer abc')).toBeUndefined();
    expect(basicCredentials('Basic !!!')).toBeUndefined();
    expect(basicCredentials(`Basic ${btoa('no-colon')}`)).toBeUndefined();
  });

  it('should decode a JWT without verifying it, and not a text that only looks like one', () => {
    expect(decodeJwt(ACCESS_TOKEN)).toEqual({ header: { alg: 'RS256', typ: 'at+jwt', kid: 'key-1' }, payload: { iss: 'https://op.example.com', sub: 'user-1', iat: 1767225600, exp: 1767229200 } });
    expect(decodeJwt(`${base64Url('{"alg":"none"}')}.${base64Url('not json')}.`)).toEqual({ header: { alg: 'none' } });
    expect(decodeJwt('a.b.c')).toBeUndefined();
    expect(decodeJwt(`${base64Url('[1]')}.e30.x`)).toBeUndefined();
    expect(decodeJwt('eyJhbGciOiJSUzI1NiJ9.e30')).toBeUndefined();
  });

  it('should shorten a long token in the middle, and leave short values, URLs and words whole', () => {
    expect(shorten('a'.repeat(70))).toEqual({ head: 'a'.repeat(20), tail: 'a'.repeat(8) });
    expect(shorten('a'.repeat(63))).toBeUndefined();
    expect(shorten(`https://rp.example.com/${'a'.repeat(80)}`)).toBeUndefined();
    expect(shorten(`${'word '.repeat(20)}`)).toBeUndefined();
    expect(shorten(ACCESS_TOKEN, true)).toBeDefined();
    expect(valuePieces('short', 'v')).toEqual([{ kind: 'text', text: 'short' }]);
  });

  it('should keep a form value that is no valid encoding as it was sent', () => {
    const { lines, decoded } = formLines('a=%E3%81%82&b=100%&c');
    expect(texts(lines)).toEqual(['a=あ', '&b=100%', '&c=']);
    expect(decoded).toBe(true);
  });

  it('should pretty-print nested JSON, short arrays on one line, and the dates of the time claims when asked', () => {
    const lines = jsonLines({ sub: 'user-1', aud: ['a', 'b'], nested: { list: [{ x: 1 }], empty: {}, none: [] }, iat: 1767225600, ok: true, gone: null }, 'p', true);
    expect(texts(lines)).toEqual([
      '{',
      '  "sub": "user-1",',
      '  "aud": ["a", "b"],',
      '  "nested": {',
      '    "list": [',
      '      {',
      '        "x": 1',
      '      }',
      '    ],',
      '    "empty": {},',
      '    "none": []',
      '  },',
      '  "iat": 1767225600,  // 2026-01-01T00:00:00Z',
      '  "ok": true,',
      '  "gone": null',
      '}',
    ]);
    expect(claimDate(-1)).toBeUndefined();
  });

  it('should tell the kind of a body by its Content-Type, else by what it reads as', () => {
    expect(bodyKind([['content-type', 'application/json; charset=utf-8']], '{"a":1}')).toBe('json');
    expect(bodyKind([['content-type', 'application/json']], 'not json')).toBe('text');
    expect(bodyKind([['content-type', 'text/html']], '<html></html>')).toBe('text');
    expect(bodyKind([], '{"a":1}')).toBe('json');
    expect(bodyKind([], 'a=1&b=2')).toBe('form');
    expect(bodyKind([], ACCESS_TOKEN)).toBe('jwt');
    expect(bodyKind([], 'plain words')).toBe('text');
  });
});

describe('errorCodeOf', () => {
  it('should read the OAuth error of a JSON body, of the query of a redirect, and of a WWW-Authenticate', () => {
    expect(errorCodeOf({ status: 400, headers: [], body: '{"error":"invalid_grant","error_description":"used"}' })).toBe('invalid_grant');
    expect(errorCodeOf({ status: 302, headers: [['location', 'https://rp.example.com/cb?error=access_denied&state=s']] })).toBe('access_denied');
    expect(errorCodeOf({ status: 302, headers: [['location', 'https://rp.example.com/cb#state=s&error=login_required']] })).toBe('login_required');
    expect(errorCodeOf({ status: 401, headers: [['www-authenticate', 'Bearer error="invalid_token", error_description="expired"']] })).toBe('invalid_token');
  });

  it('should find no error in a successful answer or a body cut short', () => {
    expect(errorCodeOf(exchange.response)).toBeUndefined();
    expect(errorCodeOf({ status: 400, headers: [], body: '{"error":"x"}', truncated: true })).toBeUndefined();
    expect(errorCodeOf({ status: 302, headers: [['location', 'https://rp.example.com/cb?code=c']] })).toBeUndefined();
  });
});

describe('previewOf', () => {
  it('should say a request and its answer in one line, by the grant_type of a form body', () => {
    expect(previewOf(exchange)).toBe('POST /token · grant_type=authorization_code → 200');
  });

  it('should take the response_type of a query, else the first parameter, and shorten a long value', () => {
    expect(previewOf({ request: { method: 'GET', path: '/authorize?client_id=c&response_type=code', host: 'h', headers: [] }, response: { status: 302, headers: [] } })).toBe('GET /authorize · response_type=code → 302');
    expect(previewOf({ request: { method: 'POST', path: '/revoke', host: 'h', headers: [['content-type', 'application/x-www-form-urlencoded']], body: `token=${'t'.repeat(40)}` }, response: { status: 200, headers: [] } })).toBe(`POST /revoke · token=${'t'.repeat(24)}… → 200`);
    expect(previewOf({ request: { method: 'GET', path: '/jwks', host: 'h', headers: [] }, response: { status: 200, headers: [] } })).toBe('GET /jwks → 200');
  });
});
