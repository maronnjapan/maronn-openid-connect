/** @jsxImportSource hono/jsx */
import type { GoogleSignInAttributes } from '@maronn-openid-connect/google-login/sign-in';
import { describe, expect, it } from 'vitest';
import { contextOf, providerContext } from '../../../test-support/context.js';
import { htmlOf } from '../../../test-support/extensions.js';
import { googleViews, type GoogleSignInParams } from './views.js';

const googleSignIn: GoogleSignInAttributes = {
  id: 'g_id_onload',
  'data-client_id': 'google-client-id',
  'data-ux_mode': 'redirect',
  'data-login_uri': 'https://op.example.com/login/google',
  'data-nonce': 'nonce-"1"',
};

function customButton(params: GoogleSignInParams) {
  return <a href="/custom-google">{params.googleSignIn['data-nonce']}</a>;
}

describe('googleViews', () => {
  it('should render the GIS script, the g_id_onload configuration and the button by default, escaping the values', async () => {
    const { c } = await providerContext();

    const html = await htmlOf(googleViews(c).googleSignInButton({ googleSignIn }));

    expect(html).toBe(
      '<hr/><section aria-label="Sign in with Google">' +
        '<script src="https://accounts.google.com/gsi/client" async=""></script>' +
        '<div id="g_id_onload" data-client_id="google-client-id" data-ux_mode="redirect" ' +
        'data-login_uri="https://op.example.com/login/google" data-nonce="nonce-&quot;1&quot;"></div>' +
        '<div class="g_id_signin" data-type="standard"></div></section>',
    );
  });

  it('should use the button the views option replaced', async () => {
    const { c } = await providerContext({ options: { views: { googleSignInButton: customButton } } });

    expect(googleViews(c).googleSignInButton).toBe(customButton);
  });

  it('should fall back to the default button when the context has no views', async () => {
    const { c } = await providerContext();

    expect(googleViews(contextOf()).googleSignInButton).toBe(googleViews(c).googleSignInButton);
  });
});
