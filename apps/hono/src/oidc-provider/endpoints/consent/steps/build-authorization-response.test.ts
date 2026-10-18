import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { REDIRECT_URI, decodeJwt, sampleTransaction, verifiesWithRs256 } from '../../../../test-support/screens.js';
import type { ResponseModeTransaction } from '../../authorize/response-mode.js';
import { buildConsentRedirect } from './build-authorization-response.js';

const ISSUER = 'https://op.example.com';
const CLEARED_TRANSACTION_COOKIE = '__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

describe('buildConsentRedirect', () => {
  describe('Query response mode', () => {
    // RFC 6749 §4.1.2 / RFC 9207 §2: code, state and iss as query parameters.
    it('should put the parameters and iss into the query of the redirect URI and clear the transaction cookie', async () => {
      const { c } = await providerContext();

      expect(
        await buildConsentRedirect(c, sampleTransaction(), REDIRECT_URI, { code: 'code-1', state: 'state-1' }, ISSUER),
      ).toEqual({
        kind: 'authorization_response',
        location: 'https://rp.example.com/callback?code=code-1&state=state-1&iss=https%3A%2F%2Fop.example.com',
        cookies: [CLEARED_TRANSACTION_COOKIE],
      });
    });

    it('should leave out a parameter without a value', async () => {
      const { c } = await providerContext();

      const outcome = await buildConsentRedirect(
        c,
        sampleTransaction(),
        REDIRECT_URI,
        { code: 'code-1', state: undefined },
        ISSUER,
      );

      expect(outcome).toMatchObject({
        location: 'https://rp.example.com/callback?code=code-1&iss=https%3A%2F%2Fop.example.com',
      });
    });

    // RFC 6749 §3.1.2: the query component of the redirection endpoint is retained.
    it('should keep the query the redirect URI already has', async () => {
      const { c } = await providerContext();

      const outcome = await buildConsentRedirect(
        c,
        sampleTransaction(),
        'https://rp.example.com/callback?tenant=a',
        { code: 'code-1' },
        ISSUER,
      );

      expect(outcome).toMatchObject({
        location: 'https://rp.example.com/callback?tenant=a&code=code-1&iss=https%3A%2F%2Fop.example.com',
      });
    });
  });

  describe('Response mode of a feature', () => {
    // JARM §2.3.1: the parameters are signed into the single response query parameter.
    it('should answer a query.jwt transaction with a signed response JWT instead of plain parameters', async () => {
      const { c, signingKey } = await providerContext();
      const transaction: ResponseModeTransaction = { ...sampleTransaction(), responseMode: 'query.jwt' };

      const outcome = await buildConsentRedirect(c, transaction, REDIRECT_URI, { code: 'code-1', state: 'state-1' }, ISSUER);

      expect(outcome).toMatchObject({ kind: 'authorization_response', cookies: [CLEARED_TRANSACTION_COOKIE] });
      const location = new URL((outcome as { location: string }).location);
      const responseJwt = location.searchParams.get('response') ?? '';
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect([...location.searchParams.keys()]).toEqual(['response']);
      expect(decodeJwt(responseJwt).payload).toMatchObject({
        code: 'code-1',
        state: 'state-1',
        iss: ISSUER,
        aud: 'client-1',
      });
      expect(await verifiesWithRs256(responseJwt, signingKey)).toBe(true);
    });

    it('should fail for a response mode no enabled feature answers in', async () => {
      const { c } = await providerContext();
      const transaction: ResponseModeTransaction = { ...sampleTransaction(), responseMode: 'form_post' };

      await expect(buildConsentRedirect(c, transaction, REDIRECT_URI, { code: 'code-1' }, ISSUER)).rejects.toThrow(
        'No enabled feature answers in the response mode "form_post"',
      );
    });
  });
});
