import { describe, expect, it } from 'vitest';

import {
  assertGoogleLoginUri,
  buildGoogleSignInMarkup,
  escapeHtmlAttribute,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  GOOGLE_SIGN_IN_CSP_SOURCES,
} from './sign-in-markup.js';

const CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';
const LOGIN_URI = 'https://op.example.com/login/google';
const NONCE = 'AbCdEf0123456789-_AbCdEf0123456789-_AbCdEf0';

describe('escapeHtmlAttribute', () => {
  it('should escape the characters that break out of an attribute value', () => {
    expect(escapeHtmlAttribute(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });

  it('should leave safe characters untouched', () => {
    expect(escapeHtmlAttribute('https://op.example.com/login?x=1')).toBe('https://op.example.com/login?x=1');
  });
});

describe('assertGoogleLoginUri', () => {
  it('should accept an https URL', () => {
    expect(() => assertGoogleLoginUri('https://op.example.com/login/google')).not.toThrow();
  });

  it('should accept http on localhost for local development', () => {
    expect(() => assertGoogleLoginUri('http://localhost:3000/login/google')).not.toThrow();
    expect(() => assertGoogleLoginUri('http://127.0.0.1:3000/login/google')).not.toThrow();
  });

  it('should reject http on a public host', () => {
    expect(() => assertGoogleLoginUri('http://op.example.com/login/google')).toThrow(TypeError);
  });

  it('should reject a relative URL', () => {
    expect(() => assertGoogleLoginUri('/login/google')).toThrow(TypeError);
  });

  it('should reject a URL with a fragment', () => {
    expect(() => assertGoogleLoginUri('https://op.example.com/login/google#top')).toThrow(TypeError);
  });
});

describe('buildGoogleSignInMarkup', () => {
  // Google のドキュメント（redirect mode）: g_id_onload に data-ux_mode="redirect" と data-login_uri を指定する
  it('should render the client script, the redirect mode config and the button', () => {
    expect(buildGoogleSignInMarkup({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: NONCE })).toBe(
      [
        `<script src="${GOOGLE_GSI_CLIENT_SCRIPT_URL}" async></script>`,
        `<div id="g_id_onload" data-client_id="${CLIENT_ID}" data-ux_mode="redirect" data-login_uri="${LOGIN_URI}" data-nonce="${NONCE}"></div>`,
        '<div class="g_id_signin" data-type="standard"></div>',
      ].join('\n'),
    );
  });

  it('should render the optional onload attributes', () => {
    const html = buildGoogleSignInMarkup({
      clientId: CLIENT_ID,
      loginUri: LOGIN_URI,
      nonce: NONCE,
      loginHint: 'jsmith@example.com',
      hostedDomain: 'example.com',
      autoSelect: true,
      context: 'signin',
      itpSupport: true,
    });

    expect(html.split('\n')[1]).toBe(
      `<div id="g_id_onload" data-client_id="${CLIENT_ID}" data-ux_mode="redirect" data-login_uri="${LOGIN_URI}" data-nonce="${NONCE}" data-login_hint="jsmith@example.com" data-hd="example.com" data-auto_select="true" data-context="signin" data-itp_support="true"></div>`,
    );
  });

  it('should not emit data-auto_select when autoSelect is false', () => {
    const html = buildGoogleSignInMarkup({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: NONCE, autoSelect: false });

    expect(html.includes('data-auto_select')).toBe(false);
  });

  it('should render the button options', () => {
    const html = buildGoogleSignInMarkup({
      clientId: CLIENT_ID,
      loginUri: LOGIN_URI,
      nonce: NONCE,
      button: {
        type: 'icon',
        theme: 'filled_blue',
        size: 'medium',
        text: 'continue_with',
        shape: 'pill',
        logoAlignment: 'center',
        width: 320,
        locale: 'ja',
      },
    });

    expect(html.split('\n')[2]).toBe(
      '<div class="g_id_signin" data-type="icon" data-theme="filled_blue" data-size="medium" data-text="continue_with" data-shape="pill" data-logo_alignment="center" data-width="320" data-locale="ja"></div>',
    );
  });

  it('should omit the client script when includeClientScript is false', () => {
    const html = buildGoogleSignInMarkup({
      clientId: CLIENT_ID,
      loginUri: LOGIN_URI,
      nonce: NONCE,
      includeClientScript: false,
    });

    expect(html.split('\n').length).toBe(2);
    expect(html.includes('<script')).toBe(false);
  });

  it('should escape attribute values', () => {
    const html = buildGoogleSignInMarkup({
      clientId: CLIENT_ID,
      loginUri: LOGIN_URI,
      nonce: NONCE,
      loginHint: '"><script>alert(1)</script>',
    });

    expect(html.includes('<script>alert(1)</script>')).toBe(false);
    expect(html.includes('data-login_hint="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')).toBe(true);
  });

  it('should reject an empty client ID', () => {
    expect(() => buildGoogleSignInMarkup({ clientId: '', loginUri: LOGIN_URI, nonce: NONCE })).toThrow(TypeError);
  });

  it('should reject an empty nonce', () => {
    expect(() => buildGoogleSignInMarkup({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: '' })).toThrow(TypeError);
  });

  it('should reject a login URI that Google would not accept', () => {
    expect(() =>
      buildGoogleSignInMarkup({ clientId: CLIENT_ID, loginUri: 'http://op.example.com/login/google', nonce: NONCE }),
    ).toThrow(TypeError);
  });
});

describe('GOOGLE_SIGN_IN_CSP_SOURCES', () => {
  it('should list the GIS origins for each CSP directive', () => {
    expect(GOOGLE_SIGN_IN_CSP_SOURCES).toEqual({
      scriptSrc: 'https://accounts.google.com/gsi/client',
      frameSrc: 'https://accounts.google.com/gsi/',
      connectSrc: 'https://accounts.google.com/gsi/',
      styleSrc: 'https://accounts.google.com/gsi/style',
    });
  });
});
