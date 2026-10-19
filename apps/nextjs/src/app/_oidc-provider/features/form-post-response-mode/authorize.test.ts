import type { AuthorizationRequestParams } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { resolveFormPostResponseContext } from './authorize';

const ISSUER = 'https://op.example.com';

function paramsWith(responseMode?: string): AuthorizationRequestParams {
  return {
    client_id: 'client-1',
    response_type: 'code',
    scope: 'openid',
    ...(responseMode === undefined ? {} : { response_mode: responseMode }),
  } as AuthorizationRequestParams;
}

describe('resolveFormPostResponseContext', () => {
  // Form Post Response Mode §2.
  it('should answer response_mode=form_post in the form_post mode of the issuer', async () => {
    const mode = resolveFormPostResponseContext(paramsWith('form_post'), ISSUER);

    expect(mode?.name).toBe('form_post');
    expect(await mode?.respond('https://rp.example.com/callback', { code: 'code-1' })).toEqual({
      method: 'form_post',
      action: 'https://rp.example.com/callback',
      fields: { code: 'code-1', iss: ISSUER },
    });
  });

  it('should return undefined when the request names no response_mode', () => {
    expect(resolveFormPostResponseContext(paramsWith(), ISSUER)).toBeUndefined();
  });

  // OAuth 2.0 Multiple Response Type Encoding Practices §2.1: response_mode
  // values are case-sensitive, and form_post.jwt belongs to JARM (§2.3.3).
  it('should return undefined for every other response_mode value', () => {
    const modes = ['query', 'fragment', 'query.jwt', 'form_post.jwt', 'FORM_POST'].map((responseMode) =>
      resolveFormPostResponseContext(paramsWith(responseMode), ISSUER),
    );

    expect(modes).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
