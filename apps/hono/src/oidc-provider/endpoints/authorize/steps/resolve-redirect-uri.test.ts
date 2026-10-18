import type { ClientInfo } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { CLIENT_ID, REDIRECT_URI, STATE } from '../../../../test-support/authorize.js';
import { resolveRedirectTarget } from './resolve-redirect-uri.js';

const client: ClientInfo = { clientId: CLIENT_ID, clientType: 'confidential', redirectUris: [REDIRECT_URI] };

describe('resolveRedirectTarget', () => {
  describe('Resolved target', () => {
    // OIDC Core 1.0 §3.1.2.1: redirect_uri MUST exactly match a registered one.
    it('should return the registered redirect_uri the request names, with the state', () => {
      expect(resolveRedirectTarget({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state: STATE }, client)).toEqual({
        redirectUri: REDIRECT_URI,
        state: STATE,
      });
    });

    it('should fall back to the only registered redirect_uri when the request leaves it out', () => {
      expect(resolveRedirectTarget({ client_id: CLIENT_ID }, client)).toEqual({
        redirectUri: REDIRECT_URI,
        state: undefined,
      });
    });

    // RFC 8252 §7.3: a native (public) client may listen on any loopback port.
    it('should accept a loopback redirect_uri on another port for a public client', () => {
      const publicClient: ClientInfo = {
        clientId: CLIENT_ID,
        clientType: 'public',
        redirectUris: ['http://127.0.0.1:8080/callback'],
      };

      expect(resolveRedirectTarget({ client_id: CLIENT_ID, redirect_uri: 'http://127.0.0.1:51234/callback' }, publicClient)).toEqual({
        redirectUri: 'http://127.0.0.1:51234/callback',
        state: undefined,
      });
    });
  });

  // OIDC Core 1.0 §3.1.2.2: these errors stay on the OP (no redirectUri).
  describe('Errors that are not redirectable', () => {
    it('should reject a redirect_uri that is not registered', () => {
      expect(() =>
        resolveRedirectTarget({ client_id: CLIENT_ID, redirect_uri: 'https://attacker.example.com/callback', state: STATE }, client),
      ).toThrow(expect.objectContaining({
        error: 'invalid_request',
        errorDescription: 'redirect_uri not registered',
        redirectUri: undefined,
      }));
    });

    // OIDC Core 1.0 §3.1.2.1: redirect_uri MUST NOT include a fragment.
    it('should reject a redirect_uri with a fragment', () => {
      expect(() => resolveRedirectTarget({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI + '#x' }, client)).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription: 'redirect_uri must not contain fragment',
          redirectUri: undefined,
        }),
      );
    });

    it('should require redirect_uri when the client registered more than one', () => {
      const twoUris: ClientInfo = { ...client, redirectUris: [REDIRECT_URI, 'https://rp.example.com/other'] };

      expect(() => resolveRedirectTarget({ client_id: CLIENT_ID }, twoUris)).toThrow(
        expect.objectContaining({
          error: 'invalid_request',
          errorDescription: 'redirect_uri is required when multiple redirect URIs are registered',
          redirectUri: undefined,
        }),
      );
    });
  });
});
