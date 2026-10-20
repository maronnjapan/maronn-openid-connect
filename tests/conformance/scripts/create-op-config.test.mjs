import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  resolveSampleApp,
  writeOpConformanceArtifacts,
} from './create-op-config.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

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
                // callback. See create-op-config.mjs for the rationale.
                task: 'Verify Complete',
                optional: true,
                match: 'https://conformance-nginx:8443/test/*/callback*',
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

    // The authorization request carries the callback in its redirect_uri
    // query parameter, so a pattern that is not anchored to the suite also
    // matches the URL of the OP: on the error page of
    // oidcc-ensure-registered-redirect-uri the browser would wait for a
    // submission that never comes, and the module would be INTERRUPTED instead
    // of waiting for its screenshot.
    it('should look for the end of the flow on the callback of the suite only', () => {
      const artifacts = createOpConformanceArtifacts({
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443/',
      });

      const [automation] = artifacts.config.browser;
      assert.deepEqual(
        automation.tasks.map(({ task, match }) => [task, match]),
        [
          ['Login', 'https://op-tls:3443/login*'],
          ['Consent', 'https://op-tls:3443/consent*'],
          ['Verify Complete', 'https://conformance-nginx:8443/test/*/callback*'],
        ],
      );
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
  });

  describe('OIDF Implicit OP static client configuration', () => {
    it('should register a public client for both response types of the Implicit Flow', () => {
      // OIDC Core 1.0 §3.2: the plan runs its modules with response_type=id_token
      // and with id_token token, so the client registers both, and the implicit
      // grant type that pairs with them (OIDC Dynamic Client Registration 1.0 §2).
      // It never calls the token endpoint: a browser-based (public) client.
      const artifacts = createOpConformanceArtifacts({
        plan: 'implicit',
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
      });

      assert.deepEqual(artifacts.clients, [
        {
          clientId: 'oidf-implicit-client',
          redirectUris: [
            'https://conformance-nginx:8443/test/a/maronn-implicit-op/callback',
            'https://conformance-nginx:8443/test/a/maronn-implicit-op/callback?dummy1=lorem&dummy2=ipsum',
          ],
          clientType: 'public',
          grantTypes: ['implicit'],
          tokenEndpointAuthMethods: ['none'],
          responseTypes: ['id_token', 'id_token token'],
          keys: { request_object: { keys: [REQUEST_OBJECT_PUBLIC_JWK] } },
        },
      ]);
    });

    it('should configure the one suite client of the plan without a client secret', () => {
      // The Implicit OP plan only uses `client` (no module of it has a second
      // client or client_secret_post), and the public client has no secret.
      const options = {
        opIssuer: 'https://op-tls:3443',
        suiteBaseUrl: 'https://conformance-nginx:8443',
        sampleApp: 'hono-cloudflare',
      };
      const artifacts = createOpConformanceArtifacts({ ...options, plan: 'implicit' });
      const basicArtifacts = createOpConformanceArtifacts({ ...options, plan: 'basic' });

      assert.deepEqual(artifacts.config, {
        alias: 'maronn-implicit-op',
        description: 'maronn-openid-connect Implicit OP certification check for the Hono Cloudflare sample',
        server: {
          discoveryUrl: 'https://op-tls:3443/.well-known/openid-configuration',
        },
        client: {
          client_id: 'oidf-implicit-client',
          scope: 'openid',
          // OIDC Core 1.0 §6.1 / RFC 9101: the Request Object modules of the plan
          // sign with the same key as those of the Basic OP plan.
          jwks: { keys: [REQUEST_OBJECT_PRIVATE_JWK] },
          request_object_signing_alg: 'RS256',
        },
        // The same login and consent screens answer both plans.
        browser: basicArtifacts.config.browser,
      });
    });

    it('should reject a plan the conformance runs do not configure', () => {
      assert.throws(
        () => createOpConformanceArtifacts({ plan: 'hybrid' }),
        {
          message: 'Unsupported CONFORMANCE_PLAN "hybrid". Expected one of: basic, implicit',
        },
      );
    });
  });
});

describe('writeOpConformanceArtifacts', () => {
  describe('generated files', () => {
    it('should write the suite configuration of the plan under the name of the plan', async () => {
      const outDir = await mkdtemp(join(tmpdir(), 'maronn-conformance-'));
      try {
        const written = await writeOpConformanceArtifacts({ plan: 'implicit', outDir });

        assert.equal(written.paths.configPath, join(outDir, 'implicit-op-config.json'));
        assert.deepEqual(JSON.parse(await readFile(written.paths.configPath, 'utf8')), written.config);
        assert.deepEqual(JSON.parse(await readFile(join(outDir, 'oidc-clients.json'), 'utf8')), written.clients);
        assert.equal(await readFile(join(outDir, 'test-plan.txt'), 'utf8'), `${IMPLICIT_OP_TEST_PLAN}\n`);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    });
  });
});

describe('run-op.sh', () => {
  describe('sample OP startup environment', () => {
    // The Basic OP plan has modules of the authorization code flow without
    // PKCE (README); the Implicit OP plan issues no authorization code.
    it('should enable non-PKCE authorization code flow only for the Basic OP plan', () => {
      const runScript = readFileSync(join(scriptDir, 'run-op.sh'), 'utf8');
      const compose = readFileSync(join(scriptDir, '../docker-compose.yml'), 'utf8');

      assert.match(runScript, /\n  basic\)\n(?:    #.*\n)*    DEFAULT_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=1\n/);
      assert.match(runScript, /\n  implicit\)\n(?:    #.*\n)*    DEFAULT_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=0\n/);
      assert.match(
        runScript,
        /export OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW="\$\{OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW:-\$\{DEFAULT_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW\}\}"/,
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

describe('opTestPlan', () => {
  describe('Basic OP plan', () => {
    it('should run every module of the plan by default', () => {
      assert.equal(opTestPlan(), BASIC_OP_TEST_PLAN);
    });

    // The three modules wait for a screenshot (manual review), which an
    // unattended run never uploads: the runner gives each of them 240 s.
    it('should select every module but the manual review ones when they are skipped', () => {
      assert.equal(
        opTestPlan({ skipManualReview: true }),
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

    it('should put the plan of the run into the artifacts', () => {
      const artifacts = createOpConformanceArtifacts({ skipManualReview: true });

      assert.equal(artifacts.testPlan, opTestPlan({ skipManualReview: true }));
    });
  });

  describe('Implicit OP plan', () => {
    it('should run every module of the plan when the manual review ones are kept', () => {
      assert.equal(IMPLICIT_OP_TEST_PLAN, 'oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]');
      assert.equal(opTestPlan({ plan: 'implicit' }), IMPLICIT_OP_TEST_PLAN);
    });

    // run-test-plan.py takes one module of the plan for each time the selection
    // names it, so a module the plan runs with id_token and with id_token token
    // is named twice.
    it('should select each automated module once for each response type it runs with when the manual review ones are skipped', () => {
      const perResponseType =
        'oidcc-server,oidcc-idtoken-signature,oidcc-ensure-request-without-nonce-fails,' +
        'oidcc-scope-profile,oidcc-scope-email,oidcc-scope-address,oidcc-scope-phone,oidcc-scope-all,' +
        'oidcc-alternate-happy-flow,oidcc-display-page,oidcc-display-popup,' +
        'oidcc-prompt-none-not-logged-in,oidcc-prompt-none-logged-in,oidcc-max-age-10000,' +
        'oidcc-ensure-request-with-unknown-parameter-succeeds,oidcc-id-token-hint,oidcc-login-hint,' +
        'oidcc-ui-locales,oidcc-claims-locales,oidcc-ensure-request-with-acr-values-succeeds,' +
        'oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported,' +
        'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported,' +
        'oidcc-ensure-request-object-with-redirect-uri,oidcc-claims-essential';

      assert.equal(
        opTestPlan({ plan: 'implicit', skipManualReview: true }),
        'oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]:' +
          `${perResponseType},${perResponseType},` +
          'oidcc-userinfo-get,oidcc-userinfo-post-header,oidcc-userinfo-post-body,oidcc-response-type-missing',
      );
    });

    it('should put the plan of the run into the artifacts', () => {
      const artifacts = createOpConformanceArtifacts({ plan: 'implicit', skipManualReview: true });

      assert.equal(artifacts.testPlan, opTestPlan({ plan: 'implicit', skipManualReview: true }));
    });
  });
});
