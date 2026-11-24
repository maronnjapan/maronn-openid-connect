import { createHash, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateRequestScenario, requestScenariosFor, requestText } from '../premises.js';

describe('request scenarios', () => {
  it('should offer the Request Object purpose when the provider includes it', () => {
    expect(requestScenariosFor('authorize', ['request-object']).map(({ id }) => id)).toEqual([
      'authorize-code-pkce', 'authorize-request-object', 'authorize-prompt-none',
    ]);
    expect(requestScenariosFor('authorize', []).map(({ id }) => id)).toEqual(['authorize-code-pkce', 'authorize-prompt-none']);
    expect(requestScenariosFor('discovery', ['request-object'])).toEqual([]);
  });

  it('should generate a verifiable Request Object carrying the authorization parameters', async () => {
    const issuer = 'https://op.example.test/oidc/';
    const redirectUri = 'https://rp.example.test/callback';
    const generated = await generateRequestScenario('authorize-request-object', { issuer, clientId: 'signed-client', redirectUri });
    const url = new URL(generated.url);
    const [header = '', payload = '', signature = ''] = (url.searchParams.get('request') ?? '').split('.');
    const [key] = generated.registration.jwks?.keys ?? [];

    expect(url.pathname).toBe('/oidc/authorize');
    expect([...url.searchParams.keys()]).toEqual(['client_id', 'response_type', 'scope', 'request']);
    expect(url.searchParams.get('client_id')).toBe('signed-client');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', typ: 'oauth-authz-req+jwt', kid: key?.kid });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      aud: issuer,
      iss: 'signed-client',
      client_id: 'signed-client',
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid',
      state: expect.any(String),
      nonce: expect.any(String),
      iat: generated.issuedAt,
      exp: generated.issuedAt + 300,
      jti: expect.any(String),
      code_challenge: createHash('sha256').update(generated.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    expect(key).not.toHaveProperty('d');
    expect(key !== undefined && verify('sha256', Buffer.from(`${header}.${payload}`), { key, format: 'jwk', dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(requestText(generated.request)).toBe(`GET /oidc/authorize${url.search} HTTP/1.1\r\nHost: op.example.test\r\n\r\n`);
  });

  it('should generate each authorization request using the selected purpose and fresh state', async () => {
    const first = await generateRequestScenario('authorize-code-pkce');
    const signed = await generateRequestScenario('authorize-request-object');
    const silent = await generateRequestScenario('authorize-prompt-none');
    const again = await generateRequestScenario('authorize-code-pkce');
    const searchOf = (url: string) => new URL(url).searchParams;

    expect(searchOf(first.url).get('code_challenge')).toBe(createHash('sha256').update(first.codeVerifier).digest('base64url'));
    expect(searchOf(first.url).has('prompt')).toBe(false);
    expect(searchOf(signed.url).has('request')).toBe(true);
    expect(searchOf(silent.url).get('prompt')).toBe('none');
    expect(searchOf(silent.url).has('request')).toBe(false);
    expect(searchOf(again.url).get('state')).not.toBe(searchOf(first.url).get('state'));
  });
});
