import { expect, test, type APIRequestContext } from '@playwright/test';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const xaaOpPort = Number(process.env.E2E_XAA_OP_PORT ?? '3040');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const xaaIssuer = process.env.E2E_XAA_ISSUER ?? `http://${host}:${xaaOpPort}`;
const clientId = 'e2e-client';
const clientSecret = 'e2e-client-secret';

const EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
const REFRESH_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:refresh_token';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const ID_JAG_GRANT_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';

/**
 * EXPERIMENTAL — Cross-App Access / ID-JAG
 * (draft-ietf-oauth-identity-assertion-authz-grant-04).
 *
 * Two OP instances of the sample play the two trust domains: the first
 * (baseURL) is the IdP that issues ID-JAGs, the second (xaaIssuer) is the
 * resource authorization server that redeems them. The second instance only
 * starts for the hono sample, and only an OP generated with --enable id-jag
 * advertises the profile — every test here skips itself otherwise, so the
 * shared spec suite stays green across all sample OPs.
 */
test.describe('Cross-App Access / ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant)', () => {
  test('should walk the full XAA chain: SSO, ID-JAG issuance, redemption, API access', async ({
    page,
    request,
    baseURL,
  }) => {
    const idpIssuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsXaa(request, idpIssuer)), XAA_SKIP_REASON);

    // (1) SSO: the ordinary Authorization Code Flow in a real browser yields
    // the Identity Assertion (ID Token) at the IdP.
    const idToken = await obtainIdToken(page);

    // (2) Token Exchange at the IdP (draft §4.3): trade the ID Token for an
    // ID-JAG addressed to the second OP's trust domain.
    const exchangeRes = await request.post(`${idpIssuer}/token`, {
      form: {
        grant_type: EXCHANGE_GRANT_TYPE,
        requested_token_type: ID_JAG_TOKEN_TYPE,
        subject_token: idToken,
        subject_token_type: ID_TOKEN_TYPE,
        audience: xaaIssuer,
        scope: 'openid profile',
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(exchangeRes.status()).toBe(200);
    const exchangeBody = (await exchangeRes.json()) as Record<string, unknown>;
    // draft §4.3.4: the ID-JAG travels in access_token for historical reasons,
    // but token_type N_A says it is NOT an access token.
    expect(exchangeBody.issued_token_type).toBe(ID_JAG_TOKEN_TYPE);
    expect(exchangeBody.token_type).toBe('N_A');
    expect(exchangeBody.expires_in).toBe(300);
    expect(exchangeBody.scope).toBe('openid profile');

    const idJag = String(exchangeBody.access_token);
    const jagHeader = decodeJwtSegment(idJag.split('.')[0] ?? '');
    const jagClaims = decodeJwtSegment(idJag.split('.')[1] ?? '');
    // draft §3.1: explicit typing plus the cross-domain addressing.
    expect(jagHeader.typ).toBe('oauth-id-jag+jwt');
    expect(jagHeader.alg).toBe('RS256');
    expect(jagHeader.kid).toBe('e2e-rs256-key');
    expect(jagClaims.iss).toBe(idpIssuer);
    expect(jagClaims.aud).toBe(xaaIssuer);
    expect(jagClaims.sub).toBe('testuser');
    expect(jagClaims.client_id).toBe(clientId);

    // (3) Redemption at the resource AS (draft §4.4): the jwt-bearer grant.
    // The second OP verifies the signature against the IdP's live JWKS.
    const redeemRes = await request.post(`${xaaIssuer}/token`, {
      form: {
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: idJag,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(redeemRes.status()).toBe(200);
    const redeemBody = (await redeemRes.json()) as Record<string, unknown>;
    // draft §4.4.2 / §4.4.3: a plain token response — no refresh_token (the
    // re-presentable ID-JAG replaces it) and no id_token.
    expect(Object.keys(redeemBody).sort()).toEqual([
      'access_token',
      'expires_in',
      'scope',
      'token_type',
    ]);
    expect(redeemBody.token_type).toBe('Bearer');
    expect(redeemBody.scope).toBe('openid profile');

    // The access token is minted by the resource AS itself, not by the IdP.
    const accessTokenClaims = decodeJwtSegment(
      String(redeemBody.access_token).split('.')[1] ?? '',
    );
    expect(accessTokenClaims.iss).toBe(xaaIssuer);
    expect(accessTokenClaims.sub).toBe('testuser');
    expect(accessTokenClaims.client_id).toBe(clientId);

    // (4) API access in the second trust domain: the resource AS resolves the
    // ID-JAG subject to its own local user of the same sub.
    const userInfoRes = await request.get(`${xaaIssuer}/userinfo`, {
      headers: { Authorization: `Bearer ${String(redeemBody.access_token)}` },
    });
    expect(userInfoRes.status()).toBe(200);
    expect(((await userInfoRes.json()) as { sub: string }).sub).toBe('testuser');
  });

  // draft §4.3.2 / §4.4.3: when the ID Token has expired, the refresh token
  // from the same SSO stands in as the subject and yields a fresh ID-JAG
  // without a new sign-on round trip.
  test('should issue and redeem an ID-JAG from a refresh token subject', async ({
    page,
    request,
    baseURL,
  }) => {
    const idpIssuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsXaa(request, idpIssuer)), XAA_SKIP_REASON);

    const { refreshToken } = await obtainTokens(page);
    expect(refreshToken).not.toBe('');

    const exchangeRes = await request.post(`${idpIssuer}/token`, {
      form: {
        grant_type: EXCHANGE_GRANT_TYPE,
        requested_token_type: ID_JAG_TOKEN_TYPE,
        subject_token: refreshToken,
        subject_token_type: REFRESH_TOKEN_TYPE,
        audience: xaaIssuer,
        scope: 'openid profile',
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(exchangeRes.status()).toBe(200);
    const exchangeBody = (await exchangeRes.json()) as Record<string, unknown>;
    expect(exchangeBody.token_type).toBe('N_A');

    const idJag = String(exchangeBody.access_token);
    const jagClaims = decodeJwtSegment(idJag.split('.')[1] ?? '');
    // The subject claims come from the refresh token's stored grant context.
    expect(jagClaims.sub).toBe('testuser');
    expect(typeof jagClaims.auth_time).toBe('number');

    const redeemRes = await request.post(`${xaaIssuer}/token`, {
      form: {
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: idJag,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(redeemRes.status()).toBe(200);
    expect(((await redeemRes.json()) as Record<string, unknown>).token_type).toBe('Bearer');
  });

  // Extension (draft §9.7): the IdP records who acts on the subject's behalf,
  // and the resource AS preserves that record on its own access token.
  test('should carry the actor through the chain as the act claim', async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    const idpIssuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsXaa(request, idpIssuer)), XAA_SKIP_REASON);

    // Subject: testuser signs in in the default context.
    const subjectIdToken = await obtainIdToken(page);
    // Actor: otheruser runs the same flow in an isolated context, so the OP's
    // browser-session cookie of the first login cannot leak into it.
    const actorContext = await browser.newContext();
    const actorIdToken = await obtainIdToken(await actorContext.newPage(), 'otheruser');
    await actorContext.close();

    const exchangeRes = await request.post(`${idpIssuer}/token`, {
      form: {
        grant_type: EXCHANGE_GRANT_TYPE,
        requested_token_type: ID_JAG_TOKEN_TYPE,
        subject_token: subjectIdToken,
        subject_token_type: ID_TOKEN_TYPE,
        actor_token: actorIdToken,
        actor_token_type: ID_TOKEN_TYPE,
        audience: xaaIssuer,
        scope: 'openid profile',
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(exchangeRes.status()).toBe(200);
    const idJag = String(
      ((await exchangeRes.json()) as Record<string, unknown>).access_token,
    );
    const jagClaims = decodeJwtSegment(idJag.split('.')[1] ?? '');
    // RFC 8693 §4.1: sub stays the resource owner; the actor appears only in act.
    expect(jagClaims.sub).toBe('testuser');
    expect(jagClaims.act).toEqual({ sub: 'otheruser' });

    const redeemRes = await request.post(`${xaaIssuer}/token`, {
      form: {
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: idJag,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(redeemRes.status()).toBe(200);
    const redeemBody = (await redeemRes.json()) as Record<string, unknown>;

    const accessTokenClaims = decodeJwtSegment(
      String(redeemBody.access_token).split('.')[1] ?? '',
    );
    expect(accessTokenClaims.sub).toBe('testuser');
    expect(accessTokenClaims.act).toEqual({ sub: 'otheruser' });
  });

  // Extension point: actor_token types beyond id_token are accepted only
  // through a deployment-provided resolver that owns the content validation.
  // The sample OP wires a demo resolver (XAA_ACTOR_TOKEN_RESOLVER=access-token)
  // that resolves an access token this IdP itself issued via its own store.
  test('should resolve a custom actor_token type through the deployment resolver', async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    const idpIssuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsXaa(request, idpIssuer)), XAA_SKIP_REASON);

    const subjectIdToken = await obtainIdToken(page);
    // The actor's credential here is otheruser's ACCESS token (not an ID
    // Token), obtained in an isolated browser context.
    const actorContext = await browser.newContext();
    const { accessToken: actorAccessToken } = await obtainTokens(
      await actorContext.newPage(),
      'otheruser',
    );
    await actorContext.close();
    expect(actorAccessToken).not.toBe('');

    const exchangeRes = await request.post(`${idpIssuer}/token`, {
      form: {
        grant_type: EXCHANGE_GRANT_TYPE,
        requested_token_type: ID_JAG_TOKEN_TYPE,
        subject_token: subjectIdToken,
        subject_token_type: ID_TOKEN_TYPE,
        actor_token: actorAccessToken,
        actor_token_type: ACCESS_TOKEN_TYPE,
        audience: xaaIssuer,
        scope: 'openid profile',
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(exchangeRes.status()).toBe(200);
    const idJag = String(
      ((await exchangeRes.json()) as Record<string, unknown>).access_token,
    );
    const jagClaims = decodeJwtSegment(idJag.split('.')[1] ?? '');
    expect(jagClaims.sub).toBe('testuser');
    expect(jagClaims.act).toEqual({ sub: 'otheruser' });

    const redeemRes = await request.post(`${xaaIssuer}/token`, {
      form: {
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: idJag,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });
    expect(redeemRes.status()).toBe(200);
    const redeemBody = (await redeemRes.json()) as Record<string, unknown>;
    const accessTokenClaims = decodeJwtSegment(
      String(redeemBody.access_token).split('.')[1] ?? '',
    );
    expect(accessTokenClaims.act).toEqual({ sub: 'otheruser' });
  });

  test('should advertise the XAA metadata on both trust domains', async ({
    request,
    baseURL,
  }) => {
    const idpIssuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsXaa(request, idpIssuer)), XAA_SKIP_REASON);

    const idpMetadata = await discovery(request, idpIssuer);
    const asMetadata = await discovery(request, xaaIssuer);

    // draft §7.1: the IdP side announces the identity-chaining token type.
    expect(idpMetadata.identity_chaining_requested_token_types_supported).toEqual([
      ID_JAG_TOKEN_TYPE,
    ]);
    // draft §7.2: the resource AS side announces the grant profile and, with
    // it, MUST announce the jwt-bearer grant.
    expect(asMetadata.authorization_grant_profiles_supported).toEqual([ID_JAG_GRANT_PROFILE]);
    expect((asMetadata.grant_types_supported as string[]).includes(JWT_BEARER_GRANT_TYPE)).toBe(
      true,
    );
  });

  test('should refuse to redeem the ID-JAG at the IdP that issued it', async ({
    page,
    request,
    baseURL,
  }) => {
    const idpIssuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsXaa(request, idpIssuer)), XAA_SKIP_REASON);

    const idJag = await obtainIdJag(page, request, idpIssuer);

    // draft §9.3: same trust domain — the issuing OP must never turn its own
    // ID-JAG into its own access token, whatever grants the client holds.
    const res = await request.post(`${idpIssuer}/token`, {
      form: {
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: idJag,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });

    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'An assertion issued by this authorization server cannot be redeemed here',
    });
  });

  test('should refuse an ID-JAG presented by a client it does not name', async ({
    page,
    request,
    baseURL,
  }) => {
    const idpIssuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsXaa(request, idpIssuer)), XAA_SKIP_REASON);

    const idJag = await obtainIdJag(page, request, idpIssuer);

    // draft §4.4.1 client continuity: e2e-xaa-other authenticates correctly at
    // the resource AS but presents a grant that names e2e-client.
    const res = await request.post(`${xaaIssuer}/token`, {
      form: {
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: idJag,
        client_id: 'e2e-xaa-other',
        client_secret: 'e2e-xaa-other-secret',
      },
    });

    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'The assertion client_id does not match the authenticated client',
    });
  });

  test('should refuse a tampered ID-JAG with the fixed untrusted description', async ({
    page,
    request,
    baseURL,
  }) => {
    const idpIssuer = requireBaseUrl(baseURL);
    test.skip(!(await supportsXaa(request, idpIssuer)), XAA_SKIP_REASON);

    const idJag = await obtainIdJag(page, request, idpIssuer);
    const [header = '', payload = ''] = idJag.split('.');

    const res = await request.post(`${xaaIssuer}/token`, {
      form: {
        grant_type: JWT_BEARER_GRANT_TYPE,
        assertion: `${header}.${payload}.AAAA`,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });

    expect(res.status()).toBe(400);
    // The same description covers "issuer unknown" — the response never says
    // which trust check failed, so it cannot enumerate the trusted-IdP list.
    expect(await res.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'The assertion issuer is not trusted or the assertion signature is invalid',
    });
  });
});

const XAA_SKIP_REASON =
  'This sample OP was generated without --enable id-jag, or the second (resource AS) OP instance is not running';

/**
 * Complete the ordinary Authorization Code Flow at the E2E client app as the
 * given user and read the raw tokens off the client's result page.
 */
async function obtainTokens(
  page: import('@playwright/test').Page,
  username = 'testuser',
): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
  await page.goto(`${clientBaseURL}/start`);
  await page.getByLabel('Username:').fill(username);
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  return {
    idToken: (await page.getByTestId('token-id-token').textContent()) ?? '',
    accessToken: (await page.getByTestId('token-access-token').textContent()) ?? '',
    refreshToken: (await page.getByTestId('token-refresh-token').textContent()) ?? '',
  };
}

async function obtainIdToken(
  page: import('@playwright/test').Page,
  username = 'testuser',
): Promise<string> {
  return (await obtainTokens(page, username)).idToken;
}

/** SSO plus the token exchange: hand back a freshly issued ID-JAG. */
async function obtainIdJag(
  page: import('@playwright/test').Page,
  request: APIRequestContext,
  idpIssuer: string,
): Promise<string> {
  const idToken = await obtainIdToken(page);
  const res = await request.post(`${idpIssuer}/token`, {
    form: {
      grant_type: EXCHANGE_GRANT_TYPE,
      requested_token_type: ID_JAG_TOKEN_TYPE,
      subject_token: idToken,
      subject_token_type: ID_TOKEN_TYPE,
      audience: xaaIssuer,
      scope: 'openid profile',
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  return ((await res.json()) as Record<string, string>).access_token ?? '';
}

/** Decode a JWT segment (base64url, RFC 7515 §2). */
function decodeJwtSegment(segment: string): Record<string, unknown> {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function discovery(
  request: APIRequestContext,
  issuer: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  return (await response.json()) as Record<string, unknown>;
}

/**
 * True only when the IdP OP advertises ID-JAG issuance AND the second OP is up
 * and advertises the grant profile. The second instance only starts for the
 * hono sample, so the reachability probe doubles as the skip condition for
 * every other sample OP.
 */
async function supportsXaa(request: APIRequestContext, idpIssuer: string): Promise<boolean> {
  try {
    const idpMetadata = await discovery(request, idpIssuer);
    const chaining = idpMetadata.identity_chaining_requested_token_types_supported;
    if (!Array.isArray(chaining) || !chaining.includes(ID_JAG_TOKEN_TYPE)) {
      return false;
    }
    const asMetadata = await discovery(request, xaaIssuer);
    const profiles = asMetadata.authorization_grant_profiles_supported;
    return Array.isArray(profiles) && profiles.includes(ID_JAG_GRANT_PROFILE);
  } catch {
    return false;
  }
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (baseURL === undefined) {
    throw new Error('baseURL is not configured');
  }
  return baseURL;
}
