import type { ValidatedTokenRequest } from '@maronn-openid-connect/core';
import { createInMemoryRarDetailsStore } from '@maronn-openid-connect/experimental/rar';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import type { TokenEndpointResponse } from '../../../endpoints/token/response.js';
import { appendAuthorizationDetailsToTokenResponse } from './append-token-response-details.js';

const DETAILS = [{ type: 'payment_initiation', actions: ['initiate'] }] as const;

const TOKEN_RESPONSE: TokenEndpointResponse = {
  status: 200,
  body: {
    access_token: 'at-1',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'openid',
  },
};

function validatedRequestOf(grantId: string): ValidatedTokenRequest {
  return { grantType: 'authorization_code', grantId } as ValidatedTokenRequest;
}

describe('appendAuthorizationDetailsToTokenResponse', () => {
  it('should append the granted details to the response body', async () => {
    const rarGrantStore = createInMemoryRarDetailsStore();
    await rarGrantStore.set('grant-1', DETAILS);
    const c = contextOf(undefined, { rarGrantStore });

    const appended = await appendAuthorizationDetailsToTokenResponse(c, TOKEN_RESPONSE, validatedRequestOf('grant-1'));

    expect(appended).toEqual({
      status: 200,
      body: {
        access_token: 'at-1',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid',
        authorization_details: DETAILS,
      },
    });
  });

  it('should return the response unchanged for a grant without details', async () => {
    const c = contextOf(undefined, { rarGrantStore: createInMemoryRarDetailsStore() });

    const appended = await appendAuthorizationDetailsToTokenResponse(c, TOKEN_RESPONSE, validatedRequestOf('grant-2'));

    expect(appended).toBe(TOKEN_RESPONSE);
  });
});
