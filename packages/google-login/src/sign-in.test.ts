import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as signIn from './sign-in.js';
import {
  assertGoogleLoginUri,
  buildGoogleSignInAttributes,
  googleSignInAttributesToHtml,
  GOOGLE_GSI_CLIENT_SCRIPT_URL,
  GOOGLE_SIGN_IN_BUTTON_CLASS,
  GOOGLE_SIGN_IN_CSP_SOURCES,
  GOOGLE_SIGN_IN_ONLOAD_ID,
} from './sign-in.js';

const CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';
const LOGIN_URI = 'https://op.example.com/login/google';
const NONCE = 'AbCdEf0123456789-_AbCdEf0123456789-_AbCdEf0';

describe('sign-in entry point', () => {
  // フロント（ブラウザ / React / Vue）から import されるサブパスなので、公開 API を固定する。
  it('should export the front-end API', () => {
    expect(Object.keys(signIn).sort()).toEqual(
      [
        'GOOGLE_GSI_CLIENT_SCRIPT_URL',
        'GOOGLE_SIGN_IN_BUTTON_CLASS',
        'GOOGLE_SIGN_IN_CSP_SOURCES',
        'GOOGLE_SIGN_IN_ONLOAD_ID',
        'assertGoogleLoginUri',
        'buildGoogleSignInAttributes',
        'googleSignInAttributesToHtml',
      ].sort(),
    );
  });

  // google-auth-library（Node 専用）を引き込まないよう、このモジュールは何も import しない。
  it('should not import anything so it can be bundled for the browser', () => {
    const source = readFileSync(new URL('./sign-in.ts', import.meta.url), 'utf8');

    expect(/^\s*import\s/m.test(source)).toBe(false);
  });

  // Google のドキュメント（GIS HTML API）で固定されている値。
  it('should pin the GIS client script URL and element names', () => {
    expect(GOOGLE_GSI_CLIENT_SCRIPT_URL).toBe('https://accounts.google.com/gsi/client');
    expect(GOOGLE_SIGN_IN_ONLOAD_ID).toBe('g_id_onload');
    expect(GOOGLE_SIGN_IN_BUTTON_CLASS).toBe('g_id_signin');
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

describe('buildGoogleSignInAttributes', () => {
  // Google のドキュメント（redirect mode）: g_id_onload に data-ux_mode="redirect" と data-login_uri を指定する
  it('should build the redirect mode configuration with the nonce', () => {
    expect(buildGoogleSignInAttributes({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: NONCE })).toEqual({
      id: 'g_id_onload',
      'data-client_id': CLIENT_ID,
      'data-ux_mode': 'redirect',
      'data-login_uri': LOGIN_URI,
      'data-nonce': NONCE,
    });
  });

  it('should keep the attributes in the order GIS documents them', () => {
    const attributes = buildGoogleSignInAttributes({
      clientId: CLIENT_ID,
      loginUri: LOGIN_URI,
      nonce: NONCE,
      loginHint: 'jsmith@example.com',
      hostedDomain: 'example.com',
    });

    expect(Object.keys(attributes)).toEqual([
      'id',
      'data-client_id',
      'data-ux_mode',
      'data-login_uri',
      'data-nonce',
      'data-login_hint',
      'data-hd',
    ]);
    expect(attributes['data-login_hint']).toBe('jsmith@example.com');
    expect(attributes['data-hd']).toBe('example.com');
  });

  // undefined のキーが残ると、spread した先で data-login_hint="undefined" になりうる。
  it('should omit optional attributes that are not given', () => {
    const attributes = buildGoogleSignInAttributes({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: NONCE });

    expect('data-login_hint' in attributes).toBe(false);
    expect('data-hd' in attributes).toBe(false);
  });

  it('should return a plain object that spreads into a framework element', () => {
    const attributes = buildGoogleSignInAttributes({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: NONCE });
    const element = { className: 'login', ...attributes, 'data-context': 'signin' };

    expect(element).toEqual({
      className: 'login',
      id: 'g_id_onload',
      'data-client_id': CLIENT_ID,
      'data-ux_mode': 'redirect',
      'data-login_uri': LOGIN_URI,
      'data-nonce': NONCE,
      'data-context': 'signin',
    });
  });

  it('should reject an empty client ID', () => {
    expect(() => buildGoogleSignInAttributes({ clientId: '', loginUri: LOGIN_URI, nonce: NONCE })).toThrow(TypeError);
  });

  it('should reject an empty nonce', () => {
    expect(() => buildGoogleSignInAttributes({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: '' })).toThrow(TypeError);
  });

  it('should reject a login URI that Google would not accept', () => {
    expect(() =>
      buildGoogleSignInAttributes({ clientId: CLIENT_ID, loginUri: 'http://op.example.com/login/google', nonce: NONCE }),
    ).toThrow(TypeError);
  });
});

describe('googleSignInAttributesToHtml', () => {
  it('should serialize the attributes for a plain HTML template', () => {
    const attributes = buildGoogleSignInAttributes({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: NONCE });

    expect(googleSignInAttributesToHtml(attributes)).toBe(
      `id="g_id_onload" data-client_id="${CLIENT_ID}" data-ux_mode="redirect" data-login_uri="${LOGIN_URI}" data-nonce="${NONCE}"`,
    );
  });

  it('should escape attribute values', () => {
    const attributes = buildGoogleSignInAttributes({
      clientId: CLIENT_ID,
      loginUri: LOGIN_URI,
      nonce: NONCE,
      loginHint: '"><script>alert(1)</script>',
    });
    const html = googleSignInAttributesToHtml(attributes);

    expect(html.includes('<script>alert(1)</script>')).toBe(false);
    expect(html.includes('data-login_hint="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')).toBe(true);
  });

  it('should serialize extra GIS attributes and skip undefined ones', () => {
    const html = googleSignInAttributesToHtml({
      ...buildGoogleSignInAttributes({ clientId: CLIENT_ID, loginUri: LOGIN_URI, nonce: NONCE }),
      'data-auto_select': true,
      'data-width': 320,
      'data-context': undefined,
    });

    expect(html.endsWith(`data-nonce="${NONCE}" data-auto_select="true" data-width="320"`)).toBe(true);
    expect(html.includes('data-context')).toBe(false);
  });

  it('should reject an attribute name that could break out of the tag', () => {
    expect(() => googleSignInAttributesToHtml({ 'data-x="1" onload="alert(1)': 'y' })).toThrow(TypeError);
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
