import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { CSRF_TOKEN, TRANSACTION_ID, sampleTransaction } from '../../../../test-support/screens.js';
import { renderView } from '../../../views.js';
import { registerClient } from '../../../db/memory/clients.js';
import { describeLoginScreen } from './describe-login-screen.js';

describe('describeLoginScreen', () => {
  // OIDC Core 1.0 §3.1.2.1: login_hint pre-fills the form.
  it('should describe the csrf_token and the login_hint of the transaction', async () => {
    const { c } = await providerContext();

    const screen = await describeLoginScreen(c, TRANSACTION_ID, sampleTransaction({ loginHint: 'alice' }));

    expect(screen).toEqual({
      kind: 'screen',
      transactionId: 'txn-1',
      csrfToken: CSRF_TOKEN,
      loginHint: 'alice',
      client: { clientId: 'client-1' },
      loginMethods: [],
    });
  });

  it('should offer no other login method while none is configured', async () => {
    const { c } = await providerContext();

    const screen = await describeLoginScreen(c, TRANSACTION_ID, sampleTransaction());

    expect(screen).toEqual({
      kind: 'screen',
      transactionId: 'txn-1',
      csrfToken: CSRF_TOKEN,
      loginHint: undefined,
      client: { clientId: 'client-1' },
      loginMethods: [],
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2: the OP SHOULD display the client's name, logo and policies.
  it('should describe the name, logo and policies of the registered client', async () => {
    const { c, db } = await providerContext();
    await registerClient(db, {
      clientId: 'client-1',
      redirectUris: ['https://rp.example.com/callback'],
      clientName: 'Example RP',
      logoUri: 'https://rp.example.com/logo.png',
      policyUri: 'https://rp.example.com/privacy',
      tosUri: 'https://openid.net/terms',
      clientUri: 'http://rp.example.com/',
    });

    const screen = await describeLoginScreen(c, TRANSACTION_ID, sampleTransaction());

    // client_uri is http, so it is not shown (client-display.ts).
    expect(screen.client).toEqual({
      clientId: 'client-1',
      name: 'Example RP',
      logoUri: 'https://rp.example.com/logo.png',
      policyUri: 'https://rp.example.com/privacy',
      tosUri: 'https://openid.net/terms',
    });
  });

  describe('Login methods of the features', () => {
    it('should render the Sign in with Google button once config.googleLogin is set', async () => {
      const { c } = await providerContext({
        options: { config: { issuer: 'https://op.example.com', googleLogin: { clientId: 'google-client-id' } } },
      });

      const screen = await describeLoginScreen(c, TRANSACTION_ID, sampleTransaction({ loginHint: 'alice@example.com' }));

      expect(screen.loginMethods.length).toBe(1);
      const html = await renderView(screen.loginMethods[0]).text();
      expect(html).toContain('data-client_id="google-client-id"');
      expect(html).toContain('data-login_uri="https://op.example.com/login/google"');
      expect(html).toContain('data-login_hint="alice@example.com"');
    });

    it('should bind the nonce of the Google button to the transaction', async () => {
      const { c, db } = await providerContext({
        options: { config: { issuer: 'https://op.example.com', googleLogin: { clientId: 'google-client-id' } } },
      });
      const transaction = sampleTransaction();

      await describeLoginScreen(c, TRANSACTION_ID, transaction);

      expect([...db.upstreamLogins.values()]).toEqual([
        { provider: 'google', transactionId: TRANSACTION_ID, expiresAt: transaction.expiresAt },
      ]);
    });
  });
});
