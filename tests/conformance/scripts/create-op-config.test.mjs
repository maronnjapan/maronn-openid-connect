import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASIC_OP_TEST_PLAN,
  IMPLICIT_OP_TEST_PLAN,
  opTestPlan,
  REQUEST_OBJECT_PUBLIC_JWK,
  REQUEST_OBJECT_PRIVATE_JWK,
  REQUEST_OBJECT_SIGNING_ALG,
  createOpConformanceArtifacts,
  resolveProfile,
  resolveSampleApp,
} from './create-op-config.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// The browser automation the suite drives the OP's login and consent screens
// with. The Basic OP and the Implicit OP plans share it: the suite's callback
// page posts the fragment of an implicit response back to the suite, and shows
// submission_complete for the code flow and the Implicit Flow alike.
const EXPECTED_BROWSER_AUTOMATION = [
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
        // callback. The pattern starts at the suite's base URL: the
        // authorization request carries the callback URL in its query, so
        // */test/*/callback* also matched the OP's error page.
        // See create-op-config.mjs for the rationale.
        task: 'Verify Complete',
        optional: true,
        match: 'https://conformance-nginx:8443/test/*/callback*',
        commands: [
          ['wait', 'id', 'submission_complete', 10],
        ],
      },
    ],
  },
];

describe('createOpConformanceArtifacts', () => {
  describe('OIDF Basic OP static client configuration', () => {
    it('should generate static clients matching the OIDF callback URI', () => {
      const artifacts = createOpConformanceArtifacts({
        alias: 'maronn-basic-op',
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
      });

      assert.equal(BASIC_OP_TEST_PLAN, 'oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]');
      assert.equal(artifacts.profile.name, 'basic-op');
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
        browser: EXPECTED_BROWSER_AUTOMATION,
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
          tokenEndpointAuthMethods: ['client_secret_basic'],
          responseTypes: ['code'],
          // OIDC Core 1.0 §6.1 / RFC 9101: the OP trusts the public half so it can
          // verify Request Objects the suite signs with the private half.
          keys: { request_object: { keys: [REQUEST_OBJECT_PUBLIC_JWK] } },
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
          tokenEndpointAuthMethods: ['client_secret_basic'],
          responseTypes: ['code'],
          keys: { request_object: { keys: [REQUEST_OBJECT_PUBLIC_JWK] } },
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
          tokenEndpointAuthMethods: ['client_secret_post'],
          responseTypes: ['code'],
          keys: { request_object: { keys: [REQUEST_OBJECT_PUBLIC_JWK] } },
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

      const artifacts = createOpConformanceArtifacts({
        alias: 'maronn-basic-op',
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
        clientJwks,
      });

      assert.deepEqual(artifacts.clients[0].keys, { request_object: clientJwks });
      assert.deepEqual(artifacts.clients[1].keys, { request_object: clientJwks });
      assert.deepEqual(artifacts.clients[2].keys, { request_object: clientJwks });
    });

    it('should wire the default conformance Request Object key on both the OP and the suite', () => {
      // OIDC Core 1.0 §6.1 / RFC 9101: with no override, the OP trusts the public
      // half and the suite signs with the private half of the same keypair, so the
      // Basic OP Request Object modules run as a real automated test target.
      const artifacts = createOpConformanceArtifacts({
        alias: 'maronn-basic-op',
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
      });

      // OP side trusts only the public half (no private material must leak here).
      for (const client of artifacts.clients) {
        assert.deepEqual(client.keys, { request_object: { keys: [REQUEST_OBJECT_PUBLIC_JWK] } });
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
      const artifacts = createOpConformanceArtifacts({
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

    it('should use the Basic OP alias when no alias is given', () => {
      const artifacts = createOpConformanceArtifacts({ profile: 'basic-op' });

      assert.equal(artifacts.config.alias, 'maronn-basic-op');
    });
  });

  describe('OIDF Implicit OP static client configuration', () => {
    // OIDC Core 1.0 §3.2: the Implicit OP plan sends response_type=id_token and
    // id_token token. The OP answers them only for a client that registered
    // those response types (unauthorized_client otherwise), so the static
    // clients register both, with the implicit grant type they go with (OIDC
    // Dynamic Client Registration 1.0 §2). The plan uses no token endpoint, so
    // the suite needs no client_secret_post client.
    it('should generate Implicit Flow clients matching the OIDF callback URI', () => {
      const artifacts = createOpConformanceArtifacts({
        profile: 'implicit-op',
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
      });

      assert.equal(
        IMPLICIT_OP_TEST_PLAN,
        'oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]',
      );
      assert.equal(artifacts.profile.name, 'implicit-op');
      assert.deepEqual(artifacts.config, {
        alias: 'maronn-implicit-op',
        description: 'maronn-openid-connect Implicit OP certification check for the Hono Cloudflare sample',
        server: {
          discoveryUrl: 'https://op-tls:3443/.well-known/openid-configuration',
        },
        client: {
          client_id: 'oidf-implicit-client',
          client_secret: 'oidf-implicit-client-secret',
          scope: 'openid',
          jwks: { keys: [REQUEST_OBJECT_PRIVATE_JWK] },
          request_object_signing_alg: 'RS256',
        },
        client2: {
          client_id: 'oidf-implicit-client-2',
          client_secret: 'oidf-implicit-client-2-secret',
          scope: 'openid',
          jwks: { keys: [REQUEST_OBJECT_PRIVATE_JWK] },
          request_object_signing_alg: 'RS256',
        },
        browser: EXPECTED_BROWSER_AUTOMATION,
      });
      assert.deepEqual(artifacts.clients, [
        {
          clientId: 'oidf-implicit-client',
          clientSecret: 'oidf-implicit-client-secret',
          redirectUris: [
            'https://conformance-nginx:8443/test/a/maronn-implicit-op/callback',
            'https://conformance-nginx:8443/test/a/maronn-implicit-op/callback?dummy1=lorem&dummy2=ipsum',
          ],
          clientType: 'confidential',
          grantTypes: ['implicit'],
          tokenEndpointAuthMethods: ['client_secret_basic'],
          responseTypes: ['id_token', 'id_token token'],
          keys: { request_object: { keys: [REQUEST_OBJECT_PUBLIC_JWK] } },
        },
        {
          clientId: 'oidf-implicit-client-2',
          clientSecret: 'oidf-implicit-client-2-secret',
          redirectUris: [
            'https://conformance-nginx:8443/test/a/maronn-implicit-op/callback',
            'https://conformance-nginx:8443/test/a/maronn-implicit-op/callback?dummy1=lorem&dummy2=ipsum',
          ],
          clientType: 'confidential',
          grantTypes: ['implicit'],
          tokenEndpointAuthMethods: ['client_secret_basic'],
          responseTypes: ['id_token', 'id_token token'],
          keys: { request_object: { keys: [REQUEST_OBJECT_PUBLIC_JWK] } },
        },
      ]);
    });

    it('should name the sample app in the description of the Implicit OP plan', () => {
      const artifacts = createOpConformanceArtifacts({ profile: 'implicit-op', sampleApp: 'nextjs-vercel' });

      assert.equal(artifacts.config.description, 'maronn-openid-connect Implicit OP certification check for the Next.js sample');
    });
  });
});

describe('Basic OP PKCE compatibility mode', () => {
  describe('sample OP startup environment', () => {
    it('should enable non-PKCE authorization code flow only for conformance runs', () => {
      const runScript = readFileSync(join(scriptDir, 'run-op.sh'), 'utf8');
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

describe('Sample OP container', () => {
  describe('storage of the sample OP', () => {
    // The op service mounts the workspace read-only. express-flyio,
    // fastify-flyio and nextjs-vercel open their node:sqlite database at
    // OIDC_SQLITE_PATH (.data/oidc.sqlite under the working directory by
    // default), and an OP that cannot create it never answers Discovery.
    it('should keep the node:sqlite database of the sample OP in a writable directory', () => {
      const compose = readFileSync(join(scriptDir, '../docker-compose.yml'), 'utf8');

      assert.match(compose, /^ {6}OIDC_SQLITE_PATH: \/tmp\/maronn-openid-connect-sqlite\/oidc\.sqlite$/m);
      assert.match(compose, /^ {6}- \.\.\/\.\.:\/workspace:ro$/m);
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

describe('resolveProfile', () => {
  describe('certification profile selection', () => {
    it('should resolve the Basic OP profile by default', () => {
      const profile = resolveProfile();

      assert.equal(profile.name, 'basic-op');
      assert.equal(profile.displayName, 'Basic OP');
      assert.equal(profile.testPlan, BASIC_OP_TEST_PLAN);
    });

    it('should resolve the Implicit OP profile', () => {
      const profile = resolveProfile(' Implicit-OP ');

      assert.equal(profile.name, 'implicit-op');
      assert.equal(profile.displayName, 'Implicit OP');
      assert.equal(profile.testPlan, IMPLICIT_OP_TEST_PLAN);
    });

    it('should reject unsupported profile names', () => {
      assert.throws(
        () => resolveProfile('hybrid-op'),
        {
          message: 'Unsupported CONFORMANCE_PROFILE "hybrid-op". Expected one of: basic-op, implicit-op',
        },
      );
    });
  });
});

describe('opTestPlan', () => {
  describe('manual review modules', () => {
    it('should run every module of the Basic OP plan by default', () => {
      assert.equal(opTestPlan('basic-op'), BASIC_OP_TEST_PLAN);
    });

    // The three modules wait for a screenshot (manual review), which an
    // unattended run never uploads: the runner gives each of them 240 s.
    it('should select every Basic OP module but the manual review ones when they are skipped', () => {
      assert.equal(
        opTestPlan('basic-op', { skipManualReview: true }),
        'oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]:' +
          'oidcc-server,oidcc-response-type-missing,oidcc-idtoken-signature,oidcc-idtoken-unsigned,' +
          'oidcc-userinfo-get,oidcc-userinfo-post-header,oidcc-userinfo-post-body,' +
          'oidcc-ensure-request-without-nonce-succeeds-for-code-flow,oidcc-scope-profile,oidcc-scope-email,' +
          'oidcc-scope-address,oidcc-scope-phone,oidcc-scope-all,oidcc-alternate-happy-flow,' +
          'oidcc-display-page,oidcc-display-popup,oidcc-prompt-none-not-logged-in,oidcc-prompt-none-logged-in,' +
          'oidcc-max-age-10000,oidcc-ensure-request-with-unknown-parameter-succeeds,oidcc-id-token-hint,' +
          'oidcc-login-hint,oidcc-ui-locales,oidcc-claims-locales,oidcc-ensure-request-with-acr-values-succeeds,' +
          'oidcc-codereuse,oidcc-codereuse-30seconds,oidcc-ensure-post-request-succeeds,' +
          'oidcc-server-client-secret-post,oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported,' +
          'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported,oidcc-claims-essential,' +
          'oidcc-ensure-request-object-with-redirect-uri,oidcc-refresh-token,' +
          'oidcc-ensure-request-with-valid-pkce-succeeds',
      );
    });

    it('should run every module of the Implicit OP plan by default', () => {
      assert.equal(opTestPlan('implicit-op'), IMPLICIT_OP_TEST_PLAN);
    });

    // The Implicit OP plan runs most modules once with response_type=id_token
    // and once with id_token token, and run-test-plan.py runs a plan entry per
    // occurrence of its name, so the selection names those modules twice:
    // leaving out a manual review module saves twice the runner's 240 s. The
    // code flow modules of the Basic OP plan (code reuse, refresh token, PKCE,
    // the token endpoint) are not in it, and nonce is required (OIDC Core 1.0
    // §3.2.2.1).
    it('should select every Implicit OP module run but the manual review ones when they are skipped', () => {
      const perResponseType =
        'oidcc-server,oidcc-ensure-request-without-nonce-fails,oidcc-scope-profile,oidcc-scope-email,' +
        'oidcc-scope-address,oidcc-scope-phone,oidcc-scope-all,oidcc-alternate-happy-flow,' +
        'oidcc-display-page,oidcc-display-popup,oidcc-prompt-none-not-logged-in,oidcc-prompt-none-logged-in,' +
        'oidcc-max-age-10000,oidcc-ensure-request-with-unknown-parameter-succeeds,oidcc-id-token-hint,' +
        'oidcc-login-hint,oidcc-ui-locales,oidcc-claims-locales,oidcc-ensure-request-with-acr-values-succeeds,' +
        'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported,' +
        'oidcc-ensure-request-object-with-redirect-uri,oidcc-claims-essential';

      assert.equal(
        opTestPlan('implicit-op', { skipManualReview: true }),
        'oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]:' +
          // response_type=id_token
          `${perResponseType},` +
          // response_type=id_token token
          `${perResponseType},` +
          'oidcc-userinfo-get,oidcc-userinfo-post-header,oidcc-userinfo-post-body,oidcc-response-type-missing',
      );
    });

    it('should put the plan of the run into the artifacts', () => {
      const artifacts = createOpConformanceArtifacts({ profile: 'implicit-op', skipManualReview: true });

      assert.equal(artifacts.testPlan, opTestPlan('implicit-op', { skipManualReview: true }));
    });
  });
});
