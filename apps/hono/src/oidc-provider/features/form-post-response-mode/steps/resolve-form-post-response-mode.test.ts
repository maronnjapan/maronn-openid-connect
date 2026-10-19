import type { AuthorizationRequestParams } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context.js';
import { resolveFormPostResponseContext } from './resolve-form-post-response-mode.js';

function paramsWith(responseMode?: string): AuthorizationRequestParams {
  return {
    client_id: 'client-1',
    response_type: 'code',
    ...(responseMode === undefined ? {} : { response_mode: responseMode }),
  } as AuthorizationRequestParams;
}

describe('resolveFormPostResponseContext', () => {
  describe('Form Post Response Mode', () => {
    // Form Post Response Mode §2.
    it('should answer in form_post for response_mode=form_post, posting the iss of the issuer', async () => {
      const mode = resolveFormPostResponseContext(paramsWith('form_post'), TEST_ISSUER);

      expect(mode?.name).toBe('form_post');
      expect(await mode?.respond('https://rp.example.com/callback', { code: 'code-1' })).toEqual({
        method: 'form_post',
        action: 'https://rp.example.com/callback',
        fields: { code: 'code-1', iss: TEST_ISSUER },
      });
    });
  });

  describe('Other Response Modes', () => {
    it('should return undefined when the request names no response_mode', () => {
      expect(resolveFormPostResponseContext(paramsWith(), TEST_ISSUER)).toBeUndefined();
    });

    // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: response_mode
    // values are case-sensitive, and form_post.jwt belongs to JARM (§2.3.3).
    it('should return undefined for every other response_mode value', () => {
      const modes = ['query', 'fragment', 'query.jwt', 'form_post.jwt', 'FORM_POST', 'form_post '].map((responseMode) =>
        resolveFormPostResponseContext(paramsWith(responseMode), TEST_ISSUER),
      );

      expect(modes).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    });
  });
});
