import type { AuthTransaction } from '@maronn-openid-connect/core';
import { GOOGLE_GSI_CLIENT_SCRIPT_URL } from '@maronn-openid-connect/google-login/sign-in';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapKvDatabase } from '../../../../test-support/databases';
import { createProviderConfig } from '../../config';
import { createProviderStores } from '../../db/kv/stores';
import type { GoogleLoginConfig } from './config';
import { buildGoogleSignIn, googleLoginMethod } from './login-method';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW_MS = Date.UTC(2026, 0, 1);
const NONCE = /^[A-Za-z0-9_-]{43}$/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

/** An authorization request waiting on the login page for ten more minutes. */
function transaction(overrides: Partial<AuthTransaction> = {}): AuthTransaction {
  return {
    clientId: 'rp-1',
    redirectUri: 'https://rp.example.com/callback',
    redirectUriExplicit: true,
    responseType: 'code',
    scope: 'openid',
    csrfToken: 'csrf-1',
    createdAt: NOW_MS,
    expiresAt: NOW_MS + 600_000,
    failedAttempts: 0,
    ...overrides,
  };
}

/** The input page.tsx hands a login method: the stores on a database of the test. */
function loginPageInput(googleLogin?: GoogleLoginConfig, overrides: Partial<AuthTransaction> = {}) {
  const db = createMapKvDatabase();
  const stores = createProviderStores(db);
  return {
    db,
    input: {
      transactionId: 'txn-1',
      transaction: transaction(overrides),
      config: createProviderConfig({ issuer: 'https://op.example.com', googleLogin }),
      stores,
    },
  };
}

describe('buildGoogleSignIn', () => {
  it('should build nothing and issue no nonce while config.googleLogin is not set', async () => {
    const { db, input } = loginPageInput();

    expect(await buildGoogleSignIn(input)).toBeUndefined();
    expect(db.entries()).toEqual([]);
  });

  // GIS redirect mode: Google posts the ID token to data-login_uri, and echoes
  // data-nonce in it, which leads the callback back to this transaction.
  it('should build the redirect-mode attributes with a nonce bound to the transaction until it expires', async () => {
    const { input } = loginPageInput({ clientId: 'google-client-id', hostedDomain: 'example.com' }, { loginHint: 'alice@gmail.com' });

    const attributes = await buildGoogleSignIn(input);
    const { 'data-nonce': nonce = '', ...others } = attributes ?? {};

    expect(others).toEqual({
      id: 'g_id_onload',
      'data-client_id': 'google-client-id',
      'data-ux_mode': 'redirect',
      'data-login_uri': 'https://op.example.com/login/google',
      // OIDC Core 1.0 §3.1.2.1: login_hint is passed on so Google can preselect the account.
      'data-login_hint': 'alice@gmail.com',
      'data-hd': 'example.com',
    });
    expect(nonce).toMatch(NONCE);
    expect(await input.stores.upstreamLoginStore.find(nonce)).toEqual({
      provider: 'google',
      transactionId: 'txn-1',
      expiresAt: NOW_MS + 600_000,
    });
  });

  it('should leave out data-login_hint and data-hd when there is no login_hint and no hosted domain', async () => {
    const { input } = loginPageInput({ clientId: 'google-client-id' });

    const attributes = await buildGoogleSignIn(input);

    expect(Object.keys(attributes ?? {})).toEqual([
      'id',
      'data-client_id',
      'data-ux_mode',
      'data-login_uri',
      'data-nonce',
    ]);
  });

  // data-hd takes one domain: with several, the account chooser is not narrowed
  // (the callback still checks hd against all of them).
  it('should leave out data-hd when several hosted domains are accepted', async () => {
    const { input } = loginPageInput({ clientId: 'google-client-id', hostedDomain: ['a.example.com', 'b.example.com'] });

    const attributes = await buildGoogleSignIn(input);

    expect(attributes?.['data-hd']).toBeUndefined();
  });

  it('should replace the nonce of an earlier render of the same transaction with a new one', async () => {
    const { input } = loginPageInput({ clientId: 'google-client-id' });
    const first = (await buildGoogleSignIn(input))?.['data-nonce'] ?? '';

    const second = (await buildGoogleSignIn(input))?.['data-nonce'] ?? '';

    expect(second).not.toBe(first);
    expect(await input.stores.upstreamLoginStore.find(first)).toBeUndefined();
    expect(await input.stores.upstreamLoginStore.find(second)).toEqual({
      provider: 'google',
      transactionId: 'txn-1',
      expiresAt: NOW_MS + 600_000,
    });
  });
});

describe('googleLoginMethod', () => {
  it('should be the login method named google', () => {
    expect(googleLoginMethod.id).toBe('google');
  });

  it('should render nothing while config.googleLogin is not set', async () => {
    const { input } = loginPageInput();

    expect(await googleLoginMethod.render(input)).toBeUndefined();
  });

  // GIS redirect mode: the g_id_onload configuration and the g_id_signin
  // element GIS replaces with the button.
  it('should render the g_id_onload configuration and the button element', async () => {
    const { input } = loginPageInput({ clientId: 'google-client-id', hostedDomain: 'example.com' }, { loginHint: 'alice@gmail.com' });

    const html = renderToStaticMarkup(await googleLoginMethod.render(input));
    const nonce = /data-nonce="([^"]*)"/.exec(html)?.[1] ?? '';

    expect(nonce).toMatch(NONCE);
    expect(html).toBe(
      '<section aria-label="Sign in with Google">' +
        '<div id="g_id_onload" data-client_id="google-client-id" data-ux_mode="redirect" ' +
        `data-login_uri="https://op.example.com/login/google" data-nonce="${nonce}" ` +
        'data-login_hint="alice@gmail.com" data-hd="example.com"></div>' +
        '<div class="g_id_signin" data-type="standard"></div>' +
        '</section>',
    );
    expect(await input.stores.upstreamLoginStore.find(nonce)).toMatchObject({ provider: 'google', transactionId: 'txn-1' });
  });

  // next/script injects the script on the client, so the static markup has no
  // <script>: the element itself names the GIS client and its loading strategy.
  it('should load the GIS client script once the page is interactive', async () => {
    const { input } = loginPageInput({ clientId: 'google-client-id' });

    const section = (await googleLoginMethod.render(input)) as ReactElement<{ children: ReactElement[] }>;
    const [script] = section.props.children;

    expect(script?.props).toEqual({ src: GOOGLE_GSI_CLIENT_SCRIPT_URL, strategy: 'afterInteractive' });
  });
});
