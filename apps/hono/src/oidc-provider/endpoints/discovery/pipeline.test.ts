import { describe, expect, it } from 'vitest';
import { requestTo } from '../../../test-support/context.js';
import { rs256Key, staticKeyProvider } from '../../../test-support/keys.js';
import { es256Key, providerApp } from '../../../test-support/screens.js';
import { createEmptyDatabase } from '../../db/memory/database.js';

const DISCOVERY_PATH = '/.well-known/openid-configuration';

describe('discoveryApp', () => {
  // OIDC Discovery 1.0 §4.2 / RFC 8414 §3.2: a 200 JSON document; RFC 9111 §5.2: cacheable.
  it('should answer 200 with the metadata as JSON cacheable for 3600 seconds', async () => {
    const app = await providerApp(createEmptyDatabase());

    const response = await app.request(requestTo(DISCOVERY_PATH));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  // OIDC Discovery 1.0 §3: the members of every provider, then those of the enabled features.
  it('should answer the metadata of the provider and its enabled features on the configured issuer', async () => {
    const app = await providerApp(createEmptyDatabase());

    const response = await app.request(requestTo(DISCOVERY_PATH));

    expect(await response.json()).toEqual({
      issuer: 'https://op.example.com',
      authorization_endpoint: 'https://op.example.com/authorize',
      token_endpoint: 'https://op.example.com/token',
      jwks_uri: 'https://op.example.com/.well-known/jwks.json',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      userinfo_endpoint: 'https://op.example.com/userinfo',
      scopes_supported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],
      claims_supported: [
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'acr',
        'amr',
        'azp',
        'at_hash',
        'name',
        'family_name',
        'given_name',
        'middle_name',
        'nickname',
        'preferred_username',
        'profile',
        'picture',
        'website',
        'gender',
        'birthdate',
        'zoneinfo',
        'locale',
        'updated_at',
        'email',
        'email_verified',
        'address',
        'phone_number',
        'phone_number_verified',
      ],
      claim_types_supported: ['normal'],
      userinfo_signing_alg_values_supported: ['RS256'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
        'urn:ietf:params:oauth:grant-type:device_code',
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'urn:openid:params:grant-type:ciba',
      ],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      response_modes_supported: ['query', 'form_post', 'query.jwt', 'jwt'],
      claims_parameter_supported: true,
      request_parameter_supported: true,
      request_uri_parameter_supported: false,
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ['S256'],
      introspection_endpoint: 'https://op.example.com/introspect',
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint: 'https://op.example.com/revoke',
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      request_object_signing_alg_values_supported: ['RS256'],
      pushed_authorization_request_endpoint: 'https://op.example.com/par',
      authorization_signing_alg_values_supported: ['RS256'],
      device_authorization_endpoint: 'https://op.example.com/device_authorization',
      identity_chaining_requested_token_types_supported: ['urn:ietf:params:oauth:token-type:id-jag'],
      authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
      backchannel_token_delivery_modes_supported: ['poll'],
      backchannel_authentication_endpoint: 'https://op.example.com/backchannel_authentication',
      introspection_signing_alg_values_supported: ['RS256'],
      end_session_endpoint: 'https://op.example.com/logout',
      registration_endpoint: 'https://op.example.com/register',
    });
  });

  // OIDC Discovery 1.0 §3: issuer and every endpoint follow config.issuer, not the request URL.
  it('should build the issuer and every endpoint on another configured issuer', async () => {
    const app = await providerApp(createEmptyDatabase(), { config: { issuer: 'http://localhost:4000' } });

    const response = await app.request(requestTo(DISCOVERY_PATH));

    expect(await response.json()).toMatchObject({
      issuer: 'http://localhost:4000',
      authorization_endpoint: 'http://localhost:4000/authorize',
      token_endpoint: 'http://localhost:4000/token',
      userinfo_endpoint: 'http://localhost:4000/userinfo',
      jwks_uri: 'http://localhost:4000/.well-known/jwks.json',
      introspection_endpoint: 'http://localhost:4000/introspect',
      revocation_endpoint: 'http://localhost:4000/revoke',
      pushed_authorization_request_endpoint: 'http://localhost:4000/par',
      device_authorization_endpoint: 'http://localhost:4000/device_authorization',
      backchannel_authentication_endpoint: 'http://localhost:4000/backchannel_authentication',
      end_session_endpoint: 'http://localhost:4000/logout',
      registration_endpoint: 'http://localhost:4000/register',
    });
  });

  // OIDC Core 1.0 §15.1 (ID Token) and §5.3.2 (UserInfo): the algorithms of the registered key sets.
  it('should advertise the algorithms of the registered ID Token and UserInfo key sets', async () => {
    const app = await providerApp(createEmptyDatabase(), {
      idTokenSigningKeyProvider: staticKeyProvider(await rs256Key(), await es256Key()),
      userinfoSigningKeyProvider: staticKeyProvider(await es256Key()),
    });

    const response = await app.request(requestTo(DISCOVERY_PATH));

    expect(await response.json()).toMatchObject({
      id_token_signing_alg_values_supported: ['RS256', 'ES256'],
      userinfo_signing_alg_values_supported: ['ES256'],
    });
  });
});
