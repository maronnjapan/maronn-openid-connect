import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASIC_OP_TEST_PLAN =
  'oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]';

const DEFAULT_ALIAS = 'maronn-basic-op';
const DEFAULT_OP_ISSUER = 'https://op-tls:3443';
const DEFAULT_SUITE_BASE_URL = 'https://conformance-nginx:8443';
const DEFAULT_OUT_DIR = fileURLToPath(new URL('../.generated', import.meta.url));

// OIDC Core 1.0 §6.1 / RFC 9101 (JAR): a fixed RS256 keypair so the Request
// Object modules in the Basic OP plan become a real automated test target rather
// than a manual-review / skipped path.
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

export function createBasicOpConformanceArtifacts(options = {}) {
  const alias = options.alias ?? DEFAULT_ALIAS;
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
  const clients = createStaticClients(redirectUris, clientJwks);

  return {
    testPlan: BASIC_OP_TEST_PLAN,
    sampleApp,
    config: {
      alias,
      description: `maronn-openid-connect Basic OP certification check for the ${sampleApp.displayName} sample`,
      server: {
        discoveryUrl: `${opIssuer}/.well-known/openid-configuration`,
      },
      client: createSuiteClient({
        clientId: 'oidf-basic-client',
        clientSecret: 'oidf-basic-client-secret',
      }),
      client2: createSuiteClient({
        clientId: 'oidf-basic-client-2',
        clientSecret: 'oidf-basic-client-2-secret',
      }),
      client_secret_post: createSuiteClient({
        clientId: 'oidf-post-client',
        clientSecret: 'oidf-post-client-secret',
      }),
      browser: createBrowserAutomation(opIssuer),
    },
    clients,
  };
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

export async function writeBasicOpConformanceArtifacts(options = {}) {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const artifacts = createBasicOpConformanceArtifacts(options);
  await mkdir(outDir, { recursive: true });

  const configPath = join(outDir, 'basic-op-config.json');
  const clientsPath = join(outDir, 'oidc-clients.json');
  const metadataPath = join(outDir, 'metadata.json');

  await writeJsonFile(configPath, artifacts.config);
  await writeJsonFile(clientsPath, artifacts.clients);
  await writeJsonFile(metadataPath, {
    testPlan: artifacts.testPlan,
    sampleApp: artifacts.sampleApp,
    configPath,
    clientsPath,
  });

  return {
    ...artifacts,
    paths: {
      configPath,
      clientsPath,
      metadataPath,
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

function createStaticClients(redirectUris, clientJwks) {
  return [
    createStaticClient({
      clientId: 'oidf-basic-client',
      clientSecret: 'oidf-basic-client-secret',
      redirectUris,
      tokenEndpointAuthMethod: 'client_secret_basic',
      jwks: clientJwks,
    }),
    createStaticClient({
      clientId: 'oidf-basic-client-2',
      clientSecret: 'oidf-basic-client-2-secret',
      redirectUris,
      tokenEndpointAuthMethod: 'client_secret_basic',
      jwks: clientJwks,
    }),
    createStaticClient({
      clientId: 'oidf-post-client',
      clientSecret: 'oidf-post-client-secret',
      redirectUris,
      tokenEndpointAuthMethod: 'client_secret_post',
      jwks: clientJwks,
    }),
  ];
}

function createStaticClient({
  clientId,
  clientSecret,
  redirectUris,
  tokenEndpointAuthMethod,
  jwks,
}) {
  const client = {
    clientId,
    clientSecret,
    redirectUris,
    clientType: 'confidential',
    grantTypes: ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod,
    responseTypes: ['code'],
  };
  // OIDC Core 1.0 §6.1: register the client JWKS for signed Request Object
  // verification only when supplied (keeps the default config shape unchanged).
  if (jwks !== undefined) {
    client.jwks = jwks;
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
          // optional: some Basic OP modules legitimately do not end on a suite
          // callback. ensure-registered-redirect-uri lands on the OP's invalid
          // redirect_uri error page (no callback), and prompt-login / max-age-1
          // pause on a screenshot/manual-review placeholder before any callback.
          // Without optional, the browser runner would block on this task and the
          // module would be reported INTERRUPTED / WebRunner timeout, masking the
          // fact that the OP behaved correctly. Marking it optional lets those
          // modules fall through to manual review instead of failing automation.
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
  const artifacts = await writeBasicOpConformanceArtifacts({
    alias: process.env.CONFORMANCE_ALIAS,
    opIssuer: process.env.CONFORMANCE_OP_ISSUER,
    suiteBaseUrl: process.env.CONFORMANCE_SUITE_BASE_URL,
    sampleApp: process.env.CONFORMANCE_SAMPLE_APP,
    outDir: process.env.CONFORMANCE_OUT_DIR,
    // OIDC Core 1.0 §6.1: optional client JWKS (JSON) for signed Request Object
    // verification, e.g. CONFORMANCE_CLIENT_JWKS='{"keys":[...]}'.
    clientJwks: process.env.CONFORMANCE_CLIENT_JWKS
      ? JSON.parse(process.env.CONFORMANCE_CLIENT_JWKS)
      : undefined,
  });

  console.log(JSON.stringify({
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
