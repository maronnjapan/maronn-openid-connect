import type { AuthorizationRequestParams } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import {
  authorizationParams,
  authorizePath,
  CLIENT_ID,
  REDIRECT_URI,
  registerTestClient,
  signIn,
  STATE,
  storeTransaction,
  SUBJECT,
  transactionOf,
  validatedRequestOf,
} from '../../../../test-support/authorize.js';
import { providerContext, requestTo, TEST_ISSUER } from '../../../../test-support/context.js';
import { unsignedJwt } from '../../../../test-support/feature-endpoints.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';
import { processAuthorizationRequest } from '../../../endpoints/authorize/pipeline.js';
import { issueConsentedAuthorizationCode } from '../../../endpoints/consent/steps/issue-authorization-code.js';
import { validateDpopJktParameter } from './validate-dpop-jkt.js';

// RFC 7638 §3.1: the thumbprint of its example key.
const JKT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

/** The parameters of a valid authorization request, as /authorize parses them. */
function paramsOf(overrides: Record<string, string> = {}): AuthorizationRequestParams {
  return { client_id: CLIENT_ID, ...authorizationParams(overrides) };
}

async function providerWithClient() {
  const db = createEmptyDatabase();
  await registerTestClient(db);
  return { db, stores: createProviderStores(db) };
}

async function authorize(db: MemoryDatabase, params: Record<string, string>, cookie?: string) {
  const headers: Record<string, string> = cookie === undefined ? {} : { Cookie: cookie };
  const { c } = await providerContext({ db, request: requestTo(authorizePath(params), { headers }) });
  return processAuthorizationRequest(c);
}

describe('validateDpopJktParameter', () => {
  it('should return the confirmation of dpop_jkt, or nothing without it', () => {
    expect([
      validateDpopJktParameter(validatedRequestOf(), paramsOf({ dpop_jkt: JKT }), undefined),
      validateDpopJktParameter(validatedRequestOf(), paramsOf(), undefined),
    ]).toEqual([{ jkt: JKT }, undefined]);
  });

  // OIDC Core 1.0 §6.1 / RFC 9101 §6.3: core does not copy dpop_jkt from the Request Object into effectiveParams.
  it('should take dpop_jkt from the Request Object over the query, and from the query when the Request Object has none', () => {
    const query = paramsOf({ dpop_jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I' });

    expect([
      validateDpopJktParameter(validatedRequestOf(), query, { dpop_jkt: JKT }),
      validateDpopJktParameter(validatedRequestOf(), paramsOf(), { dpop_jkt: JKT }),
      validateDpopJktParameter(validatedRequestOf(), query, { scope: 'openid' }),
    ]).toEqual([{ jkt: JKT }, { jkt: JKT }, { jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I' }]);
  });

  it('should bind the transaction to the dpop_jkt of an unsigned Request Object the OP accepts', async () => {
    const { db } = await providerWithClient();
    const requestObject = unsignedJwt({ ...authorizationParams(), client_id: CLIENT_ID, dpop_jkt: JKT });
    const { c } = await providerContext({
      db,
      request: requestTo(authorizePath({ client_id: CLIENT_ID, response_type: 'code', scope: 'openid', request: requestObject })),
      options: { config: { allowUnsignedRequestObject: true } },
    });

    await processAuthorizationRequest(c);

    expect([...db.transactions.values()].map((entry) => (entry.value as { cnf?: unknown }).cnf)).toEqual([{ jkt: JKT }]);
  });

  // RFC 9449 §10: dpop_jkt is a JWK Thumbprint; a malformed one is an invalid request.
  it('should redirect invalid_request with the state for a dpop_jkt that is not a thumbprint', async () => {
    const { db } = await providerWithClient();

    const outcome = await authorize(db, authorizationParams({ dpop_jkt: 'not-a-thumbprint' }));

    expect(outcome).toEqual({
      kind: 'authorization_response',
      response: {
        method: 'redirect',
        location:
          `${REDIRECT_URI}?error=invalid_request` +
          `&error_description=${encodeURIComponent('dpop_jkt must be a base64url SHA-256 JWK Thumbprint').replace(/%20/g, '+')}` +
          `&state=${STATE}&iss=${encodeURIComponent(TEST_ISSUER)}`,
      },
    });
  });

  it('should keep the confirmation in the transaction the login and consent screens continue', async () => {
    const { db } = await providerWithClient();

    await authorize(db, authorizationParams({ dpop_jkt: JKT }));

    expect([...db.transactions.values()].map((entry) => (entry.value as { cnf?: unknown }).cnf)).toEqual([{ jkt: JKT }]);
  });

  // RFC 9449 §10: the code issued at /authorize (SSO) carries the key to the token endpoint.
  it('should bind the code issued for SSO with prior consent to dpop_jkt', async () => {
    const { db, stores } = await providerWithClient();
    const cookie = await signIn(stores);
    await stores.consentStore.grant(SUBJECT, CLIENT_ID, ['openid']);

    await authorize(db, authorizationParams({ dpop_jkt: JKT }), cookie);

    expect([...db.codes.values()].map((code) => (code as { cnf?: unknown }).cnf)).toEqual([{ jkt: JKT }]);
  });

  it('should bind the code the consent screen issues to the confirmation of its transaction', async () => {
    const { db, stores } = await providerWithClient();
    const transaction = { ...transactionOf(), cnf: { jkt: JKT } };
    await storeTransaction(stores, transaction);
    const { c } = await providerContext({ db });

    const { authCodeData } = await issueConsentedAuthorizationCode(c, 'txn-1', transaction, { subject: SUBJECT, authTime: 0 });

    expect(await stores.authCodeStore.get(authCodeData.code)).toMatchObject({ cnf: { jkt: JKT } });
  });
});
