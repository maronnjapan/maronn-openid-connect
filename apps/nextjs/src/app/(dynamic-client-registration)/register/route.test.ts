import { ClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context';
import { publisherKey, signSoftwareStatement, TEST_PUBLISHER } from '../../../test-support/software-statement';
import {
  dynamicClientRegistrationConfig,
  type DynamicClientRegistrationConfig,
} from '../../_oidc-provider/features/dynamic-client-registration/config';
import { POST, registrableGrantTypes, registrableScopes } from './route';

const REDIRECT_URIS = ['https://rp.example.com/callback'];
const defaults: DynamicClientRegistrationConfig = { ...dynamicClientRegistrationConfig };

// dynamicClientRegistrationConfig is a shared() object: every test puts the
// settings it changed back.
afterEach(() => {
  Object.assign(dynamicClientRegistrationConfig, defaults);
});

function configure(overrides: Partial<DynamicClientRegistrationConfig>): void {
  Object.assign(dynamicClientRegistrationConfig, overrides);
}

function register(metadata: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request(`${TEST_ISSUER}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(metadata),
    }),
  );
}

describe('POST /register', () => {
  // RFC 7591 §3.1 / §3.2.1: the registration answer, with the RFC 7591 §2 and
  // OIDC Dynamic Client Registration 1.0 §2 defaults applied and returned (§3.2).
  it('should register a client and answer 201 with the issued values and the registered metadata', async () => {
    const response = await register({ redirect_uris: REDIRECT_URIS, client_name: 'Example RP', scope: 'openid profile' });

    expect(response.status).toBe(201);
    expect([response.headers.get('Cache-Control'), response.headers.get('Pragma')]).toEqual(['no-store', 'no-cache']);
    expect(await response.json()).toEqual({
      client_id: expect.stringMatching(/^dcr-[A-Za-z0-9_-]{22}$/),
      client_secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      client_secret_expires_at: 0,
      client_id_issued_at: expect.any(Number),
      redirect_uris: REDIRECT_URIS,
      token_endpoint_auth_method: 'client_secret_basic',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      application_type: 'web',
      client_name: 'Example RP',
      scope: 'openid profile',
      id_token_signed_response_alg: 'RS256',
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2: application_type defaults to web,
  // and a web client using the implicit grant may register only https
  // redirect_uris, so the omitted type is checked against the loopback URI.
  it('should refuse a loopback redirect_uri for an implicit client that omits application_type', async () => {
    const response = await register({
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['implicit'],
      response_types: ['id_token'],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'a web client using the implicit grant must register https redirect_uris that do not use localhost',
    });
  });

  // OIDC Dynamic Client Registration 1.0 §2: the response types the provider answers (implicit-flow / hybrid-flow) are registrable.
  it('should register an implicit client for the response types this provider answers', async () => {
    const response = await register({
      redirect_uris: REDIRECT_URIS,
      token_endpoint_auth_method: 'none',
      grant_types: ['implicit'],
      response_types: ['token id_token'],
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ grant_types: ['implicit'], response_types: ['id_token token'] });
  });

  it('should bound the signed response algs to the algs of the provider signing keys', async () => {
    const accepted = await register({ redirect_uris: REDIRECT_URIS, id_token_signed_response_alg: 'RS256' });
    const refused = await register({ redirect_uris: REDIRECT_URIS, id_token_signed_response_alg: 'ES256' });

    expect(accepted.status).toBe(201);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'id_token_signed_response_alg must be one of RS256',
    });
  });

  // OIDC Dynamic Client Registration 1.0 §3 / RFC 6750 §3.1: the two 401 shapes.
  it('should refuse a registration without the configured initial access token', async () => {
    configure({ initialAccessToken: 'iat-secret' });

    const missing = await register({ redirect_uris: REDIRECT_URIS });
    const wrong = await register({ redirect_uris: REDIRECT_URIS }, { Authorization: 'Bearer wrong' });
    const accepted = await register({ redirect_uris: REDIRECT_URIS }, { Authorization: 'Bearer iat-secret' });

    expect([missing.status, missing.headers.get('WWW-Authenticate')]).toEqual([401, 'Bearer']);
    expect([wrong.status, wrong.headers.get('WWW-Authenticate')]).toEqual([401, 'Bearer error="invalid_token"']);
    expect(accepted.status).toBe(201);
  });

  it('should let a verifyInitialAccessToken of the config decide who may register', async () => {
    configure({ verifyInitialAccessToken: async (authorization) => authorization === 'Bearer custom-ticket' });

    const refused = await register({ redirect_uris: REDIRECT_URIS }, { Authorization: 'Bearer other' });
    const accepted = await register({ redirect_uris: REDIRECT_URIS }, { Authorization: 'Bearer custom-ticket' });

    expect([refused.status, refused.headers.get('WWW-Authenticate')]).toEqual([401, 'Bearer error="invalid_token"']);
    expect(accepted.status).toBe(201);
  });

  // RFC 7591 §3.1.1 / §3.2.1: the metadata of a trusted software statement wins
  // over the plain values, and the statement comes back unmodified.
  it('should apply the metadata of a trusted software statement and return the statement', async () => {
    const publisher = await publisherKey();
    configure({ trustedSoftwarePublishers: [{ issuer: TEST_PUBLISHER, jwks: publisher.jwks }] });
    const statement = await signSoftwareStatement({ client_name: 'Published App', software_id: 'sw-1' }, publisher.signingKey);

    const response = await register({ redirect_uris: REDIRECT_URIS, client_name: 'Plain Name', software_statement: statement });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ client_name: 'Published App', software_id: 'sw-1', software_statement: statement });
  });

  // RFC 7591 §3.2.2: the two software statement error codes.
  it('should answer unapproved_software_statement for an unknown publisher and invalid_software_statement for a broken statement', async () => {
    const publisher = await publisherKey();

    const unapproved = await register({
      redirect_uris: REDIRECT_URIS,
      software_statement: await signSoftwareStatement({ client_name: 'Published App' }, publisher.signingKey),
    });
    const invalid = await register({ redirect_uris: REDIRECT_URIS, software_statement: 'not-a-jwt' });

    expect(unapproved.status).toBe(400);
    expect(await unapproved.json()).toEqual({
      error: 'unapproved_software_statement',
      error_description: 'the issuer of the software_statement is not approved by this authorization server',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: 'invalid_software_statement',
      error_description: 'software_statement must be a JWS compact serialization',
    });
  });

  it('should register and echo the custom metadata of the config, and ignore unknown metadata', async () => {
    configure({
      customClientMetadata: {
        tenant_id: (value) => {
          if (typeof value !== 'string') {
            throw new ClientRegistrationError('invalid_client_metadata', 'tenant_id must be a string');
          }
          return value;
        },
      },
    });

    const accepted = await register({ redirect_uris: REDIRECT_URIS, tenant_id: 'acme', unknown_field: 1 });
    const refused = await register({ redirect_uris: REDIRECT_URIS, tenant_id: 1 });

    const body = (await accepted.json()) as Record<string, unknown>;
    expect(accepted.status).toBe(201);
    expect(body['tenant_id']).toBe('acme');
    expect(Object.hasOwn(body, 'unknown_field')).toBe(false);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid_client_metadata', error_description: 'tenant_id must be a string' });
  });

  // RFC 7591 §3.1: application/json only.
  it('should reject a body of another media type with invalid_client_metadata', async () => {
    const response = await register({ redirect_uris: REDIRECT_URIS }, { 'Content-Type': 'text/plain' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'registration requests must use application/json',
    });
  });

  // RFC 7591 §5: the inventory cap answers 429 with a fixed body.
  it('should answer 429 once the inventory reaches the cap', async () => {
    configure({ maxRegisteredClients: 0 });

    const response = await register({ redirect_uris: REDIRECT_URIS });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'too_many_registrations', error_description: 'registration limit reached' });
  });
});

describe('registrableGrantTypes', () => {
  // The provider answers authorization_code, the token grants of its features
  // and, while a feature answers an implicit response type, implicit.
  it('should keep the configured grants this provider answers, in the configured order', () => {
    expect(
      registrableGrantTypes(
        ['implicit', 'authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'password'],
        ['code', 'id_token'],
      ),
    ).toEqual(['implicit', 'authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']);
  });

  it('should leave implicit out while no response type returns a token or an id_token', () => {
    expect(registrableGrantTypes(['authorization_code', 'implicit'], ['code'])).toEqual(['authorization_code']);
  });
});

describe('registrableScopes', () => {
  // scopes.ts declares no custom scope in apps/nextjs, so any value registers.
  it('should return undefined while no custom scope is declared', () => {
    expect(registrableScopes()).toBeUndefined();
  });
});
