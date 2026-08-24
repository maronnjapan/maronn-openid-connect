import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASIC_OP_TEST_PLAN,
  REQUEST_OBJECT_PUBLIC_JWK,
  REQUEST_OBJECT_PRIVATE_JWK,
  REQUEST_OBJECT_SIGNING_ALG,
  createBasicOpConformanceArtifacts,
  resolveSampleApp,
} from './create-basic-op-config.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

describe('createBasicOpConformanceArtifacts', () => {
  describe('OIDF Basic OP static client configuration', () => {
    it('should generate static clients matching the OIDF callback URI', () => {
      const artifacts = createBasicOpConformanceArtifacts({
        alias: 'maronn-basic-op',
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
      });

      assert.equal(BASIC_OP_TEST_PLAN, 'oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]');
      assert.deepEqual(artifacts.config, {
        alias: 'maronn-basic-op',
        description: 'maronn-openid-connect Basic OP certification check for the Hono Cloudflare sample',
        server: {
          discoveryUrl: 'https://op-tls:3443/.well-known/openid-configuration',
        },
        client: {
          client_id: 'oidf-basic-client',
          client_secret: 'oidf-basic-client-secret',
          scope: 'openid',
          // OIDC Core 1.0 §6.1 / RFC 9101: the suite holds the private key and
          // signs Request Objects with RS256 so the OP can verify them.
          jwks: { keys: [REQUEST_OBJECT_PRIVATE_JWK] },
          request_object_signing_alg: 'RS256',
        },
        client2: {
          client_id: 'oidf-basic-client-2',
          client_secret: 'oidf-basic-client-2-secret',
          scope: 'openid',
          jwks: { keys: [REQUEST_OBJECT_PRIVATE_JWK] },
          request_object_signing_alg: 'RS256',
        },
        client_secret_post: {
          client_id: 'oidf-post-client',
          client_secret: 'oidf-post-client-secret',
          scope: 'openid',
          jwks: { keys: [REQUEST_OBJECT_PRIVATE_JWK] },
          request_object_signing_alg: 'RS256',
        },
        browser: [
          {
            match: 'https://op-tls:3443/authorize*',
            tasks: [
              {
                task: 'Login',
                optional: true,
                match: 'https://op-tls:3443/login*',
                commands: [
                  ['text', 'name', 'username', 'testuser', 'optional'],
                  ['text', 'name', 'password', 'password', 'optional'],
                  ['click', 'css', 'button[type="submit"]'],
                ],
              },
              {
                task: 'Consent',
                optional: true,
                match: 'https://op-tls:3443/consent*',
                commands: [
                  ['click', 'css', 'button[name="action"][value="approve"]'],
                ],
              },
              {
                // Optional so manual-review / error-page modules
                // (ensure-registered-redirect-uri, prompt-login, max-age-1) are
                // not reported INTERRUPTED when the browser never reaches a suite
                // callback. See create-basic-op-config.mjs for the rationale.
                task: 'Verify Complete',
                optional: true,
                match: '*/test/*/callback*',
                commands: [
                  ['wait', 'id', 'submission_complete', 10],
                ],
              },
            ],
          },
        ],
      });
      assert.deepEqual(artifacts.clients, [
        {
          clientId: 'oidf-basic-client',
          clientSecret: 'oidf-basic-client-secret',
          redirectUris: [
            'https://conformance-nginx:8443/test/a/maronn-basic-op/callback',
            'https://conformance-nginx:8443/test/a/maronn-basic-op/callback?dummy1=lorem&dummy2=ipsum',
          ],
          clientType: 'confidential',
          grantTypes: ['authorization_code', 'refresh_token'],
          tokenEndpointAuthMethod: 'client_secret_basic',
          responseTypes: ['code'],
          // OIDC Core 1.0 §6.1 / RFC 9101: the OP trusts the public half so it can
          // verify Request Objects the suite signs with the private half.
          jwks: { keys: [REQUEST_OBJECT_PUBLIC_JWK] },
        },
        {
          clientId: 'oidf-basic-client-2',
          clientSecret: 'oidf-basic-client-2-secret',
          redirectUris: [
            'https://conformance-nginx:8443/test/a/maronn-basic-op/callback',
            'https://conformance-nginx:8443/test/a/maronn-basic-op/callback?dummy1=lorem&dummy2=ipsum',
          ],
          clientType: 'confidential',
          grantTypes: ['authorization_code', 'refresh_token'],
          tokenEndpointAuthMethod: 'client_secret_basic',
          responseTypes: ['code'],
          jwks: { keys: [REQUEST_OBJECT_PUBLIC_JWK] },
        },
        {
          clientId: 'oidf-post-client',
          clientSecret: 'oidf-post-client-secret',
          redirectUris: [
            'https://conformance-nginx:8443/test/a/maronn-basic-op/callback',
            'https://conformance-nginx:8443/test/a/maronn-basic-op/callback?dummy1=lorem&dummy2=ipsum',
          ],
          clientType: 'confidential',
          grantTypes: ['authorization_code', 'refresh_token'],
          tokenEndpointAuthMethod: 'client_secret_post',
          responseTypes: ['code'],
          jwks: { keys: [REQUEST_OBJECT_PUBLIC_JWK] },
        },
      ]);
    });

    it('should register a client JWKS for signed Request Object verification when provided', () => {
      // OIDC Core 1.0 §6.1: the suite signs Request Objects with its own key, so the
      // OP must trust that public JWKS via static client registration.
      const clientJwks = {
        keys: [
          {
            kty: 'RSA',
            use: 'sig',
            alg: 'RS256',
            kid: 'oidf-suite-key',
            n: 'sXch-modulus',
            e: 'AQAB',
          },
        ],
      };

      const artifacts = createBasicOpConformanceArtifacts({
        alias: 'maronn-basic-op',
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
        clientJwks,
      });

      assert.deepEqual(artifacts.clients[0].jwks, clientJwks);
      assert.deepEqual(artifacts.clients[1].jwks, clientJwks);
      assert.deepEqual(artifacts.clients[2].jwks, clientJwks);
    });

    it('should wire the default conformance Request Object key on both the OP and the suite', () => {
      // OIDC Core 1.0 §6.1 / RFC 9101: with no override, the OP trusts the public
      // half and the suite signs with the private half of the same keypair, so the
      // Basic OP Request Object modules run as a real automated test target.
      const artifacts = createBasicOpConformanceArtifacts({
        alias: 'maronn-basic-op',
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
      });

      // OP side trusts only the public half (no private material must leak here).
      for (const client of artifacts.clients) {
        assert.deepEqual(client.jwks, { keys: [REQUEST_OBJECT_PUBLIC_JWK] });
      }
      assert.equal('d' in REQUEST_OBJECT_PUBLIC_JWK, false);

      // Suite side holds the private half and is told to sign with RS256.
      for (const suiteClient of [
        artifacts.config.client,
        artifacts.config.client2,
        artifacts.config.client_secret_post,
      ]) {
        assert.deepEqual(suiteClient.jwks, { keys: [REQUEST_OBJECT_PRIVATE_JWK] });
        assert.equal(suiteClient.request_object_signing_alg, 'RS256');
      }
      assert.equal(REQUEST_OBJECT_PRIVATE_JWK.d.length > 0, true);

      // Both halves are the same keypair: identical kid and modulus.
      assert.equal(REQUEST_OBJECT_PUBLIC_JWK.kid, REQUEST_OBJECT_PRIVATE_JWK.kid);
      assert.equal(REQUEST_OBJECT_PUBLIC_JWK.n, REQUEST_OBJECT_PRIVATE_JWK.n);
      assert.equal(REQUEST_OBJECT_SIGNING_ALG, 'RS256');
    });

    it('should normalize base URLs before deriving discovery and callbacks', () => {
      const artifacts = createBasicOpConformanceArtifacts({
        alias: 'alias-with-trailing-slashes',
        opIssuer: 'https://op-tls:3443/',
        suiteBaseUrl: 'https://conformance-nginx:8443/',
        sampleApp: 'express-flyio',
      });

      assert.equal(artifacts.config.server.discoveryUrl, 'https://op-tls:3443/.well-known/openid-configuration');
      assert.deepEqual(artifacts.clients[0].redirectUris, [
        'https://conformance-nginx:8443/test/a/alias-with-trailing-slashes/callback',
        'https://conformance-nginx:8443/test/a/alias-with-trailing-slashes/callback?dummy1=lorem&dummy2=ipsum',
      ]);
      assert.equal(artifacts.config.description, 'maronn-openid-connect Basic OP certification check for the Express sample');
    });
  });
});

describe('Basic OP PKCE compatibility mode', () => {
  describe('sample OP startup environment', () => {
    it('should enable non-PKCE authorization code flow only for conformance runs', () => {
      const runScript = readFileSync(join(scriptDir, 'run-basic-op.sh'), 'utf8');
      const compose = readFileSync(join(scriptDir, '../docker-compose.yml'), 'utf8');

      assert.match(
        runScript,
        /export OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW="\$\{OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW:-1\}"/,
      );
      assert.match(
        compose,
        /OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW: \${OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW:-0}/,
      );
    });
  });
});

describe('resolveSampleApp', () => {
  describe('sample app selection', () => {
    it('should resolve supported sample app metadata', () => {
      assert.deepEqual(resolveSampleApp('fastify-flyio'), {
        name: 'fastify-flyio',
        displayName: 'Fastify',
        packageName: '@maronn-openid-connect/sample-fastify-flyio',
        defaultStartCommand: 'node samples/fastify-flyio/dist/server.js',
      });
    });

    it('should reject unsupported sample app names', () => {
      assert.throws(
        () => resolveSampleApp('not-a-sample'),
        {
          message: 'Unsupported CONFORMANCE_SAMPLE_APP "not-a-sample". Expected one of: hono-cloudflare, express-flyio, fastify-flyio, nextjs-vercel',
        },
      );
    });
  });
});
