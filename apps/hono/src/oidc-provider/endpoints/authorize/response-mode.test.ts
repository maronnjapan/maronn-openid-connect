import { describe, expect, it } from 'vitest';
import { CLIENT_ID, jwtClaimsOf, redirectOf, REDIRECT_URI, transactionOf } from '../../../test-support/authorize.js';
import { providerContext, TEST_ISSUER } from '../../../test-support/context.js';
import { restoreResponseMode } from './response-mode.js';

describe('restoreResponseMode', () => {
  it('should return undefined for a transaction stored without a response mode', async () => {
    const { c } = await providerContext();

    expect(restoreResponseMode(c, transactionOf())).toBeUndefined();
  });

  // JARM §2.3.1: the restored mode carries the parameters in one signed `response` JWT.
  it('should restore the JARM response mode of a transaction stored with query.jwt', async () => {
    const { c } = await providerContext();

    const responseMode = restoreResponseMode(c, { ...transactionOf(), responseMode: 'query.jwt' });
    const location = await responseMode!.redirect(REDIRECT_URI, { code: 'code-1', state: 'state-1' });
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

  it('should throw for a response mode no enabled feature answers in', async () => {
    const { c } = await providerContext();

    expect(() => restoreResponseMode(c, { ...transactionOf(), responseMode: 'form_post.jwt' })).toThrow(
      'No enabled feature answers in the response mode "form_post.jwt"',
    );
  });
});
