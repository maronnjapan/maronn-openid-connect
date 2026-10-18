import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { es256Key } from '../../../../test-support/screens.js';
import { createProviderConfig } from '../../../config.js';
import { buildDiscoveryMetadata } from './build-metadata.js';

const ISSUER = 'https://op.example.com';

async function metadataFor(input: { userinfoSigningAlgValues?: string[] } = {}) {
  const c = contextOf(undefined, { config: createProviderConfig({ issuer: ISSUER }) });
  return buildDiscoveryMetadata(c, {
    idTokenSigningKeys: [(await rs256Key()).privateKey, (await es256Key()).privateKey],
    userinfoSigningAlgValues: input.userinfoSigningAlgValues ?? ['RS256'],
  });
}

describe('buildDiscoveryMetadata', () => {
  describe('Provider endpoints', () => {
    // OIDC Discovery 1.0 §3: every endpoint is built on the issuer.
    it('should build the endpoints of every provider on config.issuer', async () => {
      expect(await metadataFor()).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: 'https://op.example.com/authorize',
        token_endpoint: 'https://op.example.com/token',
        userinfo_endpoint: 'https://op.example.com/userinfo',
        jwks_uri: 'https://op.example.com/.well-known/jwks.json',
      });
    });

    it('should add the endpoints of the enabled features', async () => {
      expect(await metadataFor()).toMatchObject({
        introspection_endpoint: 'https://op.example.com/introspect',
        revocation_endpoint: 'https://op.example.com/revoke',
        pushed_authorization_request_endpoint: 'https://op.example.com/par',
        device_authorization_endpoint: 'https://op.example.com/device_authorization',
        backchannel_authentication_endpoint: 'https://op.example.com/backchannel_authentication',
        end_session_endpoint: 'https://op.example.com/logout',
        registration_endpoint: 'https://op.example.com/register',
      });
    });
  });

  describe('Supported values', () => {
    // OIDC Core 1.0 §15.1: derived from the ID Token keys, each algorithm once.
    it('should derive id_token_signing_alg_values_supported from the ID Token keys', async () => {
      expect((await metadataFor()).id_token_signing_alg_values_supported).toEqual(['RS256', 'ES256']);
    });

    it('should merge the grants of the features after authorization_code, each once', async () => {
      expect((await metadataFor()).grant_types_supported).toEqual([
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:token-exchange',
        'urn:ietf:params:oauth:grant-type:device_code',
        'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'urn:openid:params:grant-type:ciba',
      ]);
    });

    // OIDC Core 1.0 §11 (refresh-token feature) / JARM §4 (jarm feature).
    it('should merge the scopes and response modes the features advertise', async () => {
      const metadata = await metadataFor();

      expect(metadata.scopes_supported).toEqual(['openid', 'profile', 'email', 'address', 'phone', 'offline_access']);
      expect(metadata.response_modes_supported).toEqual(['query', 'query.jwt', 'jwt']);
    });

    // OIDC Core 1.0 §6.1: the request-object feature replaces request_parameter_supported: false.
    it('should let a feature replace a member that is not an array', async () => {
      expect(await metadataFor()).toMatchObject({
        request_parameter_supported: true,
        request_uri_parameter_supported: false,
        request_object_signing_alg_values_supported: ['RS256'],
      });
    });

    // RFC 7636 / OAuth 2.1 §4.1.1 and RFC 9207 §3.
    it('should advertise S256 and the iss authorization response parameter', async () => {
      expect(await metadataFor()).toMatchObject({
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        claims_parameter_supported: true,
        claim_types_supported: ['normal'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      });
    });

    // OIDC Discovery 1.0 §3: an empty array member is omitted.
    it('should omit userinfo_signing_alg_values_supported when no UserInfo key is registered', async () => {
      expect(await metadataFor({ userinfoSigningAlgValues: [] })).not.toHaveProperty(
        'userinfo_signing_alg_values_supported',
      );
    });
  });

  it('should reject an empty ID Token key set', () => {
    const c = contextOf(undefined, { config: createProviderConfig({ issuer: ISSUER }) });

    expect(() => buildDiscoveryMetadata(c, { idTokenSigningKeys: [], userinfoSigningAlgValues: [] })).toThrow(
      'idTokenSigningKeys must not be empty',
    );
  });
});
