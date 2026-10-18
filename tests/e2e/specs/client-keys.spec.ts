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

// Registered in playwright.config.ts with client_secret_post and no public keys.
const clientId = 'e2e-client-keys';
const clientSecret = 'e2e-client-keys-secret';
// Nothing listens on this path: the spec reads the code from the URL the
// browser lands on and redeems it itself.
const redirectUri = `${clientBaseURL}/client-keys-callback`;
const UNVERIFIABLE_REQUEST_OBJECT = {
  error: 'invalid_request_object',
  error_description: 'no JWKS registered to verify the request object signature',
};

/**
 * The OP keeps a client's public keys per purpose (client_jwks rows, or the
 * client_jwks:<client_id>:<purpose> records with --db kv) and reads the keys
 * of a purpose whenever a process needs them. The generated OP verifies signed
 * Request Objects (OIDC Core 1.0 §6.3.2) with the keys of request_object.
 *
 * This spec does what an operator would: it adds and removes the client's
 * public keys in the sample OP's database while the OP runs, and the very next
 * request uses them, without a restart.
 */
test.describe('client keys', () => {
  test.beforeEach(() => {
    openOpDatabase().reset();
  });

  test.afterEach(() => {
    openOpDatabase().reset();
  });

  test('should verify a signed Request Object with a key as soon as it is registered for request_object', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const key = await generateClientKey();
    const database = openOpDatabase();
    // A key registered for another purpose does not verify Request Objects.
    database.addKey(key.publicJwk, 'private_key_jwt');
    const { url, state, codeVerifier } = await signedRequestObjectUrl(key, issuer);

    const refused = await request.get(url, {
      maxRedirects: 0,
      headers: { Accept: 'application/json' },
    });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual(UNVERIFIABLE_REQUEST_OBJECT);

    // The operator registers the same key for request_object. Nothing restarts.
    database.addKey(key.publicJwk, 'request_object');

    // redirect_uri, state and code_challenge come from the Request Object
    // alone, so a code issued to that redirect_uri and redeemed with the
    // matching code_verifier shows the OP applied its claims.
    const callback = await completeAuthorization(page, url);
    expect(callback.searchParams.get('state')).toBe(state);
    const redeemed = await redeemCode(
      request,
      issuer,
      requireString(callback.searchParams.get('code'), 'code'),
      codeVerifier,
    );
    expect(redeemed.status()).toBe(200);
  });

  test('should stop verifying signed Request Objects with a key once it is removed', async ({
    page,
    request,
    baseURL,
  }) => {
    const issuer = requireBaseUrl(baseURL);
    const key = await generateClientKey();
    const database = openOpDatabase();
    database.addKey(key.publicJwk, 'request_object');

    // The Request Object is verified, so the OP asks the user to sign in.
    await page.goto((await signedRequestObjectUrl(key, issuer)).url);
    await expect(page).toHaveURL(/\/login$/);

    // The operator removes the key; the next request already misses it.
    database.removeKey(key.publicJwk.kid, 'request_object');
    const refused = await request.get((await signedRequestObjectUrl(key, issuer)).url, {
      maxRedirects: 0,
      headers: { Accept: 'application/json' },
    });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toEqual(UNVERIFIABLE_REQUEST_OBJECT);
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

/** Sign in and approve in the browser, and return the URL the OP redirected back to. */
async function completeAuthorization(page: Page, authorizationUrl: string): Promise<URL> {
  await page.goto(authorizationUrl);
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username:').fill('testuser');
  await page.getByLabel('Password:').fill('password');
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/consent$/);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForURL((url) => url.pathname === '/client-keys-callback');
  return new URL(page.url());
}

async function redeemCode(request: APIRequestContext, issuer: string, code: string, codeVerifier: string) {
  return request.post(`${issuer}/token`, {
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
}

/**
 * The client's public keys in the database of the sample OP under test,
 * changed from this process the way an operator changes them.
 */
interface OpDatabase {
  addKey(jwk: ClientKey['publicJwk'], purpose: KeyPurpose): void;
  removeKey(kid: string, purpose: KeyPurpose): void;
  /** Leave the client as playwright.config.ts registered it: without keys. */
  reset(): void;
}

/** The key purposes this spec registers keys for (ClientKeyPurpose in core). */
type KeyPurpose = 'private_key_jwt' | 'request_object';
const KEY_PURPOSES: KeyPurpose[] = ['private_key_jwt', 'request_object'];

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
      withSqlite(path, (sqlite) => sqlite.prepare('DELETE FROM client_jwks WHERE client_id = ?').run(clientId));
    },
  };
}

function kvDatabase(path: string): OpDatabase {
  // keys.ts: 'oidc:' and the URI-encoded parts, joined with ':'.
  const jwksKey = (purpose: KeyPurpose) =>
    `oidc:client_jwks:${encodeURIComponent(clientId)}:${encodeURIComponent(purpose)}`;
  const keysOf = (sqlite: DatabaseSync, purpose: KeyPurpose): Array<{ kid?: unknown }> => {
    const row = sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(jwksKey(purpose)) as
      | { value: string }
      | undefined;
    return row ? ((JSON.parse(row.value) as { keys: Array<{ kid?: unknown }> }).keys) : [];
  };
  const write = (sqlite: DatabaseSync, purpose: KeyPurpose, keys: unknown[]): void => {
    sqlite
      .prepare(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, NULL) ' +
          'ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = NULL',
      )
      .run(jwksKey(purpose), JSON.stringify({ keys }));
  };
  return {
    addKey(jwk, purpose) {
      withSqlite(path, (sqlite) => write(sqlite, purpose, [...keysOf(sqlite, purpose), jwk]));
    },
    removeKey(kid, purpose) {
      withSqlite(path, (sqlite) =>
        write(sqlite, purpose, keysOf(sqlite, purpose).filter((key) => key.kid !== kid)),
      );
    },
    reset() {
      withSqlite(path, (sqlite) => {
        for (const purpose of KEY_PURPOSES) {
          sqlite.prepare('DELETE FROM kv WHERE key = ?').run(jwksKey(purpose));
        }
      });
    },
  };
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
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
