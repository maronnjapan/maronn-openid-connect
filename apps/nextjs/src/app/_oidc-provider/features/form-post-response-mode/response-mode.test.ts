import { describe, expect, it, vi } from 'vitest';
import { providerSigningKeys, rs256Key } from '../../../../test-support/keys';
import { createFormPostResponseMode, formPostResponseModeHandler } from './response-mode';

const ISSUER = 'https://op.example.com';
const REDIRECT_URI = 'https://rp.example.com/callback';

describe('createFormPostResponseMode', () => {
  it('should be named form_post', () => {
    expect(createFormPostResponseMode({ issuer: ISSUER }).name).toBe('form_post');
  });

  // Form Post Response Mode §2 / RFC 9207 §2: the parameters and iss are the
  // fields of a form whose action is the redirect URI, query included.
  it('should post code, state and iss to the redirect URI', async () => {
    const mode = createFormPostResponseMode({ issuer: ISSUER });

    expect(await mode.respond(`${REDIRECT_URI}?tenant=a`, { code: 'code-1', state: 'state-1' })).toEqual({
      method: 'form_post',
      action: 'https://rp.example.com/callback?tenant=a',
      fields: { code: 'code-1', state: 'state-1', iss: ISSUER },
    });
  });

  // RFC 6749 §4.1.2.1: the error members go back the same way.
  it('should post the error members and leave out a parameter whose value is undefined', async () => {
    const mode = createFormPostResponseMode({ issuer: ISSUER });

    expect(await mode.respond(REDIRECT_URI, { error: 'access_denied', state: undefined })).toEqual({
      method: 'form_post',
      action: REDIRECT_URI,
      fields: { error: 'access_denied', iss: ISSUER },
    });
  });

  // RFC 9207 §2: iss is the issuer of this OP, never a value handed in with the parameters.
  it('should set iss to the issuer even when the parameters carry another one', async () => {
    const mode = createFormPostResponseMode({ issuer: ISSUER });

    const response = await mode.respond(REDIRECT_URI, { code: 'code-1', iss: 'https://evil.example.com' });

    expect(response).toEqual({ method: 'form_post', action: REDIRECT_URI, fields: { code: 'code-1', iss: ISSUER } });
  });
});

describe('formPostResponseModeHandler', () => {
  it('should restore the response mode named form_post', () => {
    expect(formPostResponseModeHandler.names).toEqual(['form_post']);
  });

  // The form carries no signature, so no key is loaded for it.
  it('should restore a mode that posts the iss of the stored issuer without loading the keys', async () => {
    const loadSigningKeys = vi.fn(async () => providerSigningKeys(await rs256Key()));

    const mode = await formPostResponseModeHandler.restore({
      name: 'form_post',
      clientId: 'client-1',
      issuer: 'https://issuer.example.com',
      loadSigningKeys,
    });

    expect(await mode.respond(REDIRECT_URI, { code: 'code-1' })).toEqual({
      method: 'form_post',
      action: REDIRECT_URI,
      fields: { code: 'code-1', iss: 'https://issuer.example.com' },
    });
    expect(loadSigningKeys).not.toHaveBeenCalled();
  });
});
