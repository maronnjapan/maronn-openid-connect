import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? '3020');
const clientBaseURL =
  process.env.E2E_CLIENT_BASE_URL ?? `http://${host}:${clientPort}`;
const opPackage =
  process.env.E2E_OP_PACKAGE ?? '@maronn-openid-connect/sample-hono-cloudflare';

// Registered in playwright.config.ts with client_secret_post only, like a
// client that existed before it moved to private_key_jwt.
const clientId = 'e2e-private-key-jwt';
const clientSecret = 'e2e-private-key-jwt-secret';
// Nothing listens on this path: the spec reads the code from the URL the
// browser lands on and redeems it itself.
const redirectUri = `${clientBaseURL}/private-key-jwt-callback`;
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * OIDC Core 1.0 §9: with private_key_jwt the client signs a JWT with its own
 * private key and sends it as client_assertion; the OP verifies it with the
 * public keys the client registered for that purpose.
 *
 * The generated OP reads a client's methods (client_auths) from its database
 * on every request, and its keys one purpose at a time (client_jwks rows, or
 * the client_jwks:<client_id>:<purpose> records with --db kv) whenever a
 * process needs them. This spec does what an operator would: it adds the
 * method and the public keys to the sample OP's database while the OP runs,
 * and the very next request uses them, without a restart.
 */
test.describe('private_key_jwt', () => {
  test.beforeEach(() => {
    resetClientRegistration();
  });

  test.afterEach(() => {
    resetClientRegistration();
  });

  // RFC 8414 §2: the JWS algs are listed whenever private_key_jwt is.
  test('should advertise private_key_jwt and the algorithms of its assertion in discovery', async ({
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);

    const response = await request.get(`${issuer}/.well-known/openid-configuration`);
    expect(response.status()).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;

    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      'client_secret_basic',
      'client_secret_post',
      'private_key_jwt',
      'none',
    ]);
    expect(metadata.token_endpoint_auth_signing_alg_values_supported).toEqual([
      'RS256',
      'RS384',
      'RS512',
      'ES256',
      'ES384',
      'ES512',
    ]);
  });

  test('should accept private_key_jwt as soon as the method and the key are added to the database', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const key = await generateClientKey();
    const { code, codeVerifier } = await authorize(page, issuer);

    // The client is registered with client_secret_post only, so a client
    // assertion is a method it may not use.
    const refused = await redeemCode(request, issuer, code, codeVerifier, {
      client_assertion_type: JWT_BEARER,
      client_assertion: await signClientAssertion(key, `${issuer}/token`),
    });
    expect(refused.status()).toBe(401);
    expect(await refused.json()).toEqual({
      error: 'invalid_client',
      error_description:
        'Client authentication method does not match the registered token_endpoint_auth_method',
    });

    // The operator lets the client use private_key_jwt and stores its public
    // key. Nothing restarts.
    const database = openOpDatabase();
    database.allowPrivateKeyJwt();
    database.addKey(key.publicJwk, 'private_key_jwt');

    // Client authentication runs before the code is checked, so the refused
    // request left the code unused and the same code is redeemed now.
    const accepted = await redeemCode(request, issuer, code, codeVerifier, {
      client_assertion_type: JWT_BEARER,
      client_assertion: await signClientAssertion(key, `${issuer}/token`),
    });
    expect(accepted.status()).toBe(200);
    const tokens = (await accepted.json()) as Record<string, unknown>;
    expect(tokens.token_type).toBe('Bearer');
    expect(parseJwtPayload(requireString(tokens.id_token, 'id_token')).aud).toBe(clientId);
  });

  test('should refuse a replayed assertion and stop accepting a key once it is removed from the database', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const key = await generateClientKey();
    const database = openOpDatabase();
    database.allowPrivateKeyJwt();
    database.addKey(key.publicJwk, 'private_key_jwt');
    const { code, codeVerifier } = await authorize(page, issuer);

    const firstAssertion = await signClientAssertion(key, `${issuer}/token`);
    const redeemed = await redeemCode(request, issuer, code, codeVerifier, {
      client_assertion_type: JWT_BEARER,
      client_assertion: firstAssertion,
    });
    expect(redeemed.status()).toBe(200);
    let refreshToken = requireString(
      ((await redeemed.json()) as Record<string, unknown>).refresh_token,
      'refresh_token',
    );

    // OIDC Core 1.0 §9: a client assertion MUST only be used once.
    const replayed = await refresh(request, issuer, refreshToken, {
      client_assertion_type: JWT_BEARER,
      client_assertion: firstAssertion,
    });
    expect(replayed.status()).toBe(401);
    expect(await replayed.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Client assertion has already been used',
    });

    // draft-ietf-oauth-rfc7523bis: the issuer identifier as the audience is
    // accepted next to the token endpoint URL of OIDC Core 1.0 §9.
    const refreshed = await refresh(request, issuer, refreshToken, {
      client_assertion_type: JWT_BEARER,
      client_assertion: await signClientAssertion(key, issuer),
    });
    expect(refreshed.status()).toBe(200);
    refreshToken = requireString(
      ((await refreshed.json()) as Record<string, unknown>).refresh_token,
      'refresh_token',
    );

    // The operator removes the key; the next request already misses it.
    database.removeKey(key.publicJwk.kid, 'private_key_jwt');
    const withoutKey = await refresh(request, issuer, refreshToken, {
      client_assertion_type: JWT_BEARER,
      client_assertion: await signClientAssertion(key, `${issuer}/token`),
    });
    expect(withoutKey.status()).toBe(401);
    expect(await withoutKey.json()).toEqual({
      error: 'invalid_client',
      error_description: 'The client has no registered keys for private_key_jwt',
    });

    // The client keeps client_secret_post next to private_key_jwt.
    const withSecret = await refresh(request, issuer, refreshToken, {
      client_id: clientId,
      client_secret: clientSecret,
    });
    expect(withSecret.status()).toBe(200);
  });

  test('should not verify a client assertion with a key registered only for another purpose', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const key = await generateClientKey();
    const database = openOpDatabase();
    database.allowPrivateKeyJwt();
    database.addKey(key.publicJwk, 'request_object');
    const { code, codeVerifier } = await authorize(page, issuer);

    const refused = await redeemCode(request, issuer, code, codeVerifier, {
      client_assertion_type: JWT_BEARER,
      client_assertion: await signClientAssertion(key, `${issuer}/token`),
    });
    expect(refused.status()).toBe(401);
    expect(await refused.json()).toEqual({
      error: 'invalid_client',
      error_description: 'The client has no registered keys for private_key_jwt',
    });

    // The same key registered for private_key_jwt too authenticates the client.
    database.addKey(key.publicJwk, 'private_key_jwt');
    const accepted = await redeemCode(request, issuer, code, codeVerifier, {
      client_assertion_type: JWT_BEARER,
      client_assertion: await signClientAssertion(key, `${issuer}/token`),
    });
    expect(accepted.status()).toBe(200);
  });
});

/**
 * OIDC Core 1.0 §6.3.2: the OP verifies a signed Request Object with the keys
 * the client registered for the request_object purpose, read from the same
 * client_jwks as the private_key_jwt keys.
 */
test.describe('signed Request Object keys', () => {
  test.beforeEach(() => {
    resetClientRegistration();
  });

  test.afterEach(() => {
    resetClientRegistration();
  });

  test('should verify a signed Request Object with the keys registered for request_object', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const key = await generateClientKey();
    const database = openOpDatabase();
    // A key registered for private_key_jwt does not verify Request Objects.
    database.addKey(key.publicJwk, 'private_key_jwt');
    const { url, state, codeVerifier } = await signedRequestObjectUrl(key, issuer);

    const refused = await request.get(url, {
      maxRedirects: 0,
      headers: { Accept: 'application/json' },
    });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_request_object',
      error_description: 'no JWKS registered to verify the request object signature',
    });

    // redirect_uri, state and code_challenge come from the Request Object
    // alone, so a code issued to that redirect_uri and redeemed with the
    // matching code_verifier shows the OP applied its claims.
    database.addKey(key.publicJwk, 'request_object');
    const callback = await completeAuthorization(page, url);
    expect(callback.searchParams.get('state')).toBe(state);
    const redeemed = await redeemCode(
      request,
      issuer,
      requireString(callback.searchParams.get('code'), 'code'),
      codeVerifier,
      { client_id: clientId, client_secret: clientSecret },
    );
    expect(redeemed.status()).toBe(200);
  });
});

interface ClientKey {
  privateKey: CryptoKey;
  publicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string };
}

/** An RS256 key pair of the client. The kid is new for every test, so runs never collide. */
async function generateClientKey(): Promise<ClientKey> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const exported = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicJwk: {
      kty: 'RSA',
      n: requireString(exported.n, 'n'),
      e: requireString(exported.e, 'e'),
      kid: `e2e-${randomUUID()}`,
      alg: 'RS256',
      use: 'sig',
    },
  };
}

/** OIDC Core 1.0 §9: iss and sub are the client_id, aud the OP, and jti is new each time. */
async function signClientAssertion(key: ClientKey, audience: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(key, { alg: 'RS256', typ: 'JWT', kid: key.publicJwk.kid }, {
    iss: clientId,
    sub: clientId,
    aud: audience,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  });
}

/** A compact JWS signed with the client's RS256 key. */
async function signJwt(
  key: ClientKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

/** Run the authorization code flow in the browser and read the code from the redirect. */
async function authorize(page: Page, issuer: string): Promise<{ code: string; codeVerifier: string }> {
  const codeVerifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const authorizationUrl = new URL('/authorize', issuer);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid',
    state,
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();

  const callback = await completeAuthorization(page, authorizationUrl.toString());
  expect(callback.searchParams.get('state')).toBe(state);
  return { code: requireString(callback.searchParams.get('code'), 'code'), codeVerifier };
}

/** Sign in and approve in the browser, and return the URL the OP redirected back to. */
async function completeAuthorization(page: Page, authorizationUrl: string): Promise<URL> {
  await page.goto(authorizationUrl);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent$/);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForURL((url) => url.pathname === '/private-key-jwt-callback');
  return new URL(page.url());
}

/**
 * An authorization request whose parameters are in a Request Object signed with
 * key (OIDC Core 1.0 §6.1). The query keeps only what §6.1 requires there:
 * response_type, client_id and scope.
 */
async function signedRequestObjectUrl(
  key: ClientKey,
  issuer: string,
): Promise<{ url: string; state: string; codeVerifier: string }> {
  const now = Math.floor(Date.now() / 1000);
  const state = randomBytes(16).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const requestObject = await signJwt(key, { alg: 'RS256', typ: 'oauth-authz-req+jwt', kid: key.publicJwk.kid }, {
    iss: clientId,
    aud: issuer,
    iat: now,
    exp: now + 300,
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid',
    state,
    nonce: randomBytes(16).toString('base64url'),
    code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  const url = new URL('/authorize', issuer);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'openid',
    request: requestObject,
  }).toString();
  return { url: url.toString(), state, codeVerifier };
}

async function redeemCode(
  request: APIRequestContext,
  issuer: string,
  code: string,
  codeVerifier: string,
  clientAuthentication: Record<string, string>,
) {
  return request.post(`${issuer}/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      ...clientAuthentication,
    },
  });
}

async function refresh(
  request: APIRequestContext,
  issuer: string,
  refreshToken: string,
  clientAuthentication: Record<string, string>,
) {
  return request.post(`${issuer}/token`, {
    form: { grant_type: 'refresh_token', refresh_token: refreshToken, ...clientAuthentication },
  });
}

/**
 * The client's private_key_jwt method and keys in the database of the sample
 * OP under test, changed from this process the way an operator changes them.
 */
interface OpDatabase {
  allowPrivateKeyJwt(): void;
  addKey(jwk: ClientKey['publicJwk'], purpose: KeyPurpose): void;
  removeKey(kid: string, purpose: KeyPurpose): void;
  reset(): void;
}

/** The key purposes this spec registers keys for (ClientKeyPurpose in core). */
type KeyPurpose = 'private_key_jwt' | 'request_object';
const KEY_PURPOSES: KeyPurpose[] = ['private_key_jwt', 'request_object'];

/** Leave the client as playwright.config.ts registered it: client_secret_post and no keys. */
function resetClientRegistration(): void {
  openOpDatabase().reset();
}

function openOpDatabase(): OpDatabase {
  const sampleDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../samples',
    opPackage.replace('@maronn-openid-connect/sample-', ''),
  );
  // --db kv (Next.js sample): one key-value table; --db sql (the others): the
  // tables of schema.sql, in node:sqlite or in the local D1 of wrangler dev.
  if (opPackage.endsWith('-nextjs-vercel')) {
    return kvDatabase(resolve(sampleDir, process.env.OIDC_SQLITE_PATH ?? '.data/oidc.sqlite'));
  }
  if (opPackage.endsWith('-hono-cloudflare')) {
    return sqlDatabase(localD1File(resolve(sampleDir, process.env.OIDC_D1_PERSIST_PATH ?? '.wrangler/state')));
  }
  return sqlDatabase(resolve(sampleDir, process.env.OIDC_SQLITE_PATH ?? '.data/oidc.sqlite'));
}

/** wrangler dev keeps a D1 database in one SQLite file under --persist-to. */
function localD1File(persistTo: string): string {
  const directory = join(persistTo, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const [file] = readdirSync(directory).filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
  return join(directory, requireString(file, 'the local D1 database file'));
}

/** Run statements on the database file, waiting while the OP holds its lock. */
function withSqlite<T>(path: string, run: (sqlite: DatabaseSync) => T): T {
  const sqlite = new DatabaseSync(path);
  try {
    sqlite.exec('PRAGMA busy_timeout = 5000');
    return run(sqlite);
  } finally {
    sqlite.close();
  }
}

function sqlDatabase(path: string): OpDatabase {
  return {
    allowPrivateKeyJwt() {
      withSqlite(path, (sqlite) =>
        sqlite
          .prepare(
            "INSERT INTO client_auths (id, client_id, client_auth_type) VALUES (?, ?, 'private_key_jwt') " +
              'ON CONFLICT (id) DO NOTHING',
          )
          .run(`${clientId}:private_key_jwt`, clientId),
      );
    },
    addKey(jwk, purpose) {
      withSqlite(path, (sqlite) =>
        sqlite
          .prepare('INSERT INTO client_jwks (id, client_id, purpose, jwk) VALUES (?, ?, ?, ?)')
          .run(`${clientId}:${purpose}:${jwk.kid}`, clientId, purpose, JSON.stringify(jwk)),
      );
    },
    removeKey(kid, purpose) {
      withSqlite(path, (sqlite) =>
        sqlite.prepare('DELETE FROM client_jwks WHERE id = ?').run(`${clientId}:${purpose}:${kid}`),
      );
    },
    reset() {
      withSqlite(path, (sqlite) => {
        sqlite.prepare('DELETE FROM client_jwks WHERE client_id = ?').run(clientId);
        sqlite
          .prepare("DELETE FROM client_auths WHERE client_id = ? AND client_auth_type = 'private_key_jwt'")
          .run(clientId);
      });
    },
  };
}

function kvDatabase(path: string): OpDatabase {
  // keys.ts: 'oidc:' and the URI-encoded parts, joined with ':'.
  const clientKey = `oidc:client:${encodeURIComponent(clientId)}`;
  const jwksKey = (purpose: KeyPurpose) =>
    `oidc:client_jwks:${encodeURIComponent(clientId)}:${encodeURIComponent(purpose)}`;
  const read = (sqlite: DatabaseSync, key: string): Record<string, unknown> | undefined => {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Record<string, unknown>) : undefined;
  };
  const write = (sqlite: DatabaseSync, key: string, value: unknown): void => {
    sqlite
      .prepare(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, NULL) ' +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = NULL',
      )
      .run(key, JSON.stringify(value));
  };
  const keysOf = (sqlite: DatabaseSync, purpose: KeyPurpose): Array<{ kid?: unknown }> =>
    ((read(sqlite, jwksKey(purpose))?.keys ?? []) as Array<{ kid?: unknown }>);
  return {
    allowPrivateKeyJwt() {
      withSqlite(path, (sqlite) => {
        const client = read(sqlite, clientKey);
        write(sqlite, clientKey, { ...requireRecord(client, clientKey), private_key_jwt: true });
      });
    },
    addKey(jwk, purpose) {
      withSqlite(path, (sqlite) =>
        write(sqlite, jwksKey(purpose), { keys: [...keysOf(sqlite, purpose), jwk] }),
      );
    },
    removeKey(kid, purpose) {
      withSqlite(path, (sqlite) =>
        write(sqlite, jwksKey(purpose), { keys: keysOf(sqlite, purpose).filter((key) => key.kid !== kid) }),
      );
    },
    reset() {
      withSqlite(path, (sqlite) => {
        for (const purpose of KEY_PURPOSES) {
          sqlite.prepare('DELETE FROM kv WHERE key = ?').run(jwksKey(purpose));
        }
        const { private_key_jwt: _, ...client } = requireRecord(read(sqlite, clientKey), clientKey);
        write(sqlite, clientKey, client);
      });
    },
  };
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('JWT must have three compact serialization segments');
  }
  return JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function requireBaseUrl(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL is required');
  }
  return baseURL;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireRecord(value: Record<string, unknown> | undefined, label: string): Record<string, unknown> {
  if (value === undefined) {
    throw new Error(`${label} is not in the key-value store`);
  }
  return value;
}
