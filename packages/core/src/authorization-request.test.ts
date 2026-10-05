/**
 * 認可リクエスト検証（OIDC Core 1.0 §3.1.2 / OAuth 2.1 §4.1）の機能単位ステップ関数の網羅テスト。
 *
 * トップレベルの describe は各ステップ関数に対応し、その関数が担う振る舞いを直接呼び出して
 * 検証する。ステップの呼び出し順は CLI 生成コードが担い、通しの順序は CLI 生成 OP の
 * conformance.test.ts が担保する。複数ステップにまたがる振る舞い（Request Object の claim が
 * クエリ値を supersede し、後段のステップで検証される等）は、必要なステップだけを
 * 生成コードと同じ順序でテスト内に並べて呼ぶ。
 *
 * RFC 6749 §4.1.2.1 / OIDC Core 1.0 §3.1.2.6: state はクライアントの CSRF トークンであり、
 * リダイレクト可能エラーでは echo しなければならないが、安全な redirect 先を確定できない
 * エラーでは echo してはならない（攻撃者が指定した URI へリクエストを反射させないため）。
 * redirect 先の確定前に動くステップ（resolveClientForAuthorization /
 * validateRegisteredRedirectUris / resolveRequestObjectParams /
 * resolveAuthorizationRedirectUri）は redirectUri も state も持たない非リダイレクトエラーを投げ、
 * 確定後のステップは受け取った redirectUri と state（Request Object 適用後の有効値）を付けた
 * リダイレクト可能エラーを投げる（登録メタデータの設定ミスによる server_error を除く）。
 * 'error redirectability' の各 describe はこの区別をステップ単位で固定する。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  resolveClientForAuthorization,
  validateRegisteredRedirectUris,
  resolveRequestObjectParams,
  resolveAuthorizationRedirectUri,
  rejectUnsupportedRequestParams,
  validateRequestObjectConsistency,
  validateResponseType,
  validateAuthorizationScope,
  validateAuthorizationCodePkce,
  validatePromptParameter,
  applyOfflineAccessPolicy,
  validateDisplayParameter,
  resolveMaxAge,
  parseAudienceParameter,
  parseClaimsRequestParameter,
  AuthorizationError,
  AuthorizationErrorCode,
  DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH,
} from './authorization-request.js';
import type {
  AuthorizationRequestParams,
  ClientInfo,
  ClientResolver,
} from './authorization-request.js';
import { exportPublicJwk } from './jwks.js';
import { sign, arrayBufferToBase64Url, stringToArrayBuffer } from './crypto-utils.js';

// Helpers for building compact-JWS Request Objects (OIDC Core 1.0 §6.1).
function encodeSegment(value: unknown): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(JSON.stringify(value)));
}

async function buildSignedRequestObject(
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  kid?: string,
  alg = 'RS256',
): Promise<string> {
  const header: Record<string, unknown> = { alg, typ: 'oauth-authz-req+jwt' };
  if (kid !== undefined) header.kid = kid;
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const signature = await sign(signingInput, privateKey);
  return `${signingInput}.${signature}`;
}

function buildUnsignedRequestObject(claims: Record<string, unknown>): string {
  // RFC 7515 §6: the "none" algorithm has an empty signature segment.
  return `${encodeSegment({ alg: 'none' })}.${encodeSegment(claims)}.`;
}

function buildRequestObjectWithAlg(
  alg: string,
  claims: Record<string, unknown>,
): string {
  return `${encodeSegment({ alg })}.${encodeSegment(claims)}.AAAA`;
}

// Helper: create a ClientResolver from an array of clients
function createClientResolver(clients: ClientInfo[]): ClientResolver {
  return {
    findClient: async (clientId: string): Promise<ClientInfo | null> => {
      return clients.find((c) => c.clientId === clientId) ?? null;
    },
  };
}

// Helper: capture the AuthorizationError thrown by a synchronous step (undefined if none)
function captureStepError(fn: () => unknown): AuthorizationError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as AuthorizationError;
  }
}

// Helper: capture the AuthorizationError rejected by an asynchronous step (undefined if none)
async function captureAsyncStepError(
  fn: () => Promise<unknown>,
): Promise<AuthorizationError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as AuthorizationError;
  }
}

// Default valid client
const defaultClient: ClientInfo = {
  clientId: 'client123',
  redirectUris: ['https://client.example.org/cb'],
};

// RFC 7591 §2: grant_types の既定は ["authorization_code"]。offline_access は
// refresh_token grant を登録したクライアントにしか付与されないため、offline_access を
// 扱うテストはこのクライアントを使う。
const refreshGrantClient: ClientInfo = {
  clientId: 'client123',
  redirectUris: ['https://client.example.org/cb'],
  grantTypes: ['authorization_code', 'refresh_token'],
};

// defaultClient の唯一の登録 URI。resolveAuthorizationRedirectUri が確定させる値であり、
// redirect 先の確定後に動くステップにはこの値をエラーのリダイレクト先として渡す。
const REDIRECT_URI = 'https://client.example.org/cb';

// state echo の検証に使うクライアントの CSRF トークン
const STATE = 'csrf-state-123';

// Default valid parameters (PKCE required in OAuth 2.1)
function validParams(
  overrides?: Partial<AuthorizationRequestParams>
): AuthorizationRequestParams {
  return {
    response_type: 'code',
    client_id: 'client123',
    redirect_uri: 'https://client.example.org/cb',
    scope: 'openid',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...overrides,
  };
}

// 署名付き Request Object（OIDC Core 1.0 §6.1）の署名鍵と、その公開鍵を kid 付きで JWKS に
// 登録したクライアント。otherKeyPair は登録外の鍵で署名した Request Object の再現に使う。
let rsaKeyPair: CryptoKeyPair;
let otherKeyPair: CryptoKeyPair;
let roClient: ClientInfo;
const roKid = 'ro-key-1';

beforeAll(async () => {
  rsaKeyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  otherKeyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  roClient = {
    clientId: 'ro-client',
    redirectUris: [REDIRECT_URI],
    jwks: { keys: [await exportPublicJwk(rsaKeyPair.publicKey, roKid)] },
  };
});

// Query parameters sent alongside a Request Object always carry the
// OAuth-syntax-required members (response_type, client_id, scope) plus PKCE
// (required by default).
function roQueryParams(
  overrides?: Partial<AuthorizationRequestParams>,
): AuthorizationRequestParams {
  return {
    response_type: 'code',
    client_id: 'ro-client',
    scope: 'openid',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...overrides,
  };
}

describe('resolveClientForAuthorization', () => {
  describe('ClientResolver integration', () => {
    it('should call findClient with the client_id from the request', async () => {
      let capturedClientId: string | undefined;
      const resolver: ClientResolver = {
        findClient: async (clientId) => {
          capturedClientId = clientId;
          return defaultClient;
        },
      };

      await resolveClientForAuthorization(validParams(), resolver);

      expect(capturedClientId).toBe('client123');
    });

    // ClientResolver の実装バグで別クライアントの登録情報が混入しないよう、返された
    // clientId を実行時に照合する。リクエストではなくサーバ側の不具合なので server_error。
    it('should detect clientId mismatch between request and resolver response', async () => {
      const buggyResolver: ClientResolver = {
        findClient: async () => ({
          clientId: 'different-client',
          redirectUris: ['https://client.example.org/cb'],
        }),
      };

      const error = await captureAsyncStepError(() =>
        resolveClientForAuthorization(validParams(), buggyResolver),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
      expect(error?.redirectable).toBe(false);
    });
  });

  describe('client_id validation', () => {
    it('should accept valid client_id', async () => {
      const client = await resolveClientForAuthorization(
        validParams(),
        createClientResolver([defaultClient]),
      );

      expect(client.clientId).toBe('client123');
    });

    it('should reject missing client_id', async () => {
      const params = {
        response_type: 'code',
        redirect_uri: 'https://client.example.org/cb',
        scope: 'openid',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      } as AuthorizationRequestParams;

      const error = await captureAsyncStepError(() =>
        resolveClientForAuthorization(params, createClientResolver([defaultClient])),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Missing required parameter: client_id');
      expect(error?.redirectable).toBe(false);
    });

    it('should reject unknown client_id', async () => {
      const error = await captureAsyncStepError(() =>
        resolveClientForAuthorization(
          validParams({ client_id: 'unknown-client' }),
          createClientResolver([defaultClient]),
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Unknown client_id');
      expect(error?.redirectable).toBe(false);
    });

    it('should return non-redirectable error for unknown client_id', async () => {
      const error = await captureAsyncStepError(() =>
        resolveClientForAuthorization(
          validParams({ client_id: 'unknown-client' }),
          createClientResolver([defaultClient]),
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(false);
      expect(error?.redirectUri).toBeUndefined();
    });
  });

  // RFC 6749 §4.1.2.1 / OIDC Core 1.0 §3.1.2.6: client を解決できなければ redirect 先も
  // 信頼できないため、リダイレクト不可とし state も echo しない。
  describe('error redirectability', () => {
    it('should return non-redirectable error for invalid client_id', async () => {
      const error = await captureAsyncStepError(() =>
        resolveClientForAuthorization(
          validParams({ client_id: 'unknown' }),
          createClientResolver([defaultClient]),
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(false);
      expect(error?.redirectUri).toBeUndefined();
    });

    it('should not echo state when client_id is missing', async () => {
      const params = {
        response_type: 'code',
        redirect_uri: 'https://client.example.org/cb',
        scope: 'openid',
        state: STATE,
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      } as AuthorizationRequestParams;

      const error = await captureAsyncStepError(() =>
        resolveClientForAuthorization(params, createClientResolver([defaultClient])),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(false);
      expect(error?.state).toBeUndefined();
    });

    it('should not echo state for an unknown client_id', async () => {
      const error = await captureAsyncStepError(() =>
        resolveClientForAuthorization(
          validParams({ client_id: 'unknown-client', state: STATE }),
          createClientResolver([defaultClient]),
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(false);
      expect(error?.state).toBeUndefined();
    });

    it('should not echo state on a clientId mismatch between request and resolver', async () => {
      const buggyResolver: ClientResolver = {
        findClient: async () => ({
          clientId: 'different-client',
          redirectUris: ['https://client.example.org/cb'],
        }),
      };

      const error = await captureAsyncStepError(() =>
        resolveClientForAuthorization(validParams({ state: STATE }), buggyResolver),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(false);
      expect(error?.state).toBeUndefined();
    });
  });
});

describe('validateRegisteredRedirectUris', () => {
  // Helper: capture the thrown AuthorizationError (or undefined if none thrown)
  function captureError(uris: string[]): AuthorizationError | undefined {
    try {
      validateRegisteredRedirectUris(uris);
      return undefined;
    } catch (e) {
      return e as AuthorizationError;
    }
  }

  describe('Fragment rejection', () => {
    // OIDC Core 1.0 Section 3.1.2.1: redirect_uri MUST NOT include a fragment component
    it('should throw server_error when a registered redirect_uri contains a fragment', () => {
      const error = captureError(['https://client.example.org/cb#frag']);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    // OP-redirect_uri-RegFrag: a fragment in a REGISTERED redirect_uri is a client
    // registration (configuration) error, so it stays on the OP as server_error.
    it('should throw a non-redirectable server_error when the registered redirect_uri contains a fragment', () => {
      const error = captureError(['https://client.example.org/cb#bad-fragment']);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
      expect(error?.redirectable).toBe(false);
    });

    // Every registered URI is checked, including ones the request does not use.
    it('should throw server_error when any registered redirect_uri contains fragment', () => {
      const error = captureError([
        'https://client.example.org/cb',
        'https://client.example.org/other#bad',
      ]);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
      expect(error?.errorDescription).toBe(
        'Registered redirect_uri must not contain fragment: https://client.example.org/other#bad',
      );
    });
  });

  describe('Dangerous scheme rejection', () => {
    // OAuth 2.0 Security BCP / RFC 8252 Section 8.5: dangerous schemes are XSS/RCE vectors
    it('should throw server_error for a javascript: scheme', () => {
      const error = captureError(['javascript:alert(1)']);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should throw server_error for a data: scheme', () => {
      const error = captureError(['data:text/html,<script>alert(1)</script>']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should throw server_error for a file: scheme', () => {
      const error = captureError(['file:///etc/passwd']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should throw server_error for a vbscript: scheme', () => {
      const error = captureError(['vbscript:msgbox(1)']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should throw server_error for a blob: scheme', () => {
      const error = captureError(['blob:https://example.com/uuid']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should reject dangerous schemes case-insensitively', () => {
      // Scheme comparison MUST be ASCII case-insensitive (RFC 3986 Section 3.1)
      const error = captureError(['JAVASCRIPT:alert(1)']);

      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });
  });

  describe('Plaintext http:// rejection', () => {
    // OIDC Core 1.0 Section 3.1.2.1 / RFC 8252 Section 8.4: non-loopback plaintext HTTP is not allowed
    it('should throw server_error for a non-loopback http:// redirect_uri', () => {
      const error = captureError(['http://example.com/cb']);

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
    });

    it('should accept http://localhost loopback redirect_uri', () => {
      const error = captureError(['http://localhost:3000/cb']);

      expect(error).toBeUndefined();
    });

    it('should accept http://127.0.0.1 loopback redirect_uri', () => {
      const error = captureError(['http://127.0.0.1:3000/cb']);

      expect(error).toBeUndefined();
    });

    it('should accept any IPv4 loopback http:// redirect_uri', () => {
      const error = captureError(['http://127.0.0.2:3000/cb']);

      expect(error).toBeUndefined();
    });

    it('should accept http://[::1] loopback redirect_uri', () => {
      const error = captureError(['http://[::1]:3000/cb']);

      expect(error).toBeUndefined();
    });
  });

  describe('Allowed redirect_uris', () => {
    it('should accept an https redirect_uri', () => {
      const error = captureError(['https://example.com/cb']);

      expect(error).toBeUndefined();
    });

    // RFC 8252 Section 7.1: custom (private-use) URI schemes are permitted for native apps
    it('should accept a custom scheme redirect_uri', () => {
      const error = captureError(['com.example.app:/oauth2redirect']);

      expect(error).toBeUndefined();
    });
  });
});

// OIDC Core 1.0 §6.1 (Passing a Request Object by Value): the OP accepts a signed
// JWS Request Object whose claims are the Authorization Request parameters. The
// signature is verified against the client's registered JWKS and the request
// object claims supersede the OAuth query parameters.
describe('resolveRequestObjectParams', () => {
  describe('superseding query parameters', () => {
    it('should use request object parameters as the values driving subsequent processing', async () => {
      // OIDC Core 1.0 §6.1: the request object claims ARE the request parameters.
      // Every member below is present ONLY in the request object (not the query),
      // so the later steps' results prove the request object content is consumed
      // and run through the same validation/normalization as query parameters
      // (prompt -> string[], max_age -> number, etc.).
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: REDIRECT_URI,
          scope: 'openid profile',
          state: 'ro-state',
          nonce: 'ro-nonce',
          prompt: 'login consent',
          max_age: 120,
          acr_values: 'urn:mace:incommon:iap:silver',
          login_hint: 'alice@example.org',
        },
        rsaKeyPair.privateKey,
        roKid,
      );
      const params = roQueryParams({ request });

      const { effectiveParams } = await resolveRequestObjectParams(params, roClient);
      const redirectUri = resolveAuthorizationRedirectUri(effectiveParams, roClient);
      const state = effectiveParams.state;
      const scope = validateAuthorizationScope(params, effectiveParams, redirectUri, state);
      const prompt = validatePromptParameter(effectiveParams, redirectUri, state);
      const maxAge = resolveMaxAge(effectiveParams, roClient, redirectUri, state);

      expect(redirectUri).toBe(REDIRECT_URI);
      expect(state).toBe('ro-state');
      expect(scope).toEqual(['openid', 'profile']);
      expect(prompt).toEqual(['login', 'consent']);
      expect(maxAge).toBe(120);
      // nonce / acr_values / login_hint は検証ステップを持たず、有効パラメータの値がそのまま使われる
      expect(effectiveParams).toMatchObject({
        nonce: 'ro-nonce',
        acr_values: 'urn:mace:incommon:iap:silver',
        login_hint: 'alice@example.org',
      });
    });

    it('should let a request object parameter supersede the same query parameter', async () => {
      // OIDC Core 1.0 §6.1: when a parameter is present in both the query and the
      // request object, the request object value is used (supersede) — consistently
      // for state, nonce, and the rest. Differing values are NOT an error.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: REDIRECT_URI,
          scope: 'openid',
          state: 'ro-state',
          nonce: 'ro-nonce',
        },
        rsaKeyPair.privateKey,
        roKid,
      );

      const { effectiveParams } = await resolveRequestObjectParams(
        roQueryParams({ request, state: 'query-state', nonce: 'query-nonce' }),
        roClient,
      );

      expect(effectiveParams).toMatchObject({
        state: 'ro-state',
        nonce: 'ro-nonce',
      });
    });
  });

  // OIDC Core 1.0 §6.3: "invalid_request_object: The request parameter contains an
  // invalid Request Object." Parse/verification failures use this code, not the
  // generic invalid_request.
  describe('invalid Request Object (OIDC Core 1.0 §6.3)', () => {
    it('should reject a request object whose signature does not verify with invalid_request_object', async () => {
      // Signed with a different key than the one published under kid.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: REDIRECT_URI,
          scope: 'openid',
        },
        otherKeyPair.privateKey,
        roKid,
      );

      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(roQueryParams({ request }), roClient),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.errorDescription).toBe('request object signature verification failed');
    });

    it('should reject a request object with an unknown kid with invalid_request_object', async () => {
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: REDIRECT_URI,
          scope: 'openid',
        },
        rsaKeyPair.privateKey,
        'unknown-kid',
      );

      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(roQueryParams({ request }), roClient),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.errorDescription).toBe('no JWK matched the request object header (kid)');
    });

    it('should reject a request object with an unsupported signing alg with invalid_request_object', async () => {
      const request = buildRequestObjectWithAlg('HS256', {
        response_type: 'code',
        client_id: 'ro-client',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
      });

      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(roQueryParams({ request }), roClient),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.errorDescription).toBe('unsupported request object signing alg: HS256');
    });

    it('should reject a request object when no client JWKS is registered with invalid_request_object', async () => {
      const noJwksClient: ClientInfo = {
        clientId: 'ro-client-nokeys',
        redirectUris: [REDIRECT_URI],
      };
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client-nokeys',
          redirect_uri: REDIRECT_URI,
          scope: 'openid',
        },
        rsaKeyPair.privateKey,
        roKid,
      );

      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(
          roQueryParams({ client_id: 'ro-client-nokeys', request }),
          noJwksClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.errorDescription).toBe(
        'no JWKS registered to verify the request object signature',
      );
    });

    it('should reject a request object with a broken JWS structure with invalid_request_object', async () => {
      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(roQueryParams({ request: 'not-a-jwt' }), roClient),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.errorDescription).toBe(
        'request object is not a JWS compact serialization',
      );
    });

    it('should reject a JWE (5-segment) request object with invalid_request_object', async () => {
      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(roQueryParams({ request: 'a.b.c.d.e' }), roClient),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.errorDescription).toBe(
        'request object is not a JWS compact serialization',
      );
    });
  });

  describe('unsigned Request Object (alg=none)', () => {
    it('should accept an unsigned (alg=none) request object when allowUnsigned is enabled', async () => {
      // OIDF Conformance Suite: some Basic OP modules send an unsigned request object,
      // which allowUnsigned exists to accept. Its claims are processed by the same
      // steps as a signed request object's claims.
      const request = buildUnsignedRequestObject({
        response_type: 'code',
        client_id: 'ro-client',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
        state: 'u-state',
        nonce: 'u-nonce',
      });

      const { effectiveParams } = await resolveRequestObjectParams(
        roQueryParams({ request }),
        roClient,
        { allowUnsigned: true },
      );
      const redirectUri = resolveAuthorizationRedirectUri(effectiveParams, roClient);

      expect(redirectUri).toBe(REDIRECT_URI);
      expect(effectiveParams).toMatchObject({
        state: 'u-state',
        nonce: 'u-nonce',
      });
    });

    it('should reject an unsigned request object with invalid_request_object when allowUnsigned is false', async () => {
      const request = buildUnsignedRequestObject({
        response_type: 'code',
        client_id: 'ro-client',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
      });

      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(roQueryParams({ request }), roClient),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.errorDescription).toBe(
        'unsigned request object (alg=none) is not supported',
      );
    });
  });

  // RFC 6749 §4.1.2.1 / OIDC Core 1.0 §3.1.2.6: redirect 先の確定前に動くステップのため、
  // 失敗はリダイレクト不可とし state も echo しない。
  describe('error redirectability', () => {
    it('should throw without a redirect uri when the request object cannot be parsed', async () => {
      // A broken Request Object cannot be trusted, including any redirect_uri it may
      // carry, so the error must stay on the OP (non-redirectable, no state echo).
      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(
          roQueryParams({ request: 'not-a-jwt', state: 'st-broken' }),
          roClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.redirectable).toBe(false);
      expect(error?.redirectUri).toBeUndefined();
      expect(error?.state).toBeUndefined();
    });

    it('should not echo state when the Request Object fails to parse', async () => {
      const error = await captureAsyncStepError(() =>
        resolveRequestObjectParams(
          validParams({ request: 'not.a.valid.jws', state: STATE }),
          defaultClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequestObject);
      expect(error?.redirectable).toBe(false);
      expect(error?.state).toBeUndefined();
    });
  });
});

describe('resolveAuthorizationRedirectUri', () => {
  describe('redirect_uri validation', () => {
    it('should accept registered redirect_uri', () => {
      const redirectUri = resolveAuthorizationRedirectUri(validParams(), defaultClient);

      expect(redirectUri).toBe('https://client.example.org/cb');
    });

    // OP-redirect_uri-NotReg: Reject unregistered URIs
    it('should reject unregistered redirect_uri', () => {
      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'https://evil.example.com/cb' }),
          defaultClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.errorDescription).toBe('redirect_uri not registered');
      expect(error?.redirectable).toBe(false);
    });

    it('should return non-redirectable error for unregistered redirect_uri', () => {
      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'https://evil.example.com/cb' }),
          defaultClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(false);
      expect(error?.redirectUri).toBeUndefined();
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should use single registered redirect_uri when omitted from request', () => {
      const redirectUri = resolveAuthorizationRedirectUri(
        validParams({ redirect_uri: undefined }),
        defaultClient,
      );

      expect(redirectUri).toBe('https://client.example.org/cb');
    });

    // OP-redirect_uri-Missing: Require redirect_uri when multiple registered
    it('should reject missing redirect_uri when multiple URIs are registered', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: [
          'https://client.example.org/cb1',
          'https://client.example.org/cb2',
        ],
      };

      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(validParams({ redirect_uri: undefined }), client),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.errorDescription).toBe(
        'redirect_uri is required when multiple redirect URIs are registered',
      );
      expect(error?.redirectable).toBe(false);
    });

    // Exact string matching - RFC 3986 Section 6.2.1
    it('should use exact string matching for redirect_uri', () => {
      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'https://client.example.org/cb/' }),
          defaultClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('redirect_uri not registered');
    });

    // OP-redirect_uri-RegFrag: Reject fragments
    it('should reject redirect_uri with fragment', () => {
      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'https://client.example.org/cb#fragment' }),
          defaultClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.errorDescription).toBe('redirect_uri must not contain fragment');
      expect(error?.redirectable).toBe(false);
    });

    // OP-redirect_uri-Query-OK: Preserve registered query parameters
    it('should accept redirect_uri with matching registered query parameters', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb?mode=auth'],
      };

      const redirectUri = resolveAuthorizationRedirectUri(
        validParams({ redirect_uri: 'https://client.example.org/cb?mode=auth' }),
        client,
      );

      expect(redirectUri).toBe('https://client.example.org/cb?mode=auth');
    });

    // OP-redirect_uri-Query-Mismatch: Reject mismatched query parameters
    it('should reject redirect_uri with mismatched query parameters', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb?mode=auth'],
      };

      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'https://client.example.org/cb?mode=other' }),
          client,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('redirect_uri not registered');
    });

    // OP-redirect_uri-Query-Added: Reject added query parameters
    it('should reject redirect_uri with added query parameters', () => {
      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'https://client.example.org/cb?extra=param' }),
          defaultClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('redirect_uri not registered');
    });
  });

  // Loopback exception: allow variable port numbers (public clients only)
  // OAuth 2.1 Section 10.3.3
  describe('loopback redirect_uri', () => {
    it('should allow different port for loopback redirect_uri when client is public', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://127.0.0.1/callback'],
        clientType: 'public',
      };

      const redirectUri = resolveAuthorizationRedirectUri(
        validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
        client,
      );

      expect(redirectUri).toBe('http://127.0.0.1:8080/callback');
    });

    it('should allow different port for localhost redirect_uri when client is public', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://localhost/callback'],
        clientType: 'public',
      };

      const redirectUri = resolveAuthorizationRedirectUri(
        validParams({ redirect_uri: 'http://localhost:9000/callback' }),
        client,
      );

      expect(redirectUri).toBe('http://localhost:9000/callback');
    });

    // OAuth 2.1 Section 10.3.3: ループバックポート許容は public client 限定。
    // confidential client は厳格一致 (登録ポートと一致しなければ不一致)。
    it('should reject different port for loopback redirect_uri when client is confidential', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://127.0.0.1/callback'],
        clientType: 'confidential',
      };

      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
          client,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should reject different port for loopback redirect_uri when clientType is unspecified (defaults to strict)', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['http://127.0.0.1/callback'],
      };

      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'http://127.0.0.1:8080/callback' }),
          client,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });
  });

  // OIDC Core 1.0 §6.1: redirect_uri is resolved from the effective parameters, so a
  // Request Object's redirect_uri supersedes the query's.
  describe('Request Object redirect_uri', () => {
    it('should prefer a valid redirect_uri from the request object over an invalid top-level redirect_uri', async () => {
      // oidcc-ensure-request-object-with-redirect-uri: a valid redirect_uri inside the
      // request object must take precedence over an invalid top-level redirect_uri.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: REDIRECT_URI,
          scope: 'openid',
        },
        rsaKeyPair.privateKey,
        roKid,
      );

      const { effectiveParams } = await resolveRequestObjectParams(
        roQueryParams({ request, redirect_uri: 'https://evil.example.com/cb' }),
        roClient,
      );
      const redirectUri = resolveAuthorizationRedirectUri(effectiveParams, roClient);

      expect(redirectUri).toBe(REDIRECT_URI);
    });
  });

  // RFC 6749 §4.1.2.1 / OIDC Core 1.0 §3.1.2.6: 登録外の redirect_uri へはリダイレクト
  // できないため、リダイレクト不可とし state も echo しない。
  describe('error redirectability', () => {
    it('should return non-redirectable error for invalid redirect_uri', () => {
      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'https://evil.example.com/cb' }),
          defaultClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(false);
      expect(error?.redirectUri).toBeUndefined();
    });

    it('should not echo state for an unregistered redirect_uri', () => {
      const error = captureStepError(() =>
        resolveAuthorizationRedirectUri(
          validParams({ redirect_uri: 'https://evil.example.com/cb', state: STATE }),
          defaultClient,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(false);
      expect(error?.state).toBeUndefined();
    });
  });
});

describe('rejectUnsupportedRequestParams', () => {
  // OIDC Core 1.0 §6.2 / §6.3: request_uri (Request Object by reference) is unsupported
  // and must be rejected with request_uri_not_supported (redirectable, state echoed).
  describe('request_uri parameter', () => {
    it('should reject the request_uri parameter with request_uri_not_supported', () => {
      const params = validParams({
        request_uri: 'https://client.example.org/req.jwt',
        state: 'st-2',
      });

      const error = captureStepError(() =>
        rejectUnsupportedRequestParams(params, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.RequestUriNotSupported);
      expect(error?.redirectable).toBe(true);
      expect(error?.redirectUri).toBe(REDIRECT_URI);
      expect(error?.state).toBe('st-2');
    });
  });

  // OIDC Core 1.0 §3.1.2.1 / §3.1.2.6: the `registration` parameter is unsupported and
  // must be rejected with registration_not_supported (redirectable, state echoed).
  describe('registration parameter', () => {
    it('should reject the registration parameter with registration_not_supported', () => {
      const params = validParams({
        registration: '{"client_name":"x"}',
        state: 'st-reg',
      });

      const error = captureStepError(() =>
        rejectUnsupportedRequestParams(params, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.RegistrationNotSupported);
      expect(error?.redirectable).toBe(true);
      expect(error?.redirectUri).toBe(REDIRECT_URI);
      expect(error?.state).toBe('st-reg');
    });

    it('should pass a request without the registration parameter', () => {
      const error = captureStepError(() =>
        rejectUnsupportedRequestParams(validParams(), REDIRECT_URI),
      );

      expect(error).toBeUndefined();
    });
  });

  // OIDC Core 1.0 §6.3: request パラメータ（Request Object by value）を OP が
  // サポートしない構成では request_not_supported で拒否する。生成コードは Request Object
  // 機能を無効にした構成では resolveRequestObjectParams を呼ばず（有効パラメータは
  // クエリそのもの）、このステップに requestParameterSupported: false を渡す。
  // 既定はサポート扱いで、request パラメータを拒否しない。
  describe('request parameter support toggle', () => {
    it('should reject the request parameter with request_not_supported when requestParameterSupported is false', () => {
      const params = validParams({
        request: 'header.payload.signature',
        state: 'st-req-ns',
      });

      const redirectUri = resolveAuthorizationRedirectUri(params, defaultClient);
      const error = captureStepError(() =>
        rejectUnsupportedRequestParams(params, redirectUri, params.state, {
          requestParameterSupported: false,
        }),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.RequestNotSupported);
      // redirect 先はクエリパラメータから解決され、state も echo される（redirectable）。
      expect(error?.redirectUri).toBe('https://client.example.org/cb');
      expect(error?.state).toBe('st-req-ns');
    });

    it('should reject without parsing when requestParameterSupported is false and the request object is malformed', () => {
      // サポート時なら resolveRequestObjectParams の parse 失敗で invalid_request_object
      // （非リダイレクト）になる壊れた値。非サポート時は parse せずに
      // request_not_supported で拒否されなければならない。
      const params = validParams({ request: 'not-a-jwt', state: 'st-malformed' });

      const error = captureStepError(() =>
        rejectUnsupportedRequestParams(params, REDIRECT_URI, params.state, {
          requestParameterSupported: false,
        }),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.RequestNotSupported);
      expect(error?.state).toBe('st-malformed');
    });

    it('should pass a request without the request parameter when requestParameterSupported is false', () => {
      const error = captureStepError(() =>
        rejectUnsupportedRequestParams(validParams(), REDIRECT_URI, undefined, {
          requestParameterSupported: false,
        }),
      );

      expect(error).toBeUndefined();
    });
  });
});

describe('validateRequestObjectConsistency', () => {
  // OIDC Core 1.0 §6.1: response_type / client_id MUST be sent using the OAuth 2.0
  // request syntax. When the Request Object also carries them, the values must match.
  it('should reject when the request object response_type does not match the query', async () => {
    const request = await buildSignedRequestObject(
      {
        response_type: 'token',
        client_id: 'ro-client',
        redirect_uri: REDIRECT_URI,
        scope: 'openid',
      },
      rsaKeyPair.privateKey,
      roKid,
    );
    const params = roQueryParams({ request });

    const { effectiveParams, requestObjectClaims } = await resolveRequestObjectParams(
      params,
      roClient,
    );
    const error = captureStepError(() =>
      validateRequestObjectConsistency(
        params,
        requestObjectClaims,
        REDIRECT_URI,
        effectiveParams.state,
      ),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.errorDescription).toBe(
      'request object response_type does not match the request',
    );
  });
});

describe('validateResponseType', () => {
  describe('response_type validation', () => {
    // OP-Response-code: Request with response_type=code
    it('should accept response_type=code', () => {
      const responseType = validateResponseType(validParams(), defaultClient, REDIRECT_URI);

      expect(responseType).toBe('code');
    });

    // OP-Response-Missing: Reject missing response_type
    it('should reject missing response_type', () => {
      const error = captureStepError(() =>
        validateResponseType(
          validParams({ response_type: undefined }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Missing required parameter: response_type');
      expect(error?.redirectable).toBe(true);
    });

    it('should reject unsupported response_type', () => {
      const error = captureStepError(() =>
        validateResponseType(
          validParams({ response_type: 'token' }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.UnsupportedResponseType);
      expect(error?.errorDescription).toBe('Unsupported response_type: token');
      expect(error?.redirectable).toBe(true);
    });
  });

  // RFC 6749 §4.1.2.1 / OAuth 2.1 §4.1.2.1: unauthorized_client =
  // "The client is not authorized to request an authorization code using this method."
  // OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: response_types default is ["code"].
  describe('client response_types enforcement', () => {
    it('should reject response_type=code with unauthorized_client when client responseTypes excludes code', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb'],
        responseTypes: [], // explicitly registered without "code"
      };
      const params = validParams({ state: 'xyz' });

      const error = captureStepError(() =>
        validateResponseType(params, client, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.UnauthorizedClient);
      expect(error?.errorDescription).toBe(
        'Client is not authorized to use response_type: code',
      );
    });

    it('should return a redirectable error preserving state for unauthorized_client', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb'],
        responseTypes: [],
      };
      const params = validParams({ state: 'state-abc' });

      const error = captureStepError(() =>
        validateResponseType(params, client, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(true);
      expect(error?.redirectUri).toBe('https://client.example.org/cb');
      expect(error?.state).toBe('state-abc');
    });

    it('should allow response_type=code when client responseTypes includes code', () => {
      const client: ClientInfo = {
        clientId: 'client123',
        redirectUris: ['https://client.example.org/cb'],
        responseTypes: ['code'],
      };

      const responseType = validateResponseType(validParams(), client, REDIRECT_URI);

      expect(responseType).toBe('code');
    });

    it('should allow response_type=code when responseTypes is unspecified (default ["code"])', () => {
      // OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: response_types を
      // 省略したクライアントの既定値は ["code"]。
      const responseType = validateResponseType(validParams(), defaultClient, REDIRECT_URI);

      expect(responseType).toBe('code');
    });

    it('should return unsupported_response_type (not unauthorized_client) for a globally unsupported response_type', () => {
      // Global OP-level rejection MUST be distinguished from per-client authorization.
      const error = captureStepError(() =>
        validateResponseType(
          validParams({ response_type: 'token' }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.UnsupportedResponseType);
    });
  });

  // RFC 6749 §4.1.2.1 / OIDC Core 1.0 §3.1.2.6: redirect 先の確定後に動くステップのため、
  // 失敗は確定済みの redirect_uri へのリダイレクト可能エラーとし、state を echo する。
  describe('error redirectability', () => {
    it('should return redirectable error carrying the resolved redirect_uri', () => {
      const error = captureStepError(() =>
        validateResponseType(
          validParams({ response_type: undefined }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(true);
      expect(error?.redirectUri).toBe('https://client.example.org/cb');
    });

    it('should include state in redirectable errors when state was provided', () => {
      const params = validParams({ response_type: 'token', state: 'my-state-value' });

      const error = captureStepError(() =>
        validateResponseType(params, defaultClient, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(true);
      expect(error?.state).toBe('my-state-value');
    });

    it('should echo state on unsupported_response_type', () => {
      const params = validParams({ response_type: 'token', state: STATE });

      const error = captureStepError(() =>
        validateResponseType(params, defaultClient, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.UnsupportedResponseType);
      expect(error?.redirectable).toBe(true);
      expect(error?.state).toBe(STATE);
    });
  });
});

describe('validateAuthorizationScope', () => {
  describe('scope validation', () => {
    it('should accept scope containing openid', () => {
      const params = validParams({ scope: 'openid profile' });

      const scope = validateAuthorizationScope(params, params, REDIRECT_URI);

      expect(scope).toEqual(['openid', 'profile']);
    });

    it('should reject missing scope', () => {
      const params = validParams({ scope: undefined });

      const error = captureStepError(() =>
        validateAuthorizationScope(params, params, REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Missing required parameter: scope');
      expect(error?.redirectable).toBe(true);
    });

    // OIDC Core 1.0 §3.1.2.1: scope MUST contain openid
    it('should reject scope without openid', () => {
      const params = validParams({ scope: 'profile email' });

      const error = captureStepError(() =>
        validateAuthorizationScope(params, params, REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidScope);
      expect(error?.errorDescription).toBe('scope must include openid');
      expect(error?.redirectable).toBe(true);
    });

    it('should parse multiple scopes into array', () => {
      const params = validParams({ scope: 'openid profile email address phone' });

      const scope = validateAuthorizationScope(params, params, REDIRECT_URI);

      expect(scope).toEqual([
        'openid',
        'profile',
        'email',
        'address',
        'phone',
      ]);
    });

    // RFC 6749 §3.3: scope is a set. Duplicates must be canonicalized so issued
    // artifacts are deterministic and match the Token Endpoint (refresh_token grant
    // already dedups via [...new Set(...)]). Insertion order is preserved.
    it('should deduplicate repeated scope values preserving first-seen order', () => {
      const params = validParams({ scope: 'openid openid profile' });

      const scope = validateAuthorizationScope(params, params, REDIRECT_URI);

      expect(scope).toEqual(['openid', 'profile']);
    });
  });

  // OIDC Core 1.0 §6.1: the Request Object scope supersedes the query scope.
  describe('Request Object scope', () => {
    it('should reject a request object scope that omits openid (supersedes the query scope)', async () => {
      // The request object scope supersedes the query scope, so an effective scope
      // without openid is rejected exactly as a query scope without openid would be.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: REDIRECT_URI,
          scope: 'profile email',
        },
        rsaKeyPair.privateKey,
        roKid,
      );
      const params = roQueryParams({ request });

      const { effectiveParams } = await resolveRequestObjectParams(params, roClient);
      const error = captureStepError(() =>
        validateAuthorizationScope(params, effectiveParams, REDIRECT_URI, effectiveParams.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidScope);
    });
  });

  // RFC 6749 §4.1.2.1 / OIDC Core 1.0 §3.1.2.6: redirect 先の確定後に動くステップのため、
  // リクエストに state があればリダイレクト可能エラーに echo し、無ければ付けない。
  describe('error redirectability', () => {
    it('should echo state on invalid_scope (scope without openid)', () => {
      const params = validParams({ scope: 'profile email', state: STATE });

      const error = captureStepError(() =>
        validateAuthorizationScope(params, params, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidScope);
      expect(error?.redirectable).toBe(true);
      expect(error?.state).toBe(STATE);
    });

    it('should NOT attach state on a redirectable error when the request omits state', () => {
      const params = validParams({ scope: 'profile email' });

      const error = captureStepError(() =>
        validateAuthorizationScope(params, params, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(true);
      expect(error?.state).toBeUndefined();
    });
  });
});

// OAuth 2.1 Section 4.1.1, 7.5 - PKCE is REQUIRED
describe('validateAuthorizationCodePkce', () => {
  describe('PKCE validation (OAuth 2.1)', () => {
    it('should accept valid code_challenge with S256 method', () => {
      const pkce = validateAuthorizationCodePkce(
        validParams({
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        }),
        defaultClient,
        REDIRECT_URI,
      );

      expect(pkce).toEqual({
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        codeChallengeMethod: 'S256',
      });
    });

    // Security: plain method is rejected to enforce S256
    it('should reject code_challenge_method=plain', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            code_challenge: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
            code_challenge_method: 'plain',
          }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Unsupported code_challenge_method: plain');
      expect(error?.redirectable).toBe(true);
    });

    it('should reject missing code_challenge_method', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
            code_challenge_method: undefined,
          }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe(
        'Missing required parameter: code_challenge_method',
      );
      expect(error?.redirectable).toBe(true);
    });

    // OAuth 2.1: PKCE is REQUIRED
    it('should reject missing code_challenge', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({ code_challenge: undefined }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Missing required parameter: code_challenge');
      expect(error?.redirectable).toBe(true);
    });

    it('should reject empty code_challenge', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({ code_challenge: '' }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Missing required parameter: code_challenge');
      expect(error?.redirectable).toBe(true);
    });

    // OAuth 2.1 Section 7.5.2: MUST reject unsupported methods
    it('should reject unsupported code_challenge_method', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({ code_challenge_method: 'S512' }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Unsupported code_challenge_method: S512');
      expect(error?.redirectable).toBe(true);
    });

    it('should include state in PKCE error when state was provided', () => {
      const params = validParams({ code_challenge: undefined, state: 'my-state' });

      const error = captureStepError(() =>
        validateAuthorizationCodePkce(params, defaultClient, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.state).toBe('my-state');
    });
  });

  // OAuth 2.1 では PKCE は必須。OIDF Basic OP の static-client conformance は
  // confidential client の PKCE なし authorization code flow を試験するため、
  // allowNonPkceAuthorizationCodeFlow はその対象に限って省略を許容する。
  describe('allowNonPkceAuthorizationCodeFlow option', () => {
    it('should accept missing PKCE parameters for explicit confidential clients when allowNonPkceAuthorizationCodeFlow is enabled', () => {
      const client: ClientInfo = {
        ...defaultClient,
        clientType: 'confidential',
      };

      const pkce = validateAuthorizationCodePkce(
        validParams({
          code_challenge: undefined,
          code_challenge_method: undefined,
        }),
        client,
        REDIRECT_URI,
        undefined,
        { allowNonPkceAuthorizationCodeFlow: true },
      );

      expect(pkce).toEqual({});
    });

    it('should reject missing PKCE parameters for public clients even when allowNonPkceAuthorizationCodeFlow is enabled', () => {
      const client: ClientInfo = {
        ...defaultClient,
        clientType: 'public',
      };

      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            code_challenge: undefined,
            code_challenge_method: undefined,
          }),
          client,
          REDIRECT_URI,
          undefined,
          { allowNonPkceAuthorizationCodeFlow: true },
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.redirectable).toBe(true);
    });

    it('should reject invalid code_challenge values even when allowNonPkceAuthorizationCodeFlow is enabled', () => {
      const client: ClientInfo = {
        ...defaultClient,
        clientType: 'confidential',
      };

      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            code_challenge: 'too-short',
            code_challenge_method: 'S256',
          }),
          client,
          REDIRECT_URI,
          undefined,
          { allowNonPkceAuthorizationCodeFlow: true },
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.redirectable).toBe(true);
    });
  });

  // RFC 7636 Section 4.2: S256 code_challenge is BASE64URL(SHA256(...)),
  // fixed at 43 characters using only [A-Za-z0-9\-_].
  describe('code_challenge format validation (S256)', () => {
    it('should accept a 43-character base64url code_challenge', () => {
      // 43 chars, includes both '-' and '_' base64url symbols
      const pkce = validateAuthorizationCodePkce(
        validParams({
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
        }),
        defaultClient,
        REDIRECT_URI,
      );

      expect(pkce.codeChallenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('should reject a code_challenge shorter than 43 characters', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            // 42 characters
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c',
            code_challenge_method: 'S256',
          }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.redirectable).toBe(true);
    });

    it('should reject a code_challenge longer than 43 characters', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            // 44 characters
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cMa',
            code_challenge_method: 'S256',
          }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.redirectable).toBe(true);
    });

    // The inputs below are exactly 43 characters, so the base64url character check
    // (not the length check) is what rejects them.
    it('should reject a code_challenge containing non-base64url symbols', () => {
      // '+', '/', '=' are standard base64 but invalid for base64url
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst+/=M',
            code_challenge_method: 'S256',
          }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe(
        'code_challenge contains invalid characters (must be base64url: [A-Za-z0-9-_], 43 chars)',
      );
      expect(error?.redirectable).toBe(true);
    });

    it('should reject a code_challenge containing punctuation such as ! or ?', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst!?cM',
            code_challenge_method: 'S256',
          }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe(
        'code_challenge contains invalid characters (must be base64url: [A-Za-z0-9-_], 43 chars)',
      );
      expect(error?.redirectable).toBe(true);
    });

    it('should reject a code_challenge containing whitespace or newline', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSst \ncM',
            code_challenge_method: 'S256',
          }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe(
        'code_challenge contains invalid characters (must be base64url: [A-Za-z0-9-_], 43 chars)',
      );
      expect(error?.redirectable).toBe(true);
    });

    it('should describe the base64url and 43-character requirement in error_description', () => {
      const error = captureStepError(() =>
        validateAuthorizationCodePkce(
          validParams({
            code_challenge: 'too-short',
            code_challenge_method: 'S256',
          }),
          defaultClient,
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.errorDescription).toBe(
        'code_challenge must be a 43-character base64url-encoded SHA-256 hash for S256',
      );
    });
  });
});

// OIDC Core 1.0 Section 3.1.2.1: prompt is a space-delimited list of
// none / login / consent / select_account.
describe('validatePromptParameter', () => {
  describe('prompt values', () => {
    it('should accept prompt=none', () => {
      const prompt = validatePromptParameter(validParams({ prompt: 'none' }), REDIRECT_URI);

      expect(prompt).toEqual(['none']);
    });

    it('should accept prompt=login', () => {
      const prompt = validatePromptParameter(validParams({ prompt: 'login' }), REDIRECT_URI);

      expect(prompt).toEqual(['login']);
    });

    it('should accept prompt=consent', () => {
      const prompt = validatePromptParameter(validParams({ prompt: 'consent' }), REDIRECT_URI);

      expect(prompt).toEqual(['consent']);
    });

    it('should accept prompt=select_account', () => {
      const prompt = validatePromptParameter(
        validParams({ prompt: 'select_account' }),
        REDIRECT_URI,
      );

      expect(prompt).toEqual(['select_account']);
    });

    it('should accept multiple prompt values', () => {
      const prompt = validatePromptParameter(
        validParams({ prompt: 'login consent' }),
        REDIRECT_URI,
      );

      expect(prompt).toEqual(['login', 'consent']);
    });

    // OIDC Core 1.0 Section 3.1.2.1: none MUST NOT be combined with other values
    it('should reject prompt=none combined with other values', () => {
      const error = captureStepError(() =>
        validatePromptParameter(validParams({ prompt: 'none login' }), REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.redirectable).toBe(true);
    });

    it('should reject invalid prompt value', () => {
      const error = captureStepError(() =>
        validatePromptParameter(validParams({ prompt: 'invalid_value' }), REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Invalid prompt value: invalid_value');
      expect(error?.redirectable).toBe(true);
    });
  });

  // OIDC Core 1.0 §6.1: the Request Object prompt supersedes the query prompt.
  describe('Request Object prompt', () => {
    it('should validate a request object parameter the same as a query parameter (invalid prompt)', async () => {
      // A bogus prompt inside the request object must be rejected exactly as a bogus
      // prompt in the query would be — proving the value flows through
      // validatePromptParameter.
      const request = await buildSignedRequestObject(
        {
          response_type: 'code',
          client_id: 'ro-client',
          redirect_uri: REDIRECT_URI,
          scope: 'openid',
          prompt: 'bogus',
        },
        rsaKeyPair.privateKey,
        roKid,
      );

      const { effectiveParams } = await resolveRequestObjectParams(
        roQueryParams({ request }),
        roClient,
      );
      const error = captureStepError(() =>
        validatePromptParameter(effectiveParams, REDIRECT_URI, effectiveParams.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('Invalid prompt value: bogus');
    });
  });
});

describe('applyOfflineAccessPolicy', () => {
  // OIDC Core 1.0 §11: offline_access requires prompt=consent (or another granting condition)
  describe('offline_access scope gating (OIDC Core 1.0 §11)', () => {
    it('should drop offline_access from scope when prompt is missing', async () => {
      // validatePromptParameter は prompt が無いと undefined を返し、それがそのまま渡される。
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access' }),
        undefined,
        refreshGrantClient,
      );

      expect(scope).toEqual(['openid']);
    });

    it('should drop offline_access when prompt does not include consent', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'login' }),
        ['login'],
        refreshGrantClient,
      );

      expect(scope).toEqual(['openid']);
    });

    it('should retain offline_access when prompt=consent is present', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'consent' }),
        ['consent'],
        refreshGrantClient,
      );

      expect(scope).toEqual(['openid', 'offline_access']);
    });

    it('should retain offline_access when prompt includes consent among others', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'login consent' }),
        ['login', 'consent'],
        refreshGrantClient,
      );

      expect(scope).toEqual(['openid', 'offline_access']);
    });

    it('should drop offline_access when prompt=none and offline_access is requested', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'none' }),
        ['none'],
        refreshGrantClient,
      );

      expect(scope).toEqual(['openid']);
    });

    it('should allow a custom isOfflineAccessGranted callback to override the default', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access' }),
        undefined,
        refreshGrantClient,
        () => true,
      );

      expect(scope).toEqual(['openid', 'offline_access']);
    });

    it('should pass parsed prompt values to the custom callback', async () => {
      let received: string[] | undefined;
      const params = validParams({ scope: 'openid offline_access', prompt: 'login' });

      const prompt = validatePromptParameter(params, REDIRECT_URI, params.state);
      await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        params,
        prompt,
        refreshGrantClient,
        (_request, context) => {
          received = context.promptValues;
          return false;
        },
      );

      expect(received).toEqual(['login']);
    });
  });

  // RFC 7591 §2 / OIDC Dynamic Client Registration 1.0 §2: grant_types はクライアントが
  // token endpoint で使える grant type の登録。refresh_token を登録していないクライアントに
  // offline_access を付与しても、その Refresh Token は unauthorized_client で拒否されるだけ
  // なので、認可の時点で offline_access を落とす。
  describe('offline_access gating by registered grant_types', () => {
    it('should drop offline_access when the client omits grant_types', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'consent' }),
        ['consent'],
        defaultClient,
      );

      expect(scope).toEqual(['openid']);
    });

    it('should drop offline_access when the client registers only authorization_code', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'consent' }),
        ['consent'],
        {
          clientId: 'client123',
          redirectUris: ['https://client.example.org/cb'],
          grantTypes: ['authorization_code'],
        },
      );

      expect(scope).toEqual(['openid']);
    });

    it('should retain offline_access when the client registers the refresh_token grant type', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'consent' }),
        ['consent'],
        refreshGrantClient,
      );

      expect(scope).toEqual(['openid', 'offline_access']);
    });

    it('should pass the resolved client to the custom callback', async () => {
      let receivedGrantTypes: string[] | undefined;

      await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'consent' }),
        ['consent'],
        refreshGrantClient,
        (_request, context) => {
          receivedGrantTypes = context.client.grantTypes;
          return false;
        },
      );

      expect(receivedGrantTypes).toEqual(['authorization_code', 'refresh_token']);
    });

    it('should let a custom callback grant offline_access to a client without the refresh_token grant type', async () => {
      const scope = await applyOfflineAccessPolicy(
        ['openid', 'offline_access'],
        validParams({ scope: 'openid offline_access', prompt: 'consent' }),
        ['consent'],
        defaultClient,
        () => true,
      );

      expect(scope).toEqual(['openid', 'offline_access']);
    });
  });
});

// OIDC Core 1.0 §3.1.2.1 defines display values as page/popup/touch/wap only.
describe('validateDisplayParameter', () => {
  it('should accept display=page', () => {
    const display = validateDisplayParameter(validParams({ display: 'page' }), REDIRECT_URI);

    expect(display).toBe('page');
  });

  it('should accept display=popup', () => {
    const display = validateDisplayParameter(validParams({ display: 'popup' }), REDIRECT_URI);

    expect(display).toBe('popup');
  });

  it('should accept display=touch', () => {
    const display = validateDisplayParameter(validParams({ display: 'touch' }), REDIRECT_URI);

    expect(display).toBe('touch');
  });

  it('should accept display=wap', () => {
    const display = validateDisplayParameter(validParams({ display: 'wap' }), REDIRECT_URI);

    expect(display).toBe('wap');
  });

  // An unrecognized value is a malformed request -> invalid_request (redirectable).
  it('should reject unknown display value with invalid_request', () => {
    const error = captureStepError(() =>
      validateDisplayParameter(validParams({ display: 'custom_display' }), REDIRECT_URI),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    expect(error?.errorDescription).toBe('Unsupported display value: custom_display');
  });

  it('should return a redirectable error with state for an unknown display value', () => {
    const params = validParams({ display: 'custom_display', state: 'display-state' });

    const error = captureStepError(() =>
      validateDisplayParameter(params, REDIRECT_URI, params.state),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.redirectable).toBe(true);
    expect(error?.state).toBe('display-state');
  });

  it('should leave display undefined when the parameter is omitted', () => {
    const display = validateDisplayParameter(validParams(), REDIRECT_URI);

    expect(display).toBeUndefined();
  });
});

describe('resolveMaxAge', () => {
  // OIDC Core 1.0 §3.1.2.1: max_age is a non-negative integer number of seconds.
  describe('max_age parameter', () => {
    it('should accept valid max_age', () => {
      const maxAge = resolveMaxAge(validParams({ max_age: '3600' }), defaultClient, REDIRECT_URI);

      expect(maxAge).toBe(3600);
    });

    it('should accept max_age=0', () => {
      const maxAge = resolveMaxAge(validParams({ max_age: '0' }), defaultClient, REDIRECT_URI);

      expect(maxAge).toBe(0);
    });

    it('should reject non-numeric max_age', () => {
      const error = captureStepError(() =>
        resolveMaxAge(validParams({ max_age: 'abc' }), defaultClient, REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('max_age must be a non-negative integer');
      expect(error?.redirectable).toBe(true);
    });

    it('should reject negative max_age', () => {
      const error = captureStepError(() =>
        resolveMaxAge(validParams({ max_age: '-1' }), defaultClient, REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('max_age must be a non-negative integer');
      expect(error?.redirectable).toBe(true);
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2 / Core 1.0 §3.1.2.1:
  // default_max_age is the OP-side default freshness used when the request
  // omits max_age. The max_age request parameter overrides this default.
  describe('default_max_age fallback (OIDC DCR 1.0 §2)', () => {
    const clientWithDefaultMaxAge: ClientInfo = {
      clientId: 'client123',
      redirectUris: ['https://client.example.org/cb'],
      defaultMaxAge: 600,
    };

    it('should fall back to client defaultMaxAge when max_age is absent', () => {
      const maxAge = resolveMaxAge(validParams(), clientWithDefaultMaxAge, REDIRECT_URI);

      expect(maxAge).toBe(600);
    });

    it('should prefer request max_age over client defaultMaxAge', () => {
      const maxAge = resolveMaxAge(
        validParams({ max_age: '120' }),
        clientWithDefaultMaxAge,
        REDIRECT_URI,
      );

      expect(maxAge).toBe(120);
    });

    it('should leave maxAge undefined when neither max_age nor defaultMaxAge is present', () => {
      const maxAge = resolveMaxAge(validParams(), defaultClient, REDIRECT_URI);

      expect(maxAge).toBeUndefined();
    });

    it('should fall back to defaultMaxAge of 0 when max_age is absent', () => {
      const maxAge = resolveMaxAge(
        validParams(),
        {
          clientId: 'client123',
          redirectUris: ['https://client.example.org/cb'],
          defaultMaxAge: 0,
        },
        REDIRECT_URI,
      );

      expect(maxAge).toBe(0);
    });

    // OIDC DCR 1.0 §2: default_max_age is a non-negative integer (seconds).
    // An invalid registered value is a server-side configuration error, not a
    // client request error, so it surfaces as a non-redirectable server_error
    // even though this step receives the resolved redirect_uri.
    it('should reject negative defaultMaxAge as a non-redirectable server error', () => {
      const error = captureStepError(() =>
        resolveMaxAge(
          validParams(),
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: -1,
          },
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
      expect(error?.errorDescription).toBe(
        'Registered default_max_age must be a non-negative integer',
      );
      expect(error?.redirectable).toBe(false);
    });

    it('should reject non-integer defaultMaxAge as a non-redirectable server error', () => {
      const error = captureStepError(() =>
        resolveMaxAge(
          validParams(),
          {
            clientId: 'client123',
            redirectUris: ['https://client.example.org/cb'],
            defaultMaxAge: 1.5,
          },
          REDIRECT_URI,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.ServerError);
      expect(error?.redirectable).toBe(false);
    });

    it('should prefer request max_age even when defaultMaxAge is invalid', () => {
      const maxAge = resolveMaxAge(
        validParams({ max_age: '120' }),
        {
          clientId: 'client123',
          redirectUris: ['https://client.example.org/cb'],
          defaultMaxAge: -1,
        },
        REDIRECT_URI,
      );

      // The request max_age overrides default_max_age, so the invalid
      // registered value is never consulted (OIDC Core 1.0 §3.1.2.1).
      expect(maxAge).toBe(120);
    });
  });
});

describe('parseAudienceParameter', () => {
  it('should accept audience as space-separated string', () => {
    const audience = parseAudienceParameter(validParams({ audience: 'https://api.example.com' }));

    expect(audience).toEqual(['https://api.example.com']);
  });

  it('should accept multiple audience values', () => {
    const audience = parseAudienceParameter(
      validParams({ audience: 'https://api.example.com https://other.example.com' }),
    );

    expect(audience).toEqual(['https://api.example.com', 'https://other.example.com']);
  });

  it('should return undefined audience when not provided', () => {
    const audience = parseAudienceParameter(validParams());

    expect(audience).toBeUndefined();
  });
});

describe('parseClaimsRequestParameter', () => {
  // OIDC Core 1.0 §5.5: the claims request parameter is a JSON object whose
  // userinfo / id_token members request individual claims.
  describe('claims request parameter', () => {
    it('should parse JSON claims with id_token and userinfo members', () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: { essential: true, values: ['1', '2'] } },
        userinfo: { email: null },
      });

      const claims = parseClaimsRequestParameter(
        validParams({ claims: claimsJson }),
        REDIRECT_URI,
      );

      expect(claims).toEqual({
        id_token: { acr: { essential: true, values: ['1', '2'] } },
        userinfo: { email: null },
      });
    });

    it('should ignore unknown top-level members in claims', () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: null },
        unknown_member: { foo: 'bar' },
      });

      const claims = parseClaimsRequestParameter(
        validParams({ claims: claimsJson }),
        REDIRECT_URI,
      );

      expect(claims).toEqual({ id_token: { acr: null } });
    });

    it('should ignore non-object entries inside claims members', () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: { essential: true }, bogus: 'not-an-object' },
      });

      const claims = parseClaimsRequestParameter(
        validParams({ claims: claimsJson }),
        REDIRECT_URI,
      );

      expect(claims).toEqual({ id_token: { acr: { essential: true } } });
    });

    it('should reject claims that is not a JSON object', () => {
      const error = captureStepError(() =>
        parseClaimsRequestParameter(validParams({ claims: 'not-json' }), REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('claims parameter must be a JSON object');
    });

    it('should leave claims undefined when parameter is omitted', () => {
      const claims = parseClaimsRequestParameter(validParams(), REDIRECT_URI);

      expect(claims).toBeUndefined();
    });
  });

  // OWASP API4:2023 Unrestricted Resource Consumption / RFC 9700 §2.5:
  // the authorization endpoint is unauthenticated, so the `claims` payload must
  // be size-capped BEFORE JSON.parse to avoid CPU/memory exhaustion (app-layer DoS).
  describe('claims parameter size limit (untrusted input hardening)', () => {
    it('should reject claims longer than the default maximum length with invalid_request', () => {
      const oversized = 'a'.repeat(DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH + 1);

      const error = captureStepError(() =>
        parseClaimsRequestParameter(validParams({ claims: oversized }), REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should return a redirectable error with state when claims exceeds the limit', () => {
      const oversized = 'a'.repeat(DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH + 1);
      const params = validParams({ claims: oversized, state: 'xyz-state' });

      const error = captureStepError(() =>
        parseClaimsRequestParameter(params, REDIRECT_URI, params.state),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.redirectable).toBe(true);
      expect(error?.redirectUri).toBe('https://client.example.org/cb');
      expect(error?.state).toBe('xyz-state');
    });

    it('should not echo the oversized claims value in the error description', () => {
      const oversized = 'z'.repeat(DEFAULT_MAX_CLAIMS_PARAMETER_LENGTH + 1);

      const error = captureStepError(() =>
        parseClaimsRequestParameter(validParams({ claims: oversized }), REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.errorDescription).toBe(
        'claims parameter exceeds the maximum allowed length',
      );
    });

    it('should reject oversized claims by size before attempting JSON.parse', () => {
      // A small custom limit makes a syntactically valid JSON payload exceed it,
      // proving the size guard fires regardless of JSON validity.
      const validButOversized = JSON.stringify({ id_token: { acr: null } });

      const error = captureStepError(() =>
        parseClaimsRequestParameter(
          validParams({ claims: validButOversized }),
          REDIRECT_URI,
          undefined,
          validButOversized.length - 1,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe(
        'claims parameter exceeds the maximum allowed length',
      );
    });

    it('should accept claims exactly at the configured limit', () => {
      const base = '{"id_token":{"acr":{"value":""}}}';
      const limit = 60;
      const padding = 'x'.repeat(limit - base.length);
      const atLimit = `{"id_token":{"acr":{"value":"${padding}"}}}`;
      expect(atLimit.length).toBe(limit);

      const claims = parseClaimsRequestParameter(
        validParams({ claims: atLimit }),
        REDIRECT_URI,
        undefined,
        limit,
      );

      expect(claims).toEqual({ id_token: { acr: { value: padding } } });
    });

    it('should reject claims one character over the configured limit', () => {
      const base = '{"id_token":{"acr":{"value":""}}}';
      const limit = 60;
      const padding = 'x'.repeat(limit - base.length + 1);
      const overLimit = `{"id_token":{"acr":{"value":"${padding}"}}}`;
      expect(overLimit.length).toBe(limit + 1);

      const error = captureStepError(() =>
        parseClaimsRequestParameter(
          validParams({ claims: overLimit }),
          REDIRECT_URI,
          undefined,
          limit,
        ),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
    });

    it('should still parse a typical small claims payload within the limit', () => {
      const claimsJson = JSON.stringify({
        id_token: { acr: { essential: true, values: ['1', '2'] } },
        userinfo: { email: null },
      });

      const claims = parseClaimsRequestParameter(
        validParams({ claims: claimsJson }),
        REDIRECT_URI,
      );

      expect(claims).toEqual({
        id_token: { acr: { essential: true, values: ['1', '2'] } },
        userinfo: { email: null },
      });
    });

    it('should still reject a JSON array within the limit', () => {
      const error = captureStepError(() =>
        parseClaimsRequestParameter(validParams({ claims: '[]' }), REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('claims parameter must be a JSON object');
    });

    it('should still reject JSON null within the limit', () => {
      const error = captureStepError(() =>
        parseClaimsRequestParameter(validParams({ claims: 'null' }), REDIRECT_URI),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error?.error).toBe(AuthorizationErrorCode.InvalidRequest);
      expect(error?.errorDescription).toBe('claims parameter must be a JSON object');
    });
  });
});
