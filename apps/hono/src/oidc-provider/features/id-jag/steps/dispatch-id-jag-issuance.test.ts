import { generateIdToken, type SigningKey, type TokenClientInfo } from '@maronn-openid-connect/core';
import {
  ID_JAG_TOKEN_TYPE,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ID_TOKEN,
  TOKEN_TYPE_REFRESH_TOKEN,
} from '@maronn-openid-connect/experimental/id-jag';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from '../../../../test-support/extensions.js';
import { providerContext, TEST_ISSUER } from '../../../../test-support/context.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { TokenEndpointError, type TokenRequestBody } from '../../../endpoints/token/response.js';
import { idJagConfig } from '../config.js';
import { issueIdJag } from './dispatch-id-jag-issuance.js';

/** 2026-01-01T00:00:00Z: every test runs on this clock. */
const NOW = Date.UTC(2026, 0, 1) / 1000;
const PEER_AS = 'https://as.partner.example';
const defaults = { ...idJagConfig };

const client: TokenClientInfo = {
  clientId: 'rp-1',
  grantTypes: ['authorization_code', TOKEN_EXCHANGE_GRANT_TYPE],
  tokenEndpointAuthMethods: ['client_secret_basic'],
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  Object.assign(idJagConfig, defaults);
  vi.useRealTimers();
});

/** An ID Token this OP issued (signed with the provider's key unless another is given). */
async function idToken(claims: Record<string, unknown> = {}, key?: SigningKey): Promise<string> {
  const signingKey = key ?? (await rs256Key());
  return generateIdToken({
    payload: { iss: TEST_ISSUER, sub: 'alice', aud: 'rp-1', iat: NOW, exp: NOW + 600, ...claims },
    privateKey: signingKey.privateKey,
    keyId: signingKey.keyId,
  });
}

function issuanceRequest(fields: Record<string, string>): TokenRequestBody {
  return {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    subject_token_type: TOKEN_TYPE_ID_TOKEN,
    audience: PEER_AS,
    ...fields,
  } as TokenRequestBody;
}

/** The TokenEndpointError the step fails with. */
async function failureOf(promise: Promise<unknown>): Promise<TokenEndpointError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TokenEndpointError);
  return error as TokenEndpointError;
}

describe('issueIdJag', () => {
  it('should leave a request that does not ask for an ID-JAG to the next step', async () => {
    const { c } = await providerContext();

    const plainExchange = await issueIdJag(
      c,
      issuanceRequest({ requested_token_type: 'urn:ietf:params:oauth:token-type:access_token' }),
      client,
    );
    const authorizationCode = await issueIdJag(c, { grant_type: 'authorization_code' } as TokenRequestBody, client);

    expect([plainExchange, authorizationCode]).toEqual([undefined, undefined]);
  });

  // ID-JAG draft §4.3.4 / RFC 8693 §2.2.1: token_type N_A, never cached (RFC 6749 §5.1).
  it('should answer a signed ID-JAG for the audience in a no-store token response', async () => {
    idJagConfig.allowedAudiences = [PEER_AS];
    const { c } = await providerContext();
    const subjectToken = await idToken({ auth_time: NOW - 60, acr: 'urn:acr:pwd', amr: ['pwd'] });

    const response = await issueIdJag(c, issuanceRequest({ subject_token: subjectToken, scope: 'calendar.read' }), client);

    const { access_token: idJag, ...body } = (await response!.json()) as Record<string, unknown>;
    expect(response!.status).toBe(200);
    expect([response!.headers.get('Cache-Control'), response!.headers.get('Pragma')]).toEqual(['no-store', 'no-cache']);
    expect(body).toEqual({ issued_token_type: ID_JAG_TOKEN_TYPE, token_type: 'N_A', expires_in: 300, scope: 'calendar.read' });
    // ID-JAG draft §3.1: the claims of the grant, signed with this OP's RS256 key.
    expect(decodeJwt(idJag as string)).toEqual({
      header: { alg: 'RS256', typ: 'oauth-id-jag+jwt', kid: 'test-rs256-key' },
      payload: {
        iss: TEST_ISSUER,
        sub: 'alice',
        aud: PEER_AS,
        client_id: 'rp-1',
        jti: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        exp: NOW + 300,
        iat: NOW,
        scope: 'calendar.read',
        auth_time: NOW - 60,
        acr: 'urn:acr:pwd',
        amr: ['pwd'],
      },
    });
  });

  // ID-JAG draft §4.3.3: the subject_token must be an ID Token this OP issued to the authenticated client.
  it('should reject an ID Token issued to another client or signed by another key with invalid_request', async () => {
    idJagConfig.allowedAudiences = [PEER_AS];
    const { c } = await providerContext();
    const otherKey = await rs256Key('not-the-provider-key');

    const otherClient = await failureOf(issueIdJag(c, issuanceRequest({ subject_token: await idToken({ aud: 'rp-2' }) }), client));
    const otherSigner = await failureOf(issueIdJag(c, issuanceRequest({ subject_token: await idToken({}, otherKey) }), client));

    const expected = { status: 400, body: { error: 'invalid_request', error_description: 'The provided subject_token is not valid' } };
    expect([otherClient.response, otherSigner.response]).toEqual([expected, expected]);
  });

  it('should reject an audience that is not in allowedAudiences with invalid_target', async () => {
    const { c } = await providerContext();

    const error = await failureOf(issueIdJag(c, issuanceRequest({ subject_token: await idToken() }), client));

    expect(error.response).toEqual({
      status: 400,
      body: { error: 'invalid_target', error_description: 'The requested audience is not allowed for ID-JAG issuance' },
    });
  });

  it('should reject a client that is not registered for the token-exchange grant with unauthorized_client', async () => {
    idJagConfig.allowedAudiences = [PEER_AS];
    const { c } = await providerContext();
    const codeOnlyClient: TokenClientInfo = { ...client, grantTypes: ['authorization_code'] };

    const error = await failureOf(issueIdJag(c, issuanceRequest({ subject_token: await idToken() }), codeOnlyClient));

    expect(error.response).toEqual({
      status: 400,
      body: {
        error: 'unauthorized_client',
        error_description: 'The client is not authorized to use the token-exchange grant type',
      },
    });
  });

  it('should answer server_error when no RS256 signing key is registered', async () => {
    idJagConfig.allowedAudiences = [PEER_AS];
    const { c } = await providerContext();
    c.set('signingKeys', []);

    const error = await failureOf(issueIdJag(c, issuanceRequest({ subject_token: await idToken() }), client));

    expect(error.response).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'No RS256 signing key registered for ID-JAG issuance' },
    });
  });

  // ID-JAG draft §4.3 (MAY): a refresh token of this OP stands in for the ID Token while its login session lives.
  it('should accept a refresh token as the subject while its login session lives, and refuse it after logout', async () => {
    idJagConfig.allowedAudiences = [PEER_AS];
    const { c, stores } = await providerContext();
    await stores.browserSessionStore.set('session-1', { subject: 'alice', authTime: NOW - 60 });
    await stores.refreshTokenStore.set('rt-1', {
      subject: 'alice',
      clientId: 'rp-1',
      scope: ['openid'],
      expiresAt: NOW + 3600,
      used: false,
      grantId: 'grant-1',
      originalIssuedAt: NOW,
      authTime: NOW - 60,
      sessionId: 'session-1',
    });
    const request = issuanceRequest({ subject_token: 'rt-1', subject_token_type: TOKEN_TYPE_REFRESH_TOKEN });

    const response = await issueIdJag(c, request, client);
    const { access_token: idJag } = (await response!.json()) as { access_token: string };
    await stores.browserSessionStore.delete('session-1');
    const afterLogout = await failureOf(issueIdJag(c, request, client));

    expect(decodeJwt(idJag).payload).toMatchObject({ sub: 'alice', auth_time: NOW - 60 });
    expect(afterLogout.response.body).toEqual({
      error: 'invalid_request',
      error_description: 'The provided subject_token is not valid',
    });
  });

  it('should reject a refresh token subject with invalid_request when allowRefreshTokenSubjects is off', async () => {
    idJagConfig.allowedAudiences = [PEER_AS];
    idJagConfig.allowRefreshTokenSubjects = false;
    const { c } = await providerContext();

    const error = await failureOf(
      issueIdJag(c, issuanceRequest({ subject_token: 'rt-1', subject_token_type: TOKEN_TYPE_REFRESH_TOKEN }), client),
    );

    expect(error.response.body).toEqual({
      error: 'invalid_request',
      error_description: `Unsupported subject_token_type for ID-JAG issuance. Only ${TOKEN_TYPE_ID_TOKEN} is supported.`,
    });
  });

  it('should reject an actor_token with invalid_request while allowActorTokens is off', async () => {
    idJagConfig.allowedAudiences = [PEER_AS];
    const { c } = await providerContext();
    const subjectToken = await idToken();

    const error = await failureOf(
      issueIdJag(
        c,
        issuanceRequest({ subject_token: subjectToken, actor_token: subjectToken, actor_token_type: TOKEN_TYPE_ID_TOKEN }),
        client,
      ),
    );

    expect(error.response.body).toEqual({
      error: 'invalid_request',
      error_description: 'actor_token is not supported for ID-JAG issuance',
    });
  });

  // RFC 8693 §4.1: with actor tokens on, the default resolver records an ID Token's sub as act.
  it('should record the actor of an ID Token actor_token as the act claim when allowActorTokens is on', async () => {
    idJagConfig.allowedAudiences = [PEER_AS];
    idJagConfig.allowActorTokens = true;
    const { c } = await providerContext();

    const response = await issueIdJag(
      c,
      issuanceRequest({
        subject_token: await idToken(),
        actor_token: await idToken({ sub: 'agent-1' }),
        actor_token_type: TOKEN_TYPE_ID_TOKEN,
      }),
      client,
    );

    const { access_token: idJag } = (await response!.json()) as { access_token: string };
    expect(decodeJwt(idJag).payload).toMatchObject({ sub: 'alice', act: { sub: 'agent-1' } });
  });
});
