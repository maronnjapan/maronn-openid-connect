import { describe, expect, it } from 'vitest';
import { CLIENT_ID, jwtClaimsOf, locationOf, redirectOf, REDIRECT_URI, transactionOf } from '../../../test-support/authorize.js';
import { providerContext, TEST_ISSUER } from '../../../test-support/context.js';
import { plainQueryResponse, restoreResponseMode } from './response-mode.js';

describe('restoreResponseMode', () => {
  it('should return undefined for a transaction stored without a response mode', async () => {
    const { c } = await providerContext();

    expect(restoreResponseMode(c, transactionOf())).toBeUndefined();
  });

  // JARM §2.3.1: the restored mode carries the parameters in one signed `response` JWT.
  it('should restore the JARM response mode of a transaction stored with query.jwt', async () => {
    const { c } = await providerContext();

    const responseMode = restoreResponseMode(c, { ...transactionOf(), responseMode: 'query.jwt' });
    const location = locationOf(await responseMode!.respond(REDIRECT_URI, { code: 'code-1', state: 'state-1' }));
    const { target, params } = redirectOf(location);

    expect(responseMode!.name).toBe('query.jwt');
    expect(target).toBe(REDIRECT_URI);
    expect(Object.keys(params)).toEqual(['response']);
    expect(jwtClaimsOf(params['response']!)).toMatchObject({
      code: 'code-1',
      state: 'state-1',
      iss: TEST_ISSUER,
      aud: CLIENT_ID,
    });
  });

  // Form Post Response Mode §2: the restored mode posts the parameters and iss.
  it('should restore the Form Post Response Mode of a transaction stored with form_post', async () => {
    const { c } = await providerContext();

    const responseMode = restoreResponseMode(c, { ...transactionOf(), responseMode: 'form_post' });

    expect(responseMode!.name).toBe('form_post');
    expect(await responseMode!.respond(REDIRECT_URI, { code: 'code-1', state: 'state-1' })).toEqual({
      method: 'form_post',
      action: REDIRECT_URI,
      fields: { code: 'code-1', state: 'state-1', iss: TEST_ISSUER },
    });
  });

  it('should throw for a response mode no enabled feature answers in', async () => {
    const { c } = await providerContext();

    expect(() => restoreResponseMode(c, { ...transactionOf(), responseMode: 'form_post.jwt' })).toThrow(
      'No enabled feature answers in the response mode "form_post.jwt"',
    );
  });
});

describe('plainQueryResponse', () => {
  // RFC 6749 §4.1.2 / RFC 9207 §2
  it('should redirect with the parameters that have a value and iss in the query of the redirect URI', () => {
    expect(plainQueryResponse(`${REDIRECT_URI}?tenant=a`, { code: 'code-1', state: undefined }, TEST_ISSUER)).toEqual({
      method: 'redirect',
      location: 'https://rp.example.com/callback?tenant=a&code=code-1&iss=https%3A%2F%2Fop.example.com',
    });
  });
});
