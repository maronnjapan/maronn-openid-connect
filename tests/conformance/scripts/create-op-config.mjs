import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASIC_OP_TEST_PLAN =
  'oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]';

// OIDC Core 1.0 §3.2: the Implicit OP plan. The suite runs each of its modules
// twice, with response_type=id_token and with id_token token (the variants of
// the plan itself, so the plan name selects only the server metadata and the
// client registration).
export const IMPLICIT_OP_TEST_PLAN =
  'oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]';

/**
 * The modules of the Basic OP plan, in its order (OIDCCBasicTestPlan of the
 * conformance suite). A run names them only to leave the manual review ones
 * out; the suite ignores a name its plan does not have.
 */
const BASIC_OP_MODULES = [
  'oidcc-server',
  'oidcc-response-type-missing',
  'oidcc-idtoken-signature',
  'oidcc-idtoken-unsigned',
  'oidcc-userinfo-get',
  'oidcc-userinfo-post-header',
  'oidcc-userinfo-post-body',
  'oidcc-ensure-request-without-nonce-succeeds-for-code-flow',
  'oidcc-scope-profile',
  'oidcc-scope-email',
  'oidcc-scope-address',
  'oidcc-scope-phone',
  'oidcc-scope-all',
  'oidcc-alternate-happy-flow',
  'oidcc-display-page',
  'oidcc-display-popup',
  'oidcc-prompt-login',
  'oidcc-prompt-none-not-logged-in',
  'oidcc-prompt-none-logged-in',
  'oidcc-max-age-1',
  'oidcc-max-age-10000',
  'oidcc-ensure-request-with-unknown-parameter-succeeds',
  'oidcc-id-token-hint',
  'oidcc-login-hint',
  'oidcc-ui-locales',
  'oidcc-claims-locales',
  'oidcc-ensure-request-with-acr-values-succeeds',
  'oidcc-codereuse',
  'oidcc-codereuse-30seconds',
  'oidcc-ensure-registered-redirect-uri',
  'oidcc-ensure-post-request-succeeds',
  'oidcc-server-client-secret-post',
  'oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported',
  'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported',
  'oidcc-claims-essential',
  'oidcc-ensure-request-object-with-redirect-uri',
  'oidcc-refresh-token',
  'oidcc-ensure-request-with-valid-pkce-succeeds',
];

/**
 * The modules the Implicit OP plan (OIDCCImplicitTestPlan of the conformance
 * suite) runs for each of its response types, in its order. The modules of the
 * code flow are not in it (code reuse, the refresh token, PKCE, the token
 * endpoint), and a request without nonce must fail instead of succeeding (OIDC
 * Core 1.0 §3.2.2.1).
 */
const IMPLICIT_OP_MODULES_PER_RESPONSE_TYPE = [
  'oidcc-server',
  'oidcc-ensure-request-without-nonce-fails',
  'oidcc-scope-profile',
  'oidcc-scope-email',
  'oidcc-scope-address',
  'oidcc-scope-phone',
  'oidcc-scope-all',
  'oidcc-alternate-happy-flow',
  'oidcc-display-page',
  'oidcc-display-popup',
  'oidcc-prompt-login',
  'oidcc-prompt-none-not-logged-in',
  'oidcc-prompt-none-logged-in',
  'oidcc-max-age-1',
  'oidcc-max-age-10000',
  'oidcc-ensure-request-with-unknown-parameter-succeeds',
  'oidcc-id-token-hint',
  'oidcc-login-hint',
  'oidcc-ui-locales',
  'oidcc-claims-locales',
  'oidcc-ensure-request-with-acr-values-succeeds',
  'oidcc-ensure-registered-redirect-uri',
  'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported',
  'oidcc-ensure-request-object-with-redirect-uri',
  'oidcc-claims-essential',
];

/**
 * The module runs of the Implicit OP plan, one name per run, in its order: the
 * modules above with response_type=id_token, again with id_token token, then
 * the ones it runs only with id_token token (the UserInfo endpoint needs the
 * access token, and response_type-missing needs one run).
 *
 * run-test-plan.py runs a plan entry once per occurrence of its name in the
 * selection: a name listed once runs only its first entry (the id_token one),
 * so a module of both response types is named twice.
 */
const IMPLICIT_OP_MODULES = [
  ...IMPLICIT_OP_MODULES_PER_RESPONSE_TYPE,
  ...IMPLICIT_OP_MODULES_PER_RESPONSE_TYPE,
  'oidcc-userinfo-get',
  'oidcc-userinfo-post-header',
  'oidcc-userinfo-post-body',
  'oidcc-response-type-missing',
];

/**
 * The modules that wait for a screenshot (manual review; see the README). An
 * unattended run never uploads one, and run-test-plan.py waits 240 s for each
 * before it gives up. Both plans have them; the Implicit OP plan runs each of
 * them once per response_type.
 */
export const MANUAL_REVIEW_MODULES = [
  'oidcc-prompt-login',
  'oidcc-max-age-1',
  'oidcc-ensure-registered-redirect-uri',
];

/**
 * The certification profiles a run can check (OpenID Connect Conformance
 * Profiles v3.0), each with its OIDF test plan and the static clients the plan
 * needs.
 *
 * - basic-op: the Authorization Code Flow (response_type=code). The suite also
 *   authenticates at the token endpoint with client_secret_post, so it has a
 *   third client for that.
 * - implicit-op: the Implicit Flow (response_type=id_token and id_token token,
 *   OIDC Core 1.0 §3.2). The OP answers those response types only for a client
 *   that registered them, so the clients register both, with the implicit grant
 *   type they go with (OIDC Dynamic Client Registration 1.0 §2). The plan uses
 *   no token endpoint.
 */
const PROFILES = new Map([
  [
    'basic-op',
    {
      name: 'basic-op',
      displayName: 'Basic OP',
      testPlan: BASIC_OP_TEST_PLAN,
      modules: BASIC_OP_MODULES,
      defaultAlias: 'maronn-basic-op',
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      clients: [
        { suiteKey: 'client', clientId: 'oidf-basic-client', tokenEndpointAuthMethod: 'client_secret_basic' },
        { suiteKey: 'client2', clientId: 'oidf-basic-client-2', tokenEndpointAuthMethod: 'client_secret_basic' },
        { suiteKey: 'client_secret_post', clientId: 'oidf-post-client', tokenEndpointAuthMethod: 'client_secret_post' },
      ],
    },
  ],
  [
    'implicit-op',
    {
      name: 'implicit-op',
      displayName: 'Implicit OP',
      testPlan: IMPLICIT_OP_TEST_PLAN,
      modules: IMPLICIT_OP_MODULES,
      defaultAlias: 'maronn-implicit-op',
      grantTypes: ['implicit'],
      responseTypes: ['id_token', 'id_token token'],
      clients: [
        { suiteKey: 'client', clientId: 'oidf-implicit-client', tokenEndpointAuthMethod: 'client_secret_basic' },
        { suiteKey: 'client2', clientId: 'oidf-implicit-client-2', tokenEndpointAuthMethod: 'client_secret_basic' },
      ],
    },
  ],
]);

export function resolveProfile(profile = 'basic-op') {
  const normalized = String(profile).trim().toLowerCase();
  const metadata = PROFILES.get(normalized);
  if (!metadata) {
    throw new Error(
      `Unsupported CONFORMANCE_PROFILE "${profile}". Expected one of: ${[...PROFILES.keys()].join(', ')}`,
    );
  }
  return metadata;
}

/**
 * The test plan argument of run-test-plan.py: the whole plan of the profile,
 * or, with skipManualReview, its modules without the manual review ones
 * (`<plan>:<module>,<module>`).
 */
export function opTestPlan(profile, { skipManualReview = false } = {}) {
  const { testPlan, modules } = resolveProfile(profile);
  if (!skipManualReview) return testPlan;
  const automated = modules.filter((module) => !MANUAL_REVIEW_MODULES.includes(module));
  return `${testPlan}:${automated.join(',')}`;
}

const DEFAULT_OP_ISSUER = 'https://op-tls:3443';
const DEFAULT_SUITE_BASE_URL = 'https://conformance-nginx:8443';
const DEFAULT_OUT_DIR = fileURLToPath(new URL('../.generated', import.meta.url));

// OIDC Core 1.0 §6.1 / RFC 9101 (JAR): a fixed RS256 keypair so the Request
// Object modules of the Basic OP and Implicit OP plans become a real automated
// test target rather than a manual-review / skipped path.
//
// The OIDF Conformance Suite signs the Request Object with the PRIVATE half
// (registered on the suite-side static client config below) and the sample OP
// verifies the signature against the PUBLIC half (registered on the OP-side
// `oidc-clients.json`). Both halves must come from the same keypair, so they are
// pinned here as a single coherent unit.
//
// This key is throwaway and scoped to the local/CI Docker conformance run only.
// It is NOT a production secret: it only lets the suite drive the OP's request
// object verification path during certification checks.
export const REQUEST_OBJECT_SIGNING_ALG = 'RS256';
const REQUEST_OBJECT_KEY_ID = 'maronn-conformance-request-object-key';

export const REQUEST_OBJECT_PUBLIC_JWK = {
  kty: 'RSA',
  n: '38qX6StSWz5Bsi3_UzQMRQ62VBLLLBvdGdrChEbBO2pJ6z45dy-ZVqDurhvj7OlCEhvX_a3HZdzJp5B-3LmffrfH3mfSlqEHSoFwhlNP58wdUI4T_ZEIQditasMDKjkMxnbFsMdMRzDJ5qUhfnM2QkGluQ6FGLbkD5zaUVb9yBOI_7kpvAqtCeABoe1nDW-dFic0hs7LO0AseTYdjzWnSWD7no7q6CQtjc6Se65EXZ8NXexIPmedEH2zNKMj203LViL63WWfxJKTBMyom1zgziT2Sa5v6en7YY0GR_28lD6zKocWP5LUxRf87XB_mxr82KsDY2qoo3UVs__RdPT4MQ',
  e: 'AQAB',
  alg: REQUEST_OBJECT_SIGNING_ALG,
  use: 'sig',
  kid: REQUEST_OBJECT_KEY_ID,
};

export const REQUEST_OBJECT_PRIVATE_JWK = {
  kty: 'RSA',
  n: '38qX6StSWz5Bsi3_UzQMRQ62VBLLLBvdGdrChEbBO2pJ6z45dy-ZVqDurhvj7OlCEhvX_a3HZdzJp5B-3LmffrfH3mfSlqEHSoFwhlNP58wdUI4T_ZEIQditasMDKjkMxnbFsMdMRzDJ5qUhfnM2QkGluQ6FGLbkD5zaUVb9yBOI_7kpvAqtCeABoe1nDW-dFic0hs7LO0AseTYdjzWnSWD7no7q6CQtjc6Se65EXZ8NXexIPmedEH2zNKMj203LViL63WWfxJKTBMyom1zgziT2Sa5v6en7YY0GR_28lD6zKocWP5LUxRf87XB_mxr82KsDY2qoo3UVs__RdPT4MQ',
  e: 'AQAB',
  d: 'CNvt51O5FQZaBq4SOFacQTwXvOyJCTgZqLk7n82mvt3Caxr5nqWeW_rvM-qD-3gQ7uNWCbNwTDChNX5PfVimTxeCpKPmxuJ9RcZpwFGKPV57zxluwmgUQ_oKRGqPpKNhRXaEdS7wjrVoWrZxBN7V-Cm94B1qaKvty43tqRBo57uGSluGeKZMJfXpuHKBGMnwEEeGXdqmgTJm7NRn14Rm2sjUkn4QJ3auYwVCbONZNdtGMQg5_h5jKXqF1Qqe-5kDnyQrY2BDg3oOTCRSL9bMZKrNZc_0wKsTOEKB6JxEUqcsiwkbCG84SoWvYfTWSzsfApIH8uYSJNNPeQJdikr3GQ',
  p: '8dVOnJc3ikvxuUGt7ES58BdOy6gMeze-x_vY6Yyw_eYcaDYu6SCC-q1rt6_ZrewyNEalA7TkXurKiudeQQbTSTWuKClwEmEaVnQ-KVjbMKjEeL-7w5yL1s1LjRQIi2CKe5TertmvwwaFWdNGNZvnlSiTjqWJYvLS2clktJn8Y1k',
  q: '7Oa3-pHMEDorPvqHYnslz1Aew0sHTOIswRw_X8FRvuSTWE54yNqg57cv7m4pKsfds-wBUSh9biQm8lH8RWv4PFLTbME9m7jXZNdxZH2gcH3effJo7bx0sFgKpJJC7hYQlQ759uE-KT4AaP5K4F7y2QjCaJlq6EeWGseH1EbPWJk',
  dp: 'bWyNM4Gg2ezfJWo4nk3CrIZ_WtthOmfQ5YBpd9P3SgtTEzxhIY9adL7_nI_vOSlE1i6ZAAJbyy8GEq_6EAZcmCW39eg6E7boSfIzJlZUZ8IVlGV9OledVsZxxxYnf5lhT-XelNNfGinbMPfOLveqY-2GRudUMPeavHzKGoYKk5E',
  dq: 'eo00WcR4q2BcJN1XkiOgwKly8JZstWI_wrqJMlEAp975NnKJ22X2XUiP3ClS1JXGZCBP4hsvH_5Fw4-UEJm1Ngem5hjldRxfGQS23UR77hW_Nqpji7C1MNCq2M3tH9t8QpAX0ZZeINm5PpdmRsH3oTz9zTyoaHc3-KyF4NOsyek',
  qi: 'eHXDgGQZcqKp1l1CYQ6ygUvD2QoFnJyjPSVkLYws4eJ3Nsr8zr0Jqhnu1XLwhJtCmZxGU22JUXd_nejqhj1oFZ8xFCfqelEcptwks_S4TKkMYunTYk5WjPMOjymqv3XiQbb-RgxWRwl4ypVH9kJ7n1W7kMuzwcui6DmSZccCnAE',
  alg: REQUEST_OBJECT_SIGNING_ALG,
  use: 'sig',
  kid: REQUEST_OBJECT_KEY_ID,
};

// Public half trusted by the OP; private half held by the suite to sign with.
const REQUEST_OBJECT_PUBLIC_JWKS = { keys: [REQUEST_OBJECT_PUBLIC_JWK] };
const REQUEST_OBJECT_PRIVATE_JWKS = { keys: [REQUEST_OBJECT_PRIVATE_JWK] };

const SAMPLE_APPS = new Map([
  [
    'hono-cloudflare',
    {
      name: 'hono-cloudflare',
      displayName: 'Hono Cloudflare',
      packageName: '@maronn-openid-connect/sample-hono-cloudflare',
      defaultStartCommand: 'corepack enable && pnpm --dir samples/hono-cloudflare start',
    },
  ],
  [
    'express-flyio',
    {
      name: 'express-flyio',
      displayName: 'Express',
      packageName: '@maronn-openid-connect/sample-express-flyio',
      defaultStartCommand: 'node samples/express-flyio/dist/server.js',
    },
  ],
  [
    'fastify-flyio',
    {
      name: 'fastify-flyio',
      displayName: 'Fastify',
      packageName: '@maronn-openid-connect/sample-fastify-flyio',
      defaultStartCommand: 'node samples/fastify-flyio/dist/server.js',
    },
  ],
  [
    'nextjs-vercel',
    {
      name: 'nextjs-vercel',
      displayName: 'Next.js',
      packageName: '@maronn-openid-connect/sample-nextjs-vercel',
      defaultStartCommand: 'corepack enable && pnpm --dir samples/nextjs-vercel start',
    },
  ],
]);

export function resolveSampleApp(sampleApp = 'hono-cloudflare') {
  const normalized = String(sampleApp).trim().toLowerCase();
  const metadata = SAMPLE_APPS.get(normalized);
  if (!metadata) {
    throw new Error(
      `Unsupported CONFORMANCE_SAMPLE_APP "${sampleApp}". Expected one of: ${[
        ...SAMPLE_APPS.keys(),
      ].join(', ')}`,
    );
  }
  return metadata;
}

export function createOpConformanceArtifacts(options = {}) {
  const profile = resolveProfile(options.profile ?? 'basic-op');
  const alias = options.alias ?? profile.defaultAlias;
  const opIssuer = normalizeBaseUrl(options.opIssuer ?? DEFAULT_OP_ISSUER, 'opIssuer');
  const suiteBaseUrl = normalizeBaseUrl(
    options.suiteBaseUrl ?? DEFAULT_SUITE_BASE_URL,
    'suiteBaseUrl',
  );
  const sampleApp = resolveSampleApp(options.sampleApp ?? 'hono-cloudflare');
  const redirectUris = createRedirectUris({ suiteBaseUrl, alias });
  // OIDC Core 1.0 §6.1 / RFC 9101: the suite signs Request Objects with the
  // private half of REQUEST_OBJECT_*_JWK; register the matching public JWKS on the
  // static clients so the OP can verify the signature. Defaults to the fixed
  // conformance key so signed Request Objects are exercised out of the box; an
  // explicit clientJwks overrides the OP-trusted public set.
  const clientJwks = options.clientJwks ?? REQUEST_OBJECT_PUBLIC_JWKS;

  const config = {
    alias,
    description: `maronn-openid-connect ${profile.displayName} certification check for the ${sampleApp.displayName} sample`,
    server: {
      discoveryUrl: `${opIssuer}/.well-known/openid-configuration`,
    },
  };
  for (const client of profile.clients) {
    config[client.suiteKey] = createSuiteClient({
      clientId: client.clientId,
      clientSecret: clientSecretOf(client.clientId),
    });
  }
  config.browser = createBrowserAutomation(opIssuer);

  return {
    profile,
    testPlan: opTestPlan(profile.name, { skipManualReview: options.skipManualReview }),
    sampleApp,
    config,
    clients: profile.clients.map((client) => createStaticClient({
      clientId: client.clientId,
      clientSecret: clientSecretOf(client.clientId),
      redirectUris,
      grantTypes: profile.grantTypes,
      responseTypes: profile.responseTypes,
      tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
      requestObjectJwks: clientJwks,
    })),
  };
}

// The secret of a static client: the client_id with a "-secret" suffix, the
// same on the OP (oidc-clients.json) and in the suite configuration.
function clientSecretOf(clientId) {
  return `${clientId}-secret`;
}

// OIDC Core 1.0 §6.1 / RFC 9101: a suite-side static client. `jwks` gives the
// suite the private key and `request_object_signing_alg` selects RS256, so the
// OIDF Request Object modules (oidcc-ensure-request-object-with-redirect-uri /
// oidcc-unsigned-request-object-...) sign a Request Object the OP can verify
// against the registered public JWKS instead of falling back to manual review.
function createSuiteClient({ clientId, clientSecret }) {
  return {
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'openid',
    jwks: REQUEST_OBJECT_PRIVATE_JWKS,
    request_object_signing_alg: REQUEST_OBJECT_SIGNING_ALG,
  };
}

export async function writeOpConformanceArtifacts(options = {}) {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const artifacts = createOpConformanceArtifacts(options);
  await mkdir(outDir, { recursive: true });

  const configPath = join(outDir, `${artifacts.profile.name}-config.json`);
  const clientsPath = join(outDir, 'oidc-clients.json');
  const metadataPath = join(outDir, 'metadata.json');
  const testPlanPath = join(outDir, 'test-plan.txt');

  await writeJsonFile(configPath, artifacts.config);
  await writeJsonFile(clientsPath, artifacts.clients);
  await writeJsonFile(metadataPath, {
    profile: artifacts.profile.name,
    testPlan: artifacts.testPlan,
    sampleApp: artifacts.sampleApp,
    configPath,
    clientsPath,
  });
  await writeFile(testPlanPath, `${artifacts.testPlan}\n`);

  return {
    ...artifacts,
    paths: {
      configPath,
      clientsPath,
      metadataPath,
      testPlanPath,
    },
  };
}

function createRedirectUris({ suiteBaseUrl, alias }) {
  const callbackUri = `${suiteBaseUrl}/test/a/${alias}/callback`;
  return [
    callbackUri,
    `${callbackUri}?dummy1=lorem&dummy2=ipsum`,
  ];
}

function createStaticClient({
  clientId,
  clientSecret,
  redirectUris,
  grantTypes,
  responseTypes,
  tokenEndpointAuthMethod,
  requestObjectJwks,
}) {
  const client = {
    clientId,
    clientSecret,
    redirectUris,
    clientType: 'confidential',
    grantTypes,
    tokenEndpointAuthMethods: [tokenEndpointAuthMethod],
    responseTypes,
  };
  // OIDC Core 1.0 §6.1: register the client JWKS as the keys of the
  // request_object purpose, the ones the OP verifies signed Request Objects
  // with, only when supplied (keeps the default config shape unchanged).
  if (requestObjectJwks !== undefined) {
    client.keys = { request_object: requestObjectJwks };
  }
  return client;
}

function createBrowserAutomation(opIssuer) {
  return [
    {
      match: `${opIssuer}/authorize*`,
      tasks: [
        {
          task: 'Login',
          optional: true,
          match: `${opIssuer}/login*`,
          commands: [
            ['text', 'name', 'username', 'testuser', 'optional'],
            ['text', 'name', 'password', 'password', 'optional'],
            ['click', 'css', 'button[type="submit"]'],
          ],
        },
        {
          task: 'Consent',
          optional: true,
          match: `${opIssuer}/consent*`,
          commands: [
            ['click', 'css', 'button[name="action"][value="approve"]'],
          ],
        },
        {
          // optional: some modules legitimately do not end on a suite
          // callback. ensure-registered-redirect-uri lands on the OP's invalid
          // redirect_uri error page (no callback), and prompt-login / max-age-1
          // pause on a screenshot/manual-review placeholder before any callback.
          // Without optional, the browser runner would block on this task and the
          // module would be reported INTERRUPTED / WebRunner timeout, masking the
          // fact that the OP behaved correctly. Marking it optional lets those
          // modules fall through to manual review instead of failing automation.
          //
          // The callback page of the suite posts the fragment of the URL back
          // to the suite before it shows submission_complete, so the same task
          // completes the Implicit Flow, whose response is in the fragment
          // (OIDC Core 1.0 §3.2.2.5).
          task: 'Verify Complete',
          optional: true,
          match: '*/test/*/callback*',
          commands: [
            ['wait', 'id', 'submission_complete', 10],
          ],
        },
      ],
    },
  ];
}

function normalizeBaseUrl(value, fieldName) {
  const normalized = String(value).trim().replace(/\/+$/, '');
  if (!normalized) {
    throw new Error(`${fieldName} must not be empty`);
  }
  return normalized;
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const artifacts = await writeOpConformanceArtifacts({
    // An unset or empty variable takes the default: the Basic OP profile, and
    // the alias of the profile.
    profile: process.env.CONFORMANCE_PROFILE || undefined,
    alias: process.env.CONFORMANCE_ALIAS || undefined,
    opIssuer: process.env.CONFORMANCE_OP_ISSUER,
    suiteBaseUrl: process.env.CONFORMANCE_SUITE_BASE_URL,
    sampleApp: process.env.CONFORMANCE_SAMPLE_APP,
    outDir: process.env.CONFORMANCE_OUT_DIR,
    // OIDC Core 1.0 §6.1: optional client JWKS (JSON) for signed Request Object
    // verification, e.g. CONFORMANCE_CLIENT_JWKS='{"keys":[...]}'.
    clientJwks: process.env.CONFORMANCE_CLIENT_JWKS
      ? JSON.parse(process.env.CONFORMANCE_CLIENT_JWKS)
      : undefined,
    // CONFORMANCE_SKIP_MANUAL_REVIEW=1 (CI) leaves out the modules that wait
    // for a screenshot.
    skipManualReview: process.env.CONFORMANCE_SKIP_MANUAL_REVIEW === '1',
  });

  console.log(JSON.stringify({
    profile: artifacts.profile.name,
    testPlan: artifacts.testPlan,
    sampleApp: artifacts.sampleApp.name,
    configPath: artifacts.paths.configPath,
    clientsPath: artifacts.paths.clientsPath,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
