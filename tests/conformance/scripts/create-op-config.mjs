import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * How the suite gets its client (CONFORMANCE_CLIENT_REGISTRATION): static,
 * the clients create-op-config.mjs registers on the OP (oidc-clients.json)
 * and configures on the suite, or dynamic, a client the suite registers at the
 * OP's registration endpoint (OpenID Connect Dynamic Client Registration 1.0)
 * before each module. The suite names them static_client / dynamic_client in
 * the client_registration variant of the plan.
 */
const CLIENT_REGISTRATIONS = new Map([
  ['static', { name: 'static', variant: 'static_client', displayName: 'static client' }],
  ['dynamic', { name: 'dynamic', variant: 'dynamic_client', displayName: 'dynamic client registration' }],
]);

export function resolveClientRegistration(clientRegistration = 'static') {
  const normalized = String(clientRegistration).trim().toLowerCase();
  const metadata = CLIENT_REGISTRATIONS.get(normalized);
  if (!metadata) {
    throw new Error(
      `Unsupported CONFORMANCE_CLIENT_REGISTRATION "${clientRegistration}". Expected one of: ${[
        ...CLIENT_REGISTRATIONS.keys(),
      ].join(', ')}`,
    );
  }
  return metadata;
}

/** The test plan of a certification plan with its server_metadata and client_registration variants. */
export function opTestPlanName(plan = 'basic', clientRegistration = 'static') {
  const { testPlanBase } = resolvePlan(plan);
  const { variant } = resolveClientRegistration(clientRegistration);
  return `${testPlanBase}[server_metadata=discovery][client_registration=${variant}]`;
}

export const BASIC_OP_TEST_PLAN =
  'oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]';

export const IMPLICIT_OP_TEST_PLAN =
  'oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]';

export const HYBRID_OP_TEST_PLAN =
  'oidcc-hybrid-certification-test-plan[server_metadata=discovery][client_registration=static_client]';

/**
 * The same plans with dynamic client registration. The suite then also runs
 * the modules it leaves out for a static client: oidcc-idtoken-signature (an
 * ID Token signed with the default alg, with a kid), oidcc-idtoken-unsigned
 * (skips itself unless the OP advertises none for ID Tokens) and
 * oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported
 * (a request_uri the suite registers as request_uris, OIDC Core 1.0 §6.2).
 */
export const BASIC_OP_DYNAMIC_TEST_PLAN =
  'oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=dynamic_client]';

export const IMPLICIT_OP_DYNAMIC_TEST_PLAN =
  'oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=dynamic_client]';

export const HYBRID_OP_DYNAMIC_TEST_PLAN =
  'oidcc-hybrid-certification-test-plan[server_metadata=discovery][client_registration=dynamic_client]';

/**
 * The modules of the Basic OP plan, in its order (OIDCCBasicTestPlan of the
 * conformance suite). A run names them only to leave the manual review ones
 * out; the suite ignores a name its plan does not have. With a static client
 * the suite leaves out oidcc-idtoken-signature, oidcc-idtoken-unsigned and
 * oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported
 * (VariantNotApplicable static_client); with dynamic client registration it
 * runs them.
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
 * The modules the Implicit OP plan runs once with response_type=id_token and
 * once with id_token token, in its order (OIDCCImplicitTestPlan of the
 * conformance suite).
 */
const IMPLICIT_OP_MODULES_PER_RESPONSE_TYPE = [
  'oidcc-server',
  'oidcc-idtoken-signature',
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
  'oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported',
  'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported',
  'oidcc-ensure-request-object-with-redirect-uri',
  'oidcc-claims-essential',
];

/**
 * The modules of the Implicit OP plan, in its order: those of
 * IMPLICIT_OP_MODULES_PER_RESPONSE_TYPE for id_token and again for id_token
 * token, then the UserInfo modules and oidcc-response-type-missing, which it
 * runs once, with id_token token. run-test-plan.py takes one module of the
 * plan for each time a selection names it, so a module is named once for each
 * response type it runs with.
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
 * The modules the Hybrid OP plan runs for each of its response types, in its
 * order (OIDCCHybridTestPlan of the conformance suite): the modules of the
 * Basic OP plan, with oidcc-ensure-request-without-nonce-fails for the
 * response types that return an ID Token from the authorization endpoint
 * (OIDC Core 1.0 §3.3.2.11) and
 * oidcc-ensure-request-without-nonce-succeeds-for-code-flow for code token.
 * The first run (code id_token) also has the modules the plan runs once:
 * oidcc-response-type-missing, oidcc-alternate-happy-flow and
 * oidcc-ensure-request-with-valid-pkce-succeeds.
 */
const HYBRID_OP_MODULES_PER_RESPONSE_TYPE = {
  'code id_token': [
    'oidcc-server',
    'oidcc-response-type-missing',
    'oidcc-idtoken-signature',
    'oidcc-userinfo-get',
    'oidcc-userinfo-post-header',
    'oidcc-userinfo-post-body',
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
    'oidcc-codereuse',
    'oidcc-codereuse-30seconds',
    'oidcc-ensure-registered-redirect-uri',
    'oidcc-server-client-secret-post',
    'oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported',
    'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported',
    'oidcc-claims-essential',
    'oidcc-ensure-request-object-with-redirect-uri',
    'oidcc-refresh-token',
    'oidcc-ensure-request-with-valid-pkce-succeeds',
  ],
  'code token': [
    'oidcc-server',
    'oidcc-idtoken-signature',
    'oidcc-userinfo-get',
    'oidcc-userinfo-post-header',
    'oidcc-userinfo-post-body',
    'oidcc-ensure-request-without-nonce-succeeds-for-code-flow',
    'oidcc-scope-profile',
    'oidcc-scope-email',
    'oidcc-scope-address',
    'oidcc-scope-phone',
    'oidcc-scope-all',
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
    'oidcc-server-client-secret-post',
    'oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported',
    'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported',
    'oidcc-claims-essential',
    'oidcc-ensure-request-object-with-redirect-uri',
    'oidcc-refresh-token',
  ],
  'code id_token token': [
    'oidcc-server',
    'oidcc-idtoken-signature',
    'oidcc-userinfo-get',
    'oidcc-userinfo-post-header',
    'oidcc-userinfo-post-body',
    'oidcc-ensure-request-without-nonce-fails',
    'oidcc-scope-profile',
    'oidcc-scope-email',
    'oidcc-scope-address',
    'oidcc-scope-phone',
    'oidcc-scope-all',
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
    'oidcc-server-client-secret-post',
    'oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported',
    'oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported',
    'oidcc-claims-essential',
    'oidcc-ensure-request-object-with-redirect-uri',
    'oidcc-refresh-token',
  ],
};

/**
 * The modules of the Hybrid OP plan, in its order: those of code id_token,
 * then code token, then code id_token token. run-test-plan.py takes one
 * module of the plan for each time a selection names it, so a module is named
 * once for each response type it runs with.
 */
const HYBRID_OP_MODULES = [
  ...HYBRID_OP_MODULES_PER_RESPONSE_TYPE['code id_token'],
  ...HYBRID_OP_MODULES_PER_RESPONSE_TYPE['code token'],
  ...HYBRID_OP_MODULES_PER_RESPONSE_TYPE['code id_token token'],
];

/**
 * The modules that wait for a screenshot (manual review; see the README). An
 * unattended run never uploads one, and run-test-plan.py waits 240 s for each
 * before it gives up. Every plan has them.
 */
export const MANUAL_REVIEW_MODULES = [
  'oidcc-prompt-login',
  'oidcc-max-age-1',
  'oidcc-ensure-registered-redirect-uri',
];

/**
 * What the clients of the Basic OP plan share: confidential clients of the
 * Authorization Code Flow (response_type=code), which authenticate at the
 * token endpoint with their secret.
 */
const CODE_FLOW_CLIENT = {
  clientType: 'confidential',
  grantTypes: ['authorization_code', 'refresh_token'],
  responseTypes: ['code'],
};

/**
 * What the clients of the Hybrid OP plan share: confidential clients of the
 * three response types of the Hybrid Flow (OIDC Core 1.0 §3.3), which
 * exchange the code at the token endpoint with their secret. OIDC Dynamic
 * Client Registration 1.0 §2 pairs those response types with the
 * authorization_code and implicit grant types.
 */
const HYBRID_FLOW_CLIENT = {
  clientType: 'confidential',
  grantTypes: ['authorization_code', 'implicit', 'refresh_token'],
  responseTypes: ['code id_token', 'code token', 'code id_token token'],
};

/**
 * The plans of OpenID Connect Core certification a run can check
 * (CONFORMANCE_PLAN), and the static clients each needs. A client is
 * registered on the OP (oidc-clients.json) and configured on the suite under
 * configKey.
 */
const PLANS = new Map([
  [
    'basic',
    {
      name: 'basic',
      displayName: 'Basic OP',
      testPlan: BASIC_OP_TEST_PLAN,
      testPlanBase: 'oidcc-basic-certification-test-plan',
      modules: BASIC_OP_MODULES,
      defaultAlias: 'maronn-basic-op',
      // client2 is the second client of oidcc-refresh-token, and
      // client_secret_post the client of oidcc-server-client-secret-post.
      clients: [
        {
          configKey: 'client',
          clientId: 'oidf-basic-client',
          clientSecret: 'oidf-basic-client-secret',
          ...CODE_FLOW_CLIENT,
          tokenEndpointAuthMethod: 'client_secret_basic',
        },
        {
          configKey: 'client2',
          clientId: 'oidf-basic-client-2',
          clientSecret: 'oidf-basic-client-2-secret',
          ...CODE_FLOW_CLIENT,
          tokenEndpointAuthMethod: 'client_secret_basic',
        },
        {
          configKey: 'client_secret_post',
          clientId: 'oidf-post-client',
          clientSecret: 'oidf-post-client-secret',
          ...CODE_FLOW_CLIENT,
          tokenEndpointAuthMethod: 'client_secret_post',
        },
      ],
    },
  ],
  [
    'implicit',
    {
      name: 'implicit',
      displayName: 'Implicit OP',
      testPlan: IMPLICIT_OP_TEST_PLAN,
      testPlanBase: 'oidcc-implicit-certification-test-plan',
      modules: IMPLICIT_OP_MODULES,
      defaultAlias: 'maronn-implicit-op',
      // OIDC Core 1.0 §3.2: the client of both response types of the Implicit
      // Flow and of the implicit grant type that pairs with them (OIDC Dynamic
      // Client Registration 1.0 §2). It never calls the token endpoint, so it
      // is a public (browser-based) client without a secret; the plan's
      // client_auth_type=client_secret_basic is not used by any of its modules.
      clients: [
        {
          configKey: 'client',
          clientId: 'oidf-implicit-client',
          clientType: 'public',
          grantTypes: ['implicit'],
          responseTypes: ['id_token', 'id_token token'],
          tokenEndpointAuthMethod: 'none',
        },
      ],
    },
  ],
  [
    'hybrid',
    {
      name: 'hybrid',
      displayName: 'Hybrid OP',
      testPlan: HYBRID_OP_TEST_PLAN,
      testPlanBase: 'oidcc-hybrid-certification-test-plan',
      modules: HYBRID_OP_MODULES,
      defaultAlias: 'maronn-hybrid-op',
      // The same three clients as the Basic OP plan, registered for the hybrid
      // response types: client2 is the second client of oidcc-refresh-token,
      // and client_secret_post the client of oidcc-server-client-secret-post,
      // both of which the plan runs for each response type.
      clients: [
        {
          configKey: 'client',
          clientId: 'oidf-hybrid-client',
          clientSecret: 'oidf-hybrid-client-secret',
          ...HYBRID_FLOW_CLIENT,
          tokenEndpointAuthMethod: 'client_secret_basic',
        },
        {
          configKey: 'client2',
          clientId: 'oidf-hybrid-client-2',
          clientSecret: 'oidf-hybrid-client-2-secret',
          ...HYBRID_FLOW_CLIENT,
          tokenEndpointAuthMethod: 'client_secret_basic',
        },
        {
          configKey: 'client_secret_post',
          clientId: 'oidf-hybrid-post-client',
          clientSecret: 'oidf-hybrid-post-client-secret',
          ...HYBRID_FLOW_CLIENT,
          tokenEndpointAuthMethod: 'client_secret_post',
        },
      ],
    },
  ],
]);

export function resolvePlan(plan = 'basic') {
  const normalized = String(plan).trim().toLowerCase();
  const metadata = PLANS.get(normalized);
  if (!metadata) {
    throw new Error(
      `Unsupported CONFORMANCE_PLAN "${plan}". Expected one of: ${[...PLANS.keys()].join(', ')}`,
    );
  }
  return metadata;
}

/**
 * The test plan argument of run-test-plan.py: the whole plan (with the
 * client_registration variant of clientRegistration), or, with
 * skipManualReview, its modules without the manual review ones
 * (`<plan>:<module>,<module>`).
 */
export function opTestPlan({ plan = 'basic', skipManualReview = false, clientRegistration = 'static' } = {}) {
  const { modules } = resolvePlan(plan);
  const testPlan = opTestPlanName(plan, clientRegistration);
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

// dynamicClientRegistration: whether the sample was generated with
// --enable dynamic-client-registration (its package.json generate script), the
// registration endpoint the dynamic client registration runs need.
const SAMPLE_APPS = new Map([
  [
    'hono-cloudflare',
    {
      name: 'hono-cloudflare',
      displayName: 'Hono Cloudflare',
      packageName: '@maronn-openid-connect/sample-hono-cloudflare',
      defaultStartCommand: 'corepack enable && pnpm --dir samples/hono-cloudflare start',
      dynamicClientRegistration: true,
    },
  ],
  [
    'express-flyio',
    {
      name: 'express-flyio',
      displayName: 'Express',
      packageName: '@maronn-openid-connect/sample-express-flyio',
      defaultStartCommand: 'node samples/express-flyio/dist/server.js',
      dynamicClientRegistration: true,
    },
  ],
  [
    'fastify-flyio',
    {
      name: 'fastify-flyio',
      displayName: 'Fastify',
      packageName: '@maronn-openid-connect/sample-fastify-flyio',
      defaultStartCommand: 'node samples/fastify-flyio/dist/server.js',
      dynamicClientRegistration: false,
    },
  ],
  [
    'nextjs-vercel',
    {
      name: 'nextjs-vercel',
      displayName: 'Next.js',
      packageName: '@maronn-openid-connect/sample-nextjs-vercel',
      defaultStartCommand: 'corepack enable && pnpm --dir samples/nextjs-vercel start',
      dynamicClientRegistration: false,
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
  const plan = resolvePlan(options.plan ?? 'basic');
  const clientRegistration = resolveClientRegistration(options.clientRegistration ?? 'static');
  const alias = options.alias ?? plan.defaultAlias;
  const opIssuer = normalizeBaseUrl(options.opIssuer ?? DEFAULT_OP_ISSUER, 'opIssuer');
  const suiteBaseUrl = normalizeBaseUrl(
    options.suiteBaseUrl ?? DEFAULT_SUITE_BASE_URL,
    'suiteBaseUrl',
  );
  const sampleApp = resolveSampleApp(options.sampleApp ?? 'hono-cloudflare');
  if (clientRegistration.name === 'dynamic' && !sampleApp.dynamicClientRegistration) {
    throw new Error(
      `CONFORMANCE_CLIENT_REGISTRATION=dynamic needs a sample generated with --enable dynamic-client-registration; ${sampleApp.name} was not`,
    );
  }
  const redirectUris = createRedirectUris({ suiteBaseUrl, alias });
  // OIDC Core 1.0 §6.1 / RFC 9101: the suite signs Request Objects with the
  // private half of REQUEST_OBJECT_*_JWK; register the matching public JWKS on the
  // static clients so the OP can verify the signature. Defaults to the fixed
  // conformance key so signed Request Objects are exercised out of the box; an
  // explicit clientJwks overrides the OP-trusted public set.
  const clientJwks = options.clientJwks ?? REQUEST_OBJECT_PUBLIC_JWKS;
  const dynamic = clientRegistration.name === 'dynamic';

  return {
    plan: plan.name,
    clientRegistration: clientRegistration.name,
    testPlan: opTestPlan({
      plan: plan.name,
      skipManualReview: options.skipManualReview,
      clientRegistration: clientRegistration.name,
    }),
    sampleApp,
    config: {
      alias,
      description:
        `maronn-openid-connect ${plan.displayName} certification check for the ${sampleApp.displayName} sample` +
        (dynamic ? ` (${clientRegistration.displayName})` : ''),
      server: {
        discoveryUrl: `${opIssuer}/.well-known/openid-configuration`,
      },
      ...Object.fromEntries(
        plan.clients.map((client) => [
          client.configKey,
          dynamic ? createSuiteDynamicClient(client, plan) : createSuiteClient(client),
        ]),
      ),
      browser: createBrowserAutomation({ opIssuer, suiteBaseUrl }),
    },
    // With dynamic client registration the suite registers its clients at
    // POST /register before each module, so the OP starts without any.
    clients: dynamic
      ? []
      : plan.clients.map((client) => createStaticClient({ ...client, redirectUris, requestObjectJwks: clientJwks })),
  };
}

// OpenID Connect Dynamic Client Registration 1.0: a suite-side client the suite
// registers itself. The suite reads client_name (and initial_access_token,
// unset here: the sample OPs register openly) from this object, generates its
// own RS256 keys for the Request Object modules and registers them as jwks,
// and registers the request_uri of the request_uri modules as request_uris.
// client_secret and jwks are hidden fields of this variant.
function createSuiteDynamicClient({ configKey }, plan) {
  return {
    client_name: `maronn-openid-connect ${plan.displayName} conformance ${configKey}`,
    scope: 'openid',
  };
}

// OIDC Core 1.0 §6.1 / RFC 9101: a suite-side static client. `jwks` gives the
// suite the private key and `request_object_signing_alg` selects RS256, so the
// OIDF Request Object modules (oidcc-ensure-request-object-with-redirect-uri /
// oidcc-unsigned-request-object-...) sign a Request Object the OP can verify
// against the registered public JWKS instead of falling back to manual review.
// A public client has no client_secret.
function createSuiteClient({ clientId, clientSecret }) {
  return {
    client_id: clientId,
    ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
    scope: 'openid',
    jwks: REQUEST_OBJECT_PRIVATE_JWKS,
    request_object_signing_alg: REQUEST_OBJECT_SIGNING_ALG,
  };
}

export async function writeOpConformanceArtifacts(options = {}) {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const artifacts = createOpConformanceArtifacts(options);
  await mkdir(outDir, { recursive: true });

  const configPath = join(outDir, `${artifacts.plan}-op-config.json`);
  const clientsPath = join(outDir, 'oidc-clients.json');
  const metadataPath = join(outDir, 'metadata.json');
  const testPlanPath = join(outDir, 'test-plan.txt');

  await writeJsonFile(configPath, artifacts.config);
  await writeJsonFile(clientsPath, artifacts.clients);
  await writeJsonFile(metadataPath, {
    plan: artifacts.plan,
    clientRegistration: artifacts.clientRegistration,
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
  clientType,
  grantTypes,
  tokenEndpointAuthMethod,
  responseTypes,
  requestObjectJwks,
}) {
  const client = {
    clientId,
    // A public client has no clientSecret.
    ...(clientSecret === undefined ? {} : { clientSecret }),
    redirectUris,
    clientType,
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

function createBrowserAutomation({ opIssuer, suiteBaseUrl }) {
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
          // optional: some modules of both plans legitimately do not end on a
          // suite callback. ensure-registered-redirect-uri lands on the OP's invalid
          // redirect_uri error page (no callback), and prompt-login / max-age-1
          // pause on a screenshot/manual-review placeholder before any callback.
          // Without optional, the browser runner would block on this task and the
          // module would be reported INTERRUPTED / WebRunner timeout, masking the
          // fact that the OP behaved correctly. Marking it optional lets those
          // modules fall through to manual review instead of failing automation.
          //
          // The pattern is anchored to the suite: the authorization request
          // carries the callback in its redirect_uri query parameter, so
          // '*/test/*/callback*' also matches the URL of the OP, and on the
          // error page of ensure-registered-redirect-uri the browser would wait
          // for a submission that never comes (INTERRUPTED, not manual review).
          task: 'Verify Complete',
          optional: true,
          match: `${suiteBaseUrl}/test/*/callback*`,
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
    // CONFORMANCE_PLAN: basic (the default), implicit or hybrid.
    plan: process.env.CONFORMANCE_PLAN,
    // CONFORMANCE_CLIENT_REGISTRATION: static (the default) or dynamic.
    clientRegistration: process.env.CONFORMANCE_CLIENT_REGISTRATION,
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
    // CONFORMANCE_SKIP_MANUAL_REVIEW=1 (CI) leaves out the modules that wait
    // for a screenshot.
    skipManualReview: process.env.CONFORMANCE_SKIP_MANUAL_REVIEW === '1',
  });

  console.log(JSON.stringify({
    plan: artifacts.plan,
    clientRegistration: artifacts.clientRegistration,
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
