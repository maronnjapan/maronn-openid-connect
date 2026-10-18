import { describe, expect, it } from 'vitest';
import { providerContext } from '../../../test-support/context.js';
import { htmlOf, storeTransaction } from '../../../test-support/extensions.js';
import type { GoogleLoginConfig } from './config.js';
import { buildGoogleSignIn, googleLoginMethod } from './login-method.js';

const NONCE = /^[A-Za-z0-9_-]{43}$/;

async function loginPageContext(googleLogin?: GoogleLoginConfig) {
  const context = await providerContext({ options: { config: googleLogin ? { googleLogin } : {} } });
  const transaction = await storeTransaction(context.stores, 'txn-1', { loginHint: 'alice@gmail.com' });
  return { ...context, transaction };
}

describe('buildGoogleSignIn', () => {
  it('should build nothing and issue no nonce while config.googleLogin is not set', async () => {
    const { c, db, transaction } = await loginPageContext();

    expect(await buildGoogleSignIn(c, 'txn-1', transaction)).toBeUndefined();
    expect(db.upstreamLogins.size).toBe(0);
  });

  // GIS redirect mode: the nonce Google echoes in the ID token leads the callback back to this transaction.
  it('should build the redirect-mode attributes with a new nonce bound to the transaction', async () => {
    const { c, db, transaction } = await loginPageContext({ clientId: 'google-client-id', hostedDomain: 'example.com' });

    const attributes = await buildGoogleSignIn(c, 'txn-1', transaction);

    const nonce = attributes!['data-nonce'];
    expect(attributes).toEqual({
      id: 'g_id_onload',
      'data-client_id': 'google-client-id',
      'data-ux_mode': 'redirect',
      'data-login_uri': 'https://op.example.com/login/google',
      'data-nonce': expect.stringMatching(NONCE),
      // OIDC Core 1.0 §3.1.2.1: login_hint is passed on so Google can preselect the account.
      'data-login_hint': 'alice@gmail.com',
      'data-hd': 'example.com',
    });
    expect([...db.upstreamLogins.entries()]).toEqual([
      [nonce, { provider: 'google', transactionId: 'txn-1', expiresAt: transaction.expiresAt }],
    ]);
  });

  it('should leave data-hd out when several hosted domains are allowed', async () => {
    const { c, transaction } = await loginPageContext({ clientId: 'google-client-id', hostedDomain: ['a.example', 'b.example'] });

    const attributes = await buildGoogleSignIn(c, 'txn-1', transaction);

    expect(Object.keys(attributes!)).toEqual([
      'id',
      'data-client_id',
      'data-ux_mode',
      'data-login_uri',
      'data-nonce',
      'data-login_hint',
    ]);
  });

  it('should replace the nonce of an earlier rendering of the same transaction', async () => {
    const { c, db, transaction } = await loginPageContext({ clientId: 'google-client-id' });

    await buildGoogleSignIn(c, 'txn-1', transaction);
    const latest = await buildGoogleSignIn(c, 'txn-1', transaction);

    expect([...db.upstreamLogins.keys()]).toEqual([latest!['data-nonce']]);
  });
});

describe('googleLoginMethod', () => {
  it('should be the google login method', () => {
    expect(googleLoginMethod.id).toBe('google');
  });

  it('should render nothing while config.googleLogin is not set', async () => {
    const { c, transaction } = await loginPageContext();

    expect(await googleLoginMethod.render(c, { transactionId: 'txn-1', transaction })).toBeUndefined();
  });

  it('should render the Sign in with Google button with the attributes of the transaction', async () => {
    const { c, db, transaction } = await loginPageContext({ clientId: 'google-client-id' });

    const html = await htmlOf((await googleLoginMethod.render(c, { transactionId: 'txn-1', transaction }))!);

    const [nonce] = [...db.upstreamLogins.keys()];
    expect(html).toBe(
      '<hr/><section aria-label="Sign in with Google">' +
        '<script src="https://accounts.google.com/gsi/client" async=""></script>' +
        '<div id="g_id_onload" data-client_id="google-client-id" data-ux_mode="redirect" ' +
        `data-login_uri="https://op.example.com/login/google" data-nonce="${nonce}" data-login_hint="alice@gmail.com"></div>` +
        '<div class="g_id_signin" data-type="standard"></div></section>',
    );
  });
});
