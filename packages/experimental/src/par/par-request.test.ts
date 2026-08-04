import { describe, it, expect } from 'vitest';
import type {
  ClientInfo,
  ClientResolver,
  TokenClientInfo,
  TokenClientResolver,
} from '@maronn-openid-connect/core';
import {
  ParError,
  assertParExpiresInSeconds,
  authenticateParClient,
  buildPushedAuthorizationResponse,
  createPushedAuthorizationRecord,
  handlePushedAuthorizationRequest,
  rejectForbiddenParParams,
  validatePushedAuthorizationParams,
} from './par-request.js';
import { PAR_REQUEST_URI_PREFIX } from './store.js';
import type {
  PushedAuthorizationRecord,
  PushedAuthorizationRequestStore,
} from './store.js';

type TestClient = ClientInfo & TokenClientInfo;

const BASIC_CLIENT: TestClient = {
  clientId: 'web-app',
  clientSecret: 'secret',
  redirectUris: ['https://client.example/cb'],
  clientType: 'confidential',
  tokenEndpointAuthMethod: 'client_secret_basic',
};

const POST_CLIENT: TestClient = {
  clientId: 'post-app',
  clientSecret: 'secret',
  redirectUris: ['https://client.example/cb'],
  clientType: 'confidential',
  tokenEndpointAuthMethod: 'client_secret_post',
};

const PUBLIC_CLIENT: TestClient = {
  clientId: 'spa-app',
  redirectUris: ['https://spa.example/cb'],
  clientType: 'public',
  tokenEndpointAuthMethod: 'none',
};

const TEST_CLIENTS: readonly TestClient[] = [BASIC_CLIENT, POST_CLIENT, PUBLIC_CLIENT];

function createClientResolver(): ClientResolver & TokenClientResolver {
  return {
    async findClient(clientId: string): Promise<TestClient | null> {
      return TEST_CLIENTS.find((client) => client.clientId === clientId) ?? null;
    },
  };
}

class RecordingStore implements PushedAuthorizationRequestStore {
  readonly saved: PushedAuthorizationRecord[] = [];

  async save(record: PushedAuthorizationRecord): Promise<void> {
    this.saved.push(record);
  }

  async consume(requestUri: string): Promise<PushedAuthorizationRecord | null> {
    const index = this.saved.findIndex((entry) => entry.requestUri === requestUri);
    if (index === -1) return null;
    const [record] = this.saved.splice(index, 1);
    return record ?? null;
  }
}

/** RFC 9126 §2.1 の例と同じ、認可エンドポイントへ送るのと同じパラメータ一式。 */
function validParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: 'code',
    client_id: 'web-app',
    redirect_uri: 'https://client.example/cb',
    scope: 'openid profile',
    state: 'af0ifjsldkj',
    nonce: 'n-0S6_WzA2Mj',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...overrides,
  };
}

/** `client_secret_basic` 用の Authorization ヘッダ（RFC 6749 §2.3.1）。 */
function basicHeader(clientId: string, clientSecret: string): string {
  return 'Basic ' + btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`);
}

describe('rejectForbiddenParParams', () => {
  it('should reject a request_uri parameter in the pushed request body', () => {
    // RFC 9126 §2.1: "the request_uri authorization request parameter is one exception
    // and it MUST NOT be provided."
    expect(() => rejectForbiddenParParams(validParams({ request_uri: 'urn:x' }))).toThrowError(
      new ParError('invalid_request', 'request_uri MUST NOT be included in a pushed authorization request'),
    );
  });

  it('should reject a request parameter because PAR with a Request Object is out of scope', () => {
    expect(() => rejectForbiddenParParams(validParams({ request: 'eyJhbGciOiJSUzI1NiJ9.e30.sig' }))).toThrowError(
      new ParError('invalid_request', 'The request parameter (Request Object) is not supported by this pushed authorization request endpoint'),
    );
  });

  it('should accept a body that carries neither request_uri nor request', () => {
    expect(rejectForbiddenParParams(validParams())).toBe(undefined);
  });
});

describe('assertParExpiresInSeconds', () => {
  it('should accept the lower bound of 5 seconds', () => {
    expect(assertParExpiresInSeconds(5)).toBe(undefined);
  });

  it('should accept the upper bound of 600 seconds', () => {
    expect(assertParExpiresInSeconds(600)).toBe(undefined);
  });

  it('should reject a value below the RFC 9126 recommended range', () => {
    expect(() => assertParExpiresInSeconds(4)).toThrowError(
      new RangeError('expiresInSeconds must be an integer between 5 and 600 (RFC 9126 §2.2), received 4'),
    );
  });

  it('should reject a value above the RFC 9126 recommended range', () => {
    expect(() => assertParExpiresInSeconds(601)).toThrowError(
      new RangeError('expiresInSeconds must be an integer between 5 and 600 (RFC 9126 §2.2), received 601'),
    );
  });

  it('should reject a non-integer value', () => {
    expect(() => assertParExpiresInSeconds(60.5)).toThrowError(
      new RangeError('expiresInSeconds must be an integer between 5 and 600 (RFC 9126 §2.2), received 60.5'),
    );
  });
});

describe('authenticateParClient', () => {
  it('should return the authenticated client id for client_secret_basic with client_id in the body', async () => {
    // RFC 9126 §2.1: client_id is a required authorization request parameter, so it is
    // present in the body even when the client authenticates with HTTP Basic.
    const clientId = await authenticateParClient({
      params: validParams(),
      authorizationHeader: basicHeader('web-app', 'secret'),
      clientResolver: createClientResolver(),
    });

    expect(clientId).toBe('web-app');
  });

  it('should return the authenticated client id for client_secret_post', async () => {
    const clientId = await authenticateParClient({
      params: validParams({ client_id: 'post-app', client_secret: 'secret' }),
      authorizationHeader: '',
      clientResolver: createClientResolver(),
    });

    expect(clientId).toBe('post-app');
  });

  it('should return the client id for a public client presenting only client_id', async () => {
    const clientId = await authenticateParClient({
      params: validParams({ client_id: 'spa-app', redirect_uri: 'https://spa.example/cb' }),
      authorizationHeader: '',
      clientResolver: createClientResolver(),
    });

    expect(clientId).toBe('spa-app');
  });

  it('should reject a body client_secret combined with an Authorization header', async () => {
    // OAuth 2.1 §2.3: a client MUST NOT use more than one authentication method.
    await expect(
      authenticateParClient({
        params: validParams({ client_secret: 'secret' }),
        authorizationHeader: basicHeader('web-app', 'secret'),
        clientResolver: createClientResolver(),
      }),
    ).rejects.toThrowError(
      new ParError('invalid_request', 'Multiple client authentication methods provided. Use either the Authorization header or the request body, not both.'),
    );
  });

  it('should reject a body client_id that differs from the Basic-authenticated client', async () => {
    await expect(
      authenticateParClient({
        params: validParams({ client_id: 'spa-app' }),
        authorizationHeader: basicHeader('web-app', 'secret'),
        clientResolver: createClientResolver(),
      }),
    ).rejects.toThrowError(
      new ParError('invalid_request', 'client_id does not match the authenticated client'),
    );
  });

  it('should reject a wrong client_secret with invalid_client', async () => {
    await expect(
      authenticateParClient({
        params: validParams(),
        authorizationHeader: basicHeader('web-app', 'wrong-secret'),
        clientResolver: createClientResolver(),
      }),
    ).rejects.toThrowError(new ParError('invalid_client', 'Client authentication failed'));
  });

  it('should reject an unknown client with invalid_client', async () => {
    await expect(
      authenticateParClient({
        params: validParams({ client_id: 'unknown' }),
        authorizationHeader: '',
        clientResolver: createClientResolver(),
      }),
    ).rejects.toThrowError(new ParError('invalid_client', 'Client authentication failed'));
  });
});

describe('ParError', () => {
  it('should map invalid_client to HTTP 401', () => {
    expect(new ParError('invalid_client', 'Client authentication failed').statusCode).toBe(401);
  });

  it('should map invalid_request to HTTP 400', () => {
    expect(new ParError('invalid_request', 'bad request').statusCode).toBe(400);
  });

  it('should return a Basic challenge for invalid_client', () => {
    expect(new ParError('invalid_client', 'Client authentication failed').wwwAuthenticate).toBe(
      'Basic realm="Client Authentication"',
    );
  });

  it('should not return a challenge for errors other than invalid_client', () => {
    expect(new ParError('invalid_request', 'bad request').wwwAuthenticate).toBe(undefined);
  });

  it('should sanitize the error description to the RFC 6749 §5.2 character set', () => {
    expect(new ParError('invalid_request', 'bad "quoted"\nvalue').errorDescription).toBe(
      'bad ?quoted??value',
    );
  });
});

describe('validatePushedAuthorizationParams', () => {
  it('should return the validated request for a well-formed pushed request', async () => {
    const validated = await validatePushedAuthorizationParams(
      { ...validParams(), client_id: 'web-app' },
      createClientResolver(),
    );

    expect(validated).toMatchObject({
      responseType: 'code',
      clientId: 'web-app',
      redirectUri: 'https://client.example/cb',
      scope: ['openid', 'profile'],
      state: 'af0ifjsldkj',
      nonce: 'n-0S6_WzA2Mj',
      codeChallengeMethod: 'S256',
    });
  });

  it('should map an unregistered redirect_uri to invalid_request', async () => {
    await expect(
      validatePushedAuthorizationParams(
        { ...validParams(), redirect_uri: 'https://attacker.example/cb' },
        createClientResolver(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
  });

  it('should map a missing openid scope to invalid_scope', async () => {
    await expect(
      validatePushedAuthorizationParams({ ...validParams(), scope: 'profile' }, createClientResolver()),
    ).rejects.toMatchObject({ code: 'invalid_scope', statusCode: 400 });
  });

  it('should map an unsupported response_type to unsupported_response_type', async () => {
    await expect(
      validatePushedAuthorizationParams({ ...validParams(), response_type: 'token' }, createClientResolver()),
    ).rejects.toMatchObject({ code: 'unsupported_response_type', statusCode: 400 });
  });

  it('should map an unknown client to invalid_request', async () => {
    await expect(
      validatePushedAuthorizationParams({ ...validParams(), client_id: 'unknown' }, createClientResolver()),
    ).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
  });

  it('should never redirect: the thrown error carries no redirect target', async () => {
    // RFC 9126 §2.3: PAR errors are returned as token-endpoint style JSON, never as a redirect.
    const error = await validatePushedAuthorizationParams(
      { ...validParams(), scope: 'profile' },
      createClientResolver(),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ParError);
    expect(Object.hasOwn(error as object, 'redirectUri')).toBe(false);
  });
});

describe('createPushedAuthorizationRecord', () => {
  it('should issue a request_uri using the RFC 9126 §2.2 URN form', async () => {
    const store = new RecordingStore();
    const record = await createPushedAuthorizationRecord({
      clientId: 'web-app',
      params: validParams(),
      store,
      now: new Date('2026-07-29T00:00:00.000Z'),
    });

    expect(record.requestUri.startsWith(PAR_REQUEST_URI_PREFIX)).toBe(true);
  });

  it('should generate a 256-bit base64url reference value', async () => {
    // RFC 9126 §2.2 / §7.1: the reference value MUST be created with a cryptographically
    // strong PRNG. generateRandomString(32) yields 32 bytes = 43 base64url characters.
    const store = new RecordingStore();
    const record = await createPushedAuthorizationRecord({
      clientId: 'web-app',
      params: validParams(),
      store,
      now: new Date('2026-07-29T00:00:00.000Z'),
    });
    const reference = record.requestUri.slice(PAR_REQUEST_URI_PREFIX.length);

    expect(reference.length).toBe(43);
    expect(/^[A-Za-z0-9_-]{43}$/.test(reference)).toBe(true);
  });

  it('should produce a different reference value on every call', async () => {
    const store = new RecordingStore();
    const first = await createPushedAuthorizationRecord({ clientId: 'web-app', params: validParams(), store });
    const second = await createPushedAuthorizationRecord({ clientId: 'web-app', params: validParams(), store });

    expect(first.requestUri === second.requestUri).toBe(false);
  });

  it('should default the lifetime to 60 seconds', async () => {
    const store = new RecordingStore();
    const record = await createPushedAuthorizationRecord({
      clientId: 'web-app',
      params: validParams(),
      store,
      now: new Date('2026-07-29T00:00:00.000Z'),
    });

    expect(record.expiresAt.toISOString()).toBe('2026-07-29T00:01:00.000Z');
  });

  it('should honor a configured lifetime', async () => {
    const store = new RecordingStore();
    const record = await createPushedAuthorizationRecord({
      clientId: 'web-app',
      params: validParams(),
      store,
      expiresInSeconds: 120,
      now: new Date('2026-07-29T00:00:00.000Z'),
    });

    expect(record.expiresAt.toISOString()).toBe('2026-07-29T00:02:00.000Z');
  });

  it('should reject a lifetime outside the RFC 9126 recommended range', async () => {
    const store = new RecordingStore();

    await expect(
      createPushedAuthorizationRecord({ clientId: 'web-app', params: validParams(), store, expiresInSeconds: 601 }),
    ).rejects.toThrowError(
      new RangeError('expiresInSeconds must be an integer between 5 and 600 (RFC 9126 §2.2), received 601'),
    );
  });

  it('should persist the pushed parameters with the authenticated client_id', async () => {
    const store = new RecordingStore();
    const now = new Date('2026-07-29T00:00:00.000Z');
    const record = await createPushedAuthorizationRecord({
      clientId: 'web-app',
      params: validParams({ client_id: 'web-app' }),
      store,
      now,
    });

    expect(store.saved).toEqual([
      {
        requestUri: record.requestUri,
        clientId: 'web-app',
        params: validParams(),
        createdAt: now,
        expiresAt: new Date('2026-07-29T00:01:00.000Z'),
      },
    ]);
  });

  it('should normalize client_id in the stored parameters to the authenticated client', async () => {
    const store = new RecordingStore();
    const params = validParams();
    delete params['client_id'];
    const record = await createPushedAuthorizationRecord({ clientId: 'web-app', params, store });

    expect(record.params['client_id']).toBe('web-app');
  });

  it('should never persist the client credentials presented for authentication', async () => {
    const store = new RecordingStore();
    const record = await createPushedAuthorizationRecord({
      clientId: 'post-app',
      params: validParams({
        client_id: 'post-app',
        client_secret: 'secret',
        client_assertion: 'assertion',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      }),
      store,
    });

    expect(record.params).toEqual(validParams({ client_id: 'post-app' }));
  });

  it('should not mutate the caller-supplied parameters', async () => {
    const store = new RecordingStore();
    const params = validParams();
    delete params['client_id'];
    await createPushedAuthorizationRecord({ clientId: 'web-app', params, store });

    expect(params['client_id']).toBe(undefined);
  });
});

describe('buildPushedAuthorizationResponse', () => {
  it('should return the request_uri and the lifetime in seconds', () => {
    const response = buildPushedAuthorizationResponse({
      requestUri: `${PAR_REQUEST_URI_PREFIX}ref`,
      clientId: 'web-app',
      params: validParams(),
      createdAt: new Date('2026-07-29T00:00:00.000Z'),
      expiresAt: new Date('2026-07-29T00:01:00.000Z'),
    });

    expect(response).toEqual({
      requestUri: `${PAR_REQUEST_URI_PREFIX}ref`,
      expiresIn: 60,
    });
  });
});

describe('handlePushedAuthorizationRequest', () => {
  it('should store the request and return a 60 second request_uri for a confidential client', async () => {
    const store = new RecordingStore();
    const response = await handlePushedAuthorizationRequest({
      params: validParams(),
      authorizationHeader: basicHeader('web-app', 'secret'),
      clientResolver: createClientResolver(),
      store,
      validationOptions: {},
      now: new Date('2026-07-29T00:00:00.000Z'),
    });

    expect(response).toEqual({
      requestUri: store.saved[0]?.requestUri,
      expiresIn: 60,
    });
    expect(store.saved).toEqual([
      {
        requestUri: store.saved[0]?.requestUri,
        clientId: 'web-app',
        params: validParams(),
        createdAt: new Date('2026-07-29T00:00:00.000Z'),
        expiresAt: new Date('2026-07-29T00:01:00.000Z'),
      },
    ]);
  });

  it('should accept a public client that presents only client_id', async () => {
    const store = new RecordingStore();
    const response = await handlePushedAuthorizationRequest({
      params: validParams({ client_id: 'spa-app', redirect_uri: 'https://spa.example/cb' }),
      authorizationHeader: '',
      clientResolver: createClientResolver(),
      store,
      validationOptions: {},
      now: new Date('2026-07-29T00:00:00.000Z'),
    });

    expect(response.expiresIn).toBe(60);
    expect(store.saved[0]?.clientId).toBe('spa-app');
  });

  it('should not store a record when client authentication fails', async () => {
    const store = new RecordingStore();

    await expect(
      handlePushedAuthorizationRequest({
        params: validParams(),
        authorizationHeader: basicHeader('web-app', 'wrong-secret'),
        clientResolver: createClientResolver(),
        store,
        validationOptions: {},
      }),
    ).rejects.toThrowError(new ParError('invalid_client', 'Client authentication failed'));
    expect(store.saved).toEqual([]);
  });

  it('should not store a record when the pushed parameters are invalid', async () => {
    const store = new RecordingStore();

    await expect(
      handlePushedAuthorizationRequest({
        params: validParams({ redirect_uri: 'https://attacker.example/cb' }),
        authorizationHeader: basicHeader('web-app', 'secret'),
        clientResolver: createClientResolver(),
        store,
        validationOptions: {},
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
    expect(store.saved).toEqual([]);
  });

  it('should reject a request_uri in the body before authenticating', async () => {
    const store = new RecordingStore();

    await expect(
      handlePushedAuthorizationRequest({
        params: validParams({ request_uri: `${PAR_REQUEST_URI_PREFIX}x` }),
        authorizationHeader: basicHeader('web-app', 'secret'),
        clientResolver: createClientResolver(),
        store,
        validationOptions: {},
      }),
    ).rejects.toThrowError(
      new ParError('invalid_request', 'request_uri MUST NOT be included in a pushed authorization request'),
    );
    expect(store.saved).toEqual([]);
  });

  it('should reject a PKCE-less request from a public client', async () => {
    // OAuth 2.1 §4.1.1: PKCE is required. The pushed request is validated exactly as
    // an authorization request would be (RFC 9126 §2.1).
    const store = new RecordingStore();
    const params = validParams({ client_id: 'spa-app', redirect_uri: 'https://spa.example/cb' });
    delete params['code_challenge'];
    delete params['code_challenge_method'];

    await expect(
      handlePushedAuthorizationRequest({
        params,
        authorizationHeader: '',
        clientResolver: createClientResolver(),
        store,
        validationOptions: {},
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', statusCode: 400 });
  });
});
