import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER } from '../../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../../test-support/keys.js';
import { createApp, type OidcProviderOptions } from '../../../app.js';
import { createClientKeyResolver, createClientResolver } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import { createProviderStores } from '../../../db/memory/stores.js';
import { dynamicClientStore } from '../../dynamic-client-registration/store.js';
import { registerDpopClientMetadata } from './validate-dpop-client-metadata.js';

// The dynamically registered clients live in one store for the whole process
// (features/dynamic-client-registration/store.ts): every test reads the
// client of the client_id its registration was issued.

const REDIRECT_URI = 'https://rp.example.com/callback';
/** The metadata validate-metadata registers for a request of REDIRECT_URI alone, with its defaults. */
const REGISTERED_DEFAULTS = {
  redirect_uris: [REDIRECT_URI],
  token_endpoint_auth_method: 'client_secret_basic',
  grant_types: ['authorization_code'],
  response_types: ['code'],
  application_type: 'web',
  id_token_signed_response_alg: 'RS256',
};
const NOT_A_BOOLEAN = {
  error: 'invalid_client_metadata',
  error_description: 'dpop_bound_access_tokens must be a boolean',
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** The provider on a database of its own, with every feature, as an application mounts it. */
async function providerApp(options: Partial<Omit<OidcProviderOptions, 'config'>> = {}) {
  const db = createEmptyDatabase();
  return createApp({
    signingKeyProvider: staticKeyProvider(await rs256Key()),
    storage: createProviderStores(db),
    clientResolver: createClientResolver(db),
    clientKeyResolver: createClientKeyResolver(db),
    ...options,
    config: { issuer: TEST_ISSUER },
  });
}

/** POST /register with the metadata as JSON. */
function register(app: Awaited<ReturnType<typeof providerApp>>, metadata: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request(`${TEST_ISSUER}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(metadata),
  });
}

/** The status and the JSON body of a response. */
async function answerOf(response: Response): Promise<[number, Record<string, unknown>]> {
  return [response.status, (await response.json()) as Record<string, unknown>];
}

describe('registerDpopClientMetadata', () => {
  // RFC 9449 §5.2 / RFC 7591 §3.2.1: the registered value is stored with the client and returned.
  it('should register dpop_bound_access_tokens true, keep it with the stored client and return it in the 201 response', async () => {
    const app = await providerApp();

    const [status, body] = await answerOf(await register(app, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: true }));
    const stored = await dynamicClientStore.get(String(body['client_id']));

    expect(status).toBe(201);
    expect(body['dpop_bound_access_tokens']).toBe(true);
    expect(stored?.registrationMetadata).toEqual({ ...REGISTERED_DEFAULTS, dpop_bound_access_tokens: true });
  });

  // RFC 9449 §5.2: "If omitted, the default value is false"; the default is registered and returned
  // like the other defaults (OIDC Dynamic Client Registration 1.0 §3.2).
  it.each([
    ['omitted', {}],
    ['false', { dpop_bound_access_tokens: false }],
  ])('should register dpop_bound_access_tokens %s as false and return it', async (_name, member) => {
    const app = await providerApp();

    const [status, body] = await answerOf(await register(app, { redirect_uris: [REDIRECT_URI], ...member }));
    const stored = await dynamicClientStore.get(String(body['client_id']));

    expect(status).toBe(201);
    expect(body['dpop_bound_access_tokens']).toBe(false);
    expect(stored?.registrationMetadata).toEqual({ ...REGISTERED_DEFAULTS, dpop_bound_access_tokens: false });
  });

  // RFC 9449 §5.2: a boolean value; RFC 7591 §3.2.2: invalid_client_metadata for an invalid value.
  it.each([
    ['the string "true"', 'true'],
    ['a number', 1],
    ['null', null],
    ['an object', { value: true }],
  ])('should refuse dpop_bound_access_tokens that is %s with an uncacheable 400 invalid_client_metadata, and store nothing', async (_name, value) => {
    const app = await providerApp();
    const save = vi.spyOn(dynamicClientStore, 'save');

    const response = await register(app, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: value });

    expect(response.status).toBe(400);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-store', 'no-cache']);
    expect(await response.json()).toEqual(NOT_A_BOOLEAN);
    expect(save).not.toHaveBeenCalled();
  });

  // The block runs after the metadata is validated: an invalid redirect_uris is the answer.
  it('should answer the other metadata errors first', async () => {
    const app = await providerApp();

    const response = await register(app, { redirect_uris: [], dpop_bound_access_tokens: 'yes' });

    expect(await answerOf(response)).toEqual([
      400,
      { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array of strings' },
    ]);
  });

  // The block runs before the client is stored: a full inventory does not hide an invalid value (RFC 7591 §5 answers 429).
  it('should refuse an invalid dpop_bound_access_tokens before it checks the inventory cap', async () => {
    const app = await providerApp({ dynamicClientRegistration: { maxRegisteredClients: 0 } });

    const refused = await register(app, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: 'yes' });
    const full = await register(app, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: true });

    expect(await answerOf(refused)).toEqual([400, NOT_A_BOOLEAN]);
    expect(full.status).toBe(429);
  });

  // RFC 7591 §3.1.1: the metadata of a verified software statement wins over the plain values.
  it('should register the value of the software statement over the plain value', async () => {
    const app = await providerApp({
      dynamicClientRegistration: { verifySoftwareStatement: () => ({ metadata: { dpop_bound_access_tokens: true } }) },
    });

    const [status, body] = await answerOf(
      await register(app, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: false, software_statement: 'eyJhbGciOiJSUzI1NiJ9.e30.sig' }),
    );

    expect(status).toBe(201);
    expect(body['dpop_bound_access_tokens']).toBe(true);
  });

  // A customClientMetadata validator of the same name decides the value the block checks, here one that
  // makes every dynamically registered client a DPoP client.
  it('should check the value a customClientMetadata validator registered in place of the value of the request', async () => {
    const forcing = await providerApp({ dynamicClientRegistration: { customClientMetadata: { dpop_bound_access_tokens: () => true } } });
    const stringifying = await providerApp({
      dynamicClientRegistration: { customClientMetadata: { dpop_bound_access_tokens: (value) => String(value) } },
    });

    const [status, body] = await answerOf(await register(forcing, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: false }));
    const refused = await register(stringifying, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: true });

    expect(status).toBe(201);
    expect(body['dpop_bound_access_tokens']).toBe(true);
    expect(await answerOf(refused)).toEqual([400, NOT_A_BOOLEAN]);
  });

  // A validator that returns undefined registers nothing, so the block checks the value of the request:
  // with the validator `(value) => value`, an omitted value registers false (the default of RFC 9449 §5.2).
  it('should check the value of the request when the customClientMetadata validator registered nothing', async () => {
    const echoing = await providerApp({ dynamicClientRegistration: { customClientMetadata: { dpop_bound_access_tokens: (value) => value } } });
    const silent = await providerApp({ dynamicClientRegistration: { customClientMetadata: { dpop_bound_access_tokens: () => undefined } } });

    const [omittedStatus, omittedBody] = await answerOf(await register(echoing, { redirect_uris: [REDIRECT_URI] }));
    const omittedStored = await dynamicClientStore.get(String(omittedBody['client_id']));
    const [trueStatus, trueBody] = await answerOf(await register(silent, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: true }));
    const trueStored = await dynamicClientStore.get(String(trueBody['client_id']));

    expect(omittedStatus).toBe(201);
    expect(omittedBody['dpop_bound_access_tokens']).toBe(false);
    expect(omittedStored?.registrationMetadata).toEqual({ ...REGISTERED_DEFAULTS, dpop_bound_access_tokens: false });
    expect(trueStatus).toBe(201);
    expect(trueBody['dpop_bound_access_tokens']).toBe(true);
    expect(trueStored?.registrationMetadata).toEqual({ ...REGISTERED_DEFAULTS, dpop_bound_access_tokens: true });
  });

  // The refusal is built through the context, so the CORS middleware's headers stay on it.
  it('should keep the CORS headers on a refused dpop_bound_access_tokens', async () => {
    const app = await providerApp();

    const response = await register(app, { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: 'true' }, { Origin: 'https://rp.example.com' });

    expect(response.status).toBe(400);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('should return a new client with the value among its metadata, and leave the client and the metadata it is given unchanged', () => {
    const metadata = { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: true };
    const client = { clientId: 'dcr-1', metadata: { redirect_uris: [REDIRECT_URI] } };

    const registration = registerDpopClientMetadata(undefined, metadata, client);

    expect(registration).toEqual({
      dpopClient: { clientId: 'dcr-1', metadata: { redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: true } },
    });
    expect(client).toEqual({ clientId: 'dcr-1', metadata: { redirect_uris: [REDIRECT_URI] } });
    expect(metadata).toEqual({ redirect_uris: [REDIRECT_URI], dpop_bound_access_tokens: true });
  });
});
