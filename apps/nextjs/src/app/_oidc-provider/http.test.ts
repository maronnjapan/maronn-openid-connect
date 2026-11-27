import { describe, expect, it } from 'vitest';
import { clientCors, corsPreflight, readBearerToken, withCors, type CorsPolicy } from './http';

describe('readBearerToken', () => {
  // RFC 6750 §2.1
  it('should read the token of the Bearer scheme', () => {
    expect(readBearerToken('Bearer token-1')).toBe('token-1');
  });

  // RFC 7235 §2.1: the authentication scheme is case-insensitive; the token is kept verbatim.
  it('should match the scheme case-insensitively and keep the token as it is', () => {
    expect(readBearerToken('bEaReR Token-ABC')).toBe('Token-ABC');
  });

  // RFC 6750 §2.1: credentials = "Bearer" 1*SP b64token — one or more spaces follow the scheme.
  it('should read the token after several spaces following the scheme', () => {
    expect(readBearerToken('Bearer   token-1')).toBe('token-1');
  });

  it('should read no token from another scheme, a scheme without a token, or an empty header', () => {
    expect(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearertoken-1', ''].map(readBearerToken)).toEqual(['', '', '', '']);
  });
});

describe('corsPreflight', () => {
  const policy: CorsPolicy = {
    origins: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'X-Example'],
    exposeHeaders: ['WWW-Authenticate', 'X-Example-Nonce'],
    maxAge: 600,
  };

  // Fetch Standard §3.2.3: the response headers a browser lets the client read.
  it('should name the headers the client may read in Access-Control-Expose-Headers', () => {
    const response = corsPreflight(new Request('https://op.example.com/userinfo', { method: 'OPTIONS' }), policy);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,X-Example');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate,X-Example-Nonce');
  });

  // Only the CORS-safelisted response headers are readable without it, as before the member existed.
  it('should send no Access-Control-Expose-Headers for a policy that exposes no header', () => {
    const request = new Request('https://op.example.com/userinfo', { method: 'OPTIONS' });

    const leftOut = corsPreflight(request, { ...policy, exposeHeaders: undefined });
    const empty = corsPreflight(request, { ...policy, exposeHeaders: [] });

    expect(leftOut.headers.has('Access-Control-Expose-Headers')).toBe(false);
    expect(empty.headers.has('Access-Control-Expose-Headers')).toBe(false);
  });
});

describe('withCors', () => {
  it('should put the Access-Control-Expose-Headers of the policy on the answer', async () => {
    const policy: CorsPolicy = { origins: '*', allowMethods: ['GET'], allowHeaders: ['Authorization'], exposeHeaders: ['WWW-Authenticate'], maxAge: 600 };
    const answer = new Response('{}', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="UserInfo"' } });

    const response = withCors(new Request('https://op.example.com/userinfo'), policy, answer);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="UserInfo"');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate');
    expect(await response.text()).toBe('{}');
  });
});

describe('clientCors', () => {
  // No enabled feature names a header of its own (the cors hook of feature.ts).
  it('should keep the headers of the provider while no feature names one', () => {
    const response = withCors(new Request('https://op.example.com/token', { method: 'POST' }), clientCors, new Response(null, { status: 401 }));

    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST,GET,OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,Content-Type');
    expect(response.headers.has('Access-Control-Expose-Headers')).toBe(false);
  });
});
