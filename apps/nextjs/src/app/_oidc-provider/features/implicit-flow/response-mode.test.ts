import { describe, expect, it, vi } from 'vitest';
import { providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import type { AuthorizationResponseMode } from '../../../authorize/response-mode';
import { createFragmentResponseMode, fragmentResponseModeHandler, implicitResponseModeOf } from './response-mode';

const ISSUER = 'https://op.example.com';
const REDIRECT_URI = 'https://rp.example.com/callback';

describe('createFragmentResponseMode', () => {
  it('should be named fragment', () => {
    expect(createFragmentResponseMode({ issuer: ISSUER }).name).toBe('fragment');
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / RFC 9207 §2:
  // the parameters and iss go into the fragment of the redirect URI.
  it('should redirect to the redirect URI with the parameters and iss in its fragment', async () => {
    const mode = createFragmentResponseMode({ issuer: ISSUER });

    expect(await mode.respond(REDIRECT_URI, { id_token: 'id-token-1', state: 'state-1' })).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback#id_token=id-token-1&state=state-1&iss=https%3A%2F%2Fop.example.com',
    });
  });

  // OIDC Core 1.0 §3.2.2.6: the error members go back the same way.
  it('should leave out a parameter whose value is undefined', async () => {
    const mode = createFragmentResponseMode({ issuer: ISSUER });

    expect(await mode.respond(REDIRECT_URI, { error: 'access_denied', state: undefined })).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback#error=access_denied&iss=https%3A%2F%2Fop.example.com',
    });
  });

  // RFC 6749 §3.1.2: the query of the redirection URI is retained.
  it('should keep the query the registered redirect URI has', async () => {
    const mode = createFragmentResponseMode({ issuer: ISSUER });

    expect(await mode.respond(`${REDIRECT_URI}?tenant=a`, { code: 'code-1' })).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback?tenant=a#code=code-1&iss=https%3A%2F%2Fop.example.com',
    });
  });
});

describe('implicitResponseModeOf', () => {
  it('should keep the response mode the request asked for', () => {
    const formPost: AuthorizationResponseMode = {
      name: 'form_post',
      respond: async (redirectUri) => ({ method: 'form_post', action: redirectUri, fields: {} }),
    };

    expect(implicitResponseModeOf(formPost, ISSUER)).toBe(formPost);
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: never the query.
  it('should answer in the fragment when no response mode was set', () => {
    expect(implicitResponseModeOf(undefined, ISSUER).name).toBe('fragment');
  });
});

describe('fragmentResponseModeHandler', () => {
  it('should restore the response mode named fragment', () => {
    expect(fragmentResponseModeHandler.names).toEqual(['fragment']);
  });

  // The fragment carries no signature, so no key is loaded for it.
  it('should restore a mode that adds the iss of the stored issuer without loading the keys', async () => {
    const loadSigningKeys = vi.fn(async () => providerSigningKeys(await rs256Key()));

    const mode = await fragmentResponseModeHandler.restore({
      name: 'fragment',
      clientId: 'client-1',
      issuer: 'https://issuer.example.com',
      loadSigningKeys,
    });

    expect(await mode.respond(REDIRECT_URI, { id_token: 'id-token-1' })).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback#id_token=id-token-1&iss=https%3A%2F%2Fissuer.example.com',
    });
    expect(loadSigningKeys).not.toHaveBeenCalled();
  });
});
