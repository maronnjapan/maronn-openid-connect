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
    allowHeaders: ['Authorization', 'DPoP'],
    exposeHeaders: ['WWW-Authenticate'],
    maxAge: 600,
  };

  // Fetch Standard §3.2.3: the response headers a browser lets the client read.
  it('should name the headers the client may read in Access-Control-Expose-Headers', () => {
    const response = corsPreflight(new Request('https://op.example.com/userinfo', { method: 'OPTIONS' }), policy);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,DPoP');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate');
  });

  it('should send no Access-Control-Expose-Headers for a policy that exposes no header', () => {
    const response = corsPreflight(new Request('https://op.example.com/.well-known/jwks.json', { method: 'OPTIONS' }), {
      ...policy,
      exposeHeaders: undefined,
    });

    expect(response.headers.has('Access-Control-Expose-Headers')).toBe(false);
  });
});

describe('clientCors', () => {
  // The dpop extension lets a browser send its DPoP proof (RFC 9449 §4.1) and read
  // the DPoP challenge of a failure (RFC 9449 §7.1).
  it('should add the headers of the enabled features to the endpoints clients call directly', () => {
    const response = withCors(new Request('https://op.example.com/token', { method: 'POST' }), clientCors, new Response(null, { status: 401 }));

    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST,GET,OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,Content-Type,DPoP');
    expect(response.headers.get('Access-Control-Expose-Headers')).toBe('WWW-Authenticate');
  });
});
