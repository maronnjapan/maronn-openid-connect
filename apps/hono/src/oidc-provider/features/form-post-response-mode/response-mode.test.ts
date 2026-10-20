import { describe, expect, it } from 'vitest';
import { TEST_ISSUER, contextOf } from '../../../test-support/context.js';
import { createFormPostResponseMode, formPostResponseModeHandler } from './response-mode.js';

const REDIRECT_URI = 'https://rp.example.com/callback';

describe('createFormPostResponseMode', () => {
  it('should be named form_post', () => {
    expect(createFormPostResponseMode({ issuer: TEST_ISSUER }).name).toBe('form_post');
  });

  // Form Post Response Mode §2 / RFC 9207 §2: the parameters and iss are the
  // fields of a form whose action is the redirect URI.
  it('should post code, state and iss to the redirect URI', async () => {
    const mode = createFormPostResponseMode({ issuer: TEST_ISSUER });

    expect(await mode.respond(REDIRECT_URI, { code: 'code-1', state: 'state-1' })).toEqual({
      method: 'form_post',
      action: REDIRECT_URI,
      fields: { code: 'code-1', state: 'state-1', iss: TEST_ISSUER },
    });
  });

  // RFC 6749 §4.1.2.1: the error members go back the same way.
  it('should post the error members and leave out a parameter that has no value', async () => {
    const mode = createFormPostResponseMode({ issuer: TEST_ISSUER });

    const response = await mode.respond(REDIRECT_URI, {
      error: 'access_denied',
      error_description: undefined,
      state: undefined,
    });

    expect(response).toEqual({
      method: 'form_post',
      action: REDIRECT_URI,
      fields: { error: 'access_denied', iss: TEST_ISSUER },
    });
  });

  // Form Post Response Mode §2: the action MUST be the Client's Redirection URI, as registered.
  it('should keep the query the registered redirect URI has in the action', async () => {
    const mode = createFormPostResponseMode({ issuer: TEST_ISSUER });

    const response = await mode.respond(`${REDIRECT_URI}?tenant=a`, { code: 'code-1' });

    expect(response).toEqual({
      method: 'form_post',
      action: 'https://rp.example.com/callback?tenant=a',
      fields: { code: 'code-1', iss: TEST_ISSUER },
    });
  });
});

describe('formPostResponseModeHandler', () => {
  it('should restore the response mode named form_post', () => {
    expect(formPostResponseModeHandler.names).toEqual(['form_post']);
  });

  it('should restore a mode that posts the iss of the stored issuer', async () => {
    const mode = formPostResponseModeHandler.restore(contextOf(), {
      name: 'form_post',
      clientId: 'stored-client',
      issuer: 'https://issuer.example.com',
    });

    expect(mode.name).toBe('form_post');
    expect(await mode.respond(REDIRECT_URI, { code: 'code-1' })).toEqual({
      method: 'form_post',
      action: REDIRECT_URI,
      fields: { code: 'code-1', iss: 'https://issuer.example.com' },
    });
  });
});
