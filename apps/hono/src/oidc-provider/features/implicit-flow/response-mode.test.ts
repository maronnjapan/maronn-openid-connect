import { describe, expect, it } from 'vitest';
import { recordingResponseMode } from '../../../test-support/authorize.js';
import { TEST_ISSUER, contextOf } from '../../../test-support/context.js';
import {
  createFragmentResponseMode,
  fragmentResponseModeHandler,
  implicitResponseModeOf,
} from './response-mode.js';

const REDIRECT_URI = 'https://rp.example.com/callback';

describe('createFragmentResponseMode', () => {
  it('should be named fragment', () => {
    expect(createFragmentResponseMode({ issuer: TEST_ISSUER }).name).toBe('fragment');
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §2.1 / RFC 9207 §2:
  // the parameters and iss go into the fragment of the redirect URI.
  it('should redirect to the redirect URI with the parameters and iss in its fragment', async () => {
    const mode = createFragmentResponseMode({ issuer: TEST_ISSUER });

    expect(await mode.respond(REDIRECT_URI, { id_token: 'id-token-1', state: 'state-1' })).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback#id_token=id-token-1&state=state-1&iss=https%3A%2F%2Fop.example.com',
    });
  });

  // OIDC Core 1.0 §3.2.2.6: the error members go back the same way.
  it('should leave out a parameter that has no value', async () => {
    const mode = createFragmentResponseMode({ issuer: TEST_ISSUER });

    const response = await mode.respond(REDIRECT_URI, {
      error: 'access_denied',
      error_description: undefined,
      state: undefined,
    });

    expect(response).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback#error=access_denied&iss=https%3A%2F%2Fop.example.com',
    });
  });

  // RFC 6749 §3.1.2: the query of the redirection URI is retained.
  it('should keep the query the registered redirect URI has', async () => {
    const mode = createFragmentResponseMode({ issuer: TEST_ISSUER });

    expect(await mode.respond(`${REDIRECT_URI}?tenant=a`, { code: 'code-1' })).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback?tenant=a#code=code-1&iss=https%3A%2F%2Fop.example.com',
    });
  });
});

describe('implicitResponseModeOf', () => {
  it('should keep the response mode the request asked for', () => {
    const { responseMode } = recordingResponseMode('form_post');

    expect(implicitResponseModeOf(responseMode, TEST_ISSUER)).toBe(responseMode);
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §3 / §5: never the query.
  it('should answer in the fragment when no response mode was set', () => {
    expect(implicitResponseModeOf(undefined, TEST_ISSUER).name).toBe('fragment');
  });
});

describe('fragmentResponseModeHandler', () => {
  it('should restore the response mode named fragment', () => {
    expect(fragmentResponseModeHandler.names).toEqual(['fragment']);
  });

  it('should restore a mode that adds the iss of the stored issuer', async () => {
    const mode = fragmentResponseModeHandler.restore(contextOf(), {
      name: 'fragment',
      clientId: 'stored-client',
      issuer: 'https://issuer.example.com',
    });

    expect(mode.name).toBe('fragment');
    expect(await mode.respond(REDIRECT_URI, { id_token: 'id-token-1' })).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback#id_token=id-token-1&iss=https%3A%2F%2Fissuer.example.com',
    });
  });
});
