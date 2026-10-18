import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { CSRF_TOKEN, TRANSACTION_ID, sampleTransaction } from '../../../../test-support/screens.js';
import { renderView } from '../../../views.js';
import { describeLoginScreen } from './describe-login-screen.js';

describe('describeLoginScreen', () => {
  // OIDC Core 1.0 §3.1.2.1: login_hint pre-fills the form.
  it('should describe the csrf_token and the login_hint of the transaction', async () => {
    const { c } = await providerContext();

    const screen = await describeLoginScreen(c, TRANSACTION_ID, sampleTransaction({ loginHint: 'alice' }));

    expect(screen).toEqual({ kind: 'screen', csrfToken: CSRF_TOKEN, loginHint: 'alice', loginMethods: [] });
  });

  it('should offer no other login method while none is configured', async () => {
    const { c } = await providerContext();

    const screen = await describeLoginScreen(c, TRANSACTION_ID, sampleTransaction());

    expect(screen).toEqual({ kind: 'screen', csrfToken: CSRF_TOKEN, loginHint: undefined, loginMethods: [] });
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
