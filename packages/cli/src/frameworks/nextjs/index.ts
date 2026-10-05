import type { FrameworkGenerator, GeneratedFile, GeneratorOptions } from '../types.js';
import { DEFAULT_FEATURES } from '../../features.js';
import type { OidcFeatureConfig } from '../../features.js';
import {
  configTemplate,
  customScopesTemplate,
  jarmConfigTemplate,
  resolversTemplate,
  storeTemplate,
} from '../hono/templates.js';
import {
  nextJsHtmlTemplate,
  nextJsHttpTemplate,
  nextJsProviderTemplate,
  nextJsStorageBackendTemplate,
} from './provider.js';
import { nextJsDiscoveryRouteTemplate, nextJsJwksRouteTemplate } from './metadata.js';
import { nextJsAuthorizeRouteTemplate } from './authorize.js';
import {
  nextJsCibaGrantTemplate,
  nextJsDeviceCodeGrantTemplate,
  nextJsIdJagGrantTemplate,
  nextJsTokenExchangeGrantTemplate,
  nextJsTokenRouteTemplate,
} from './token.js';
import {
  nextJsIntrospectionRouteTemplate,
  nextJsParConfigTemplate,
  nextJsParRouteTemplate,
  nextJsRevocationRouteTemplate,
  nextJsUserinfoRouteTemplate,
} from './endpoints.js';
import {
  nextJsDeviceApproveRouteTemplate,
  nextJsDeviceAuthorizationConfigTemplate,
  nextJsDeviceAuthorizationRouteTemplate,
  nextJsDeviceLoginRouteTemplate,
  nextJsDeviceRouteTemplate,
  nextJsDeviceScreensTemplate,
} from './device.js';
import {
  nextJsBackchannelAuthenticationRouteTemplate,
  nextJsCibaApproveRouteTemplate,
  nextJsCibaConfigTemplate,
  nextJsCibaLoginRouteTemplate,
  nextJsCibaRouteTemplate,
  nextJsCibaScreensTemplate,
} from './ciba.js';
import {
  nextJsLogoutApproveRouteTemplate,
  nextJsLogoutConfigTemplate,
  nextJsLogoutRouteTemplate,
  nextJsLogoutScreensTemplate,
} from './logout.js';
import {
  nextJsConsentActionTemplate,
  nextJsConsentPageTemplate,
  nextJsErrorBoundaryTemplate,
  nextJsErrorPageTemplate,
  nextJsErrorViewTemplate,
  nextJsGoogleLoginRouteTemplate,
  nextJsLoginActionTemplate,
  nextJsLoginPageTemplate,
  nextJsLoginSessionTemplate,
  nextJsNotFoundTemplate,
  nextJsTransactionTemplate,
} from './interaction.js';
import { nextJsConformanceTestTemplate } from './conformance.js';

/**
 * Next.js (App Router) generator.
 *
 * The output is written into the app directory and follows the App Router's own
 * structure: every OP endpoint is a Route Handler at its own path
 * (`token/route.ts` answers POST /token), the login and consent screens are
 * pages with Server Actions, and what the endpoints share — configuration,
 * clients, signing keys, stores — lives in the private `_oidc-provider/` folder,
 * which Next.js never routes.
 */
export class NextJsGenerator implements FrameworkGenerator {
  readonly name = 'nextjs';
  readonly displayName = 'Next.js';

  generate(options: GeneratorOptions): GeneratedFile[] {
    const pkg = options.corePackageName;
    const features = options.features ?? DEFAULT_FEATURES;
    const scopes = options.scopes ?? [];
    return nextJsGeneratedFiles(pkg, features, scopes);
  }
}

/** Where scopes.ts sends readers, in the App Router layout. */
const NEXTJS_SCOPE_POLICY_FILE_REFS = {
  userinfo: 'userinfo/route.ts',
  consent: 'consent/page.tsx + consent/actions.ts',
  authorize: 'authorize/route.ts',
  approvals: 'device/approve/route.ts / ciba/approve/route.ts',
};

/**
 * The framework-neutral modules (config, store, resolvers, scopes) are shared
 * with the other generators; Next.js resolves modules the bundler way, so their
 * relative imports drop the `.js` extension.
 */
function withBundlerImports(content: string): string {
  return content.replaceAll(/(from\s+['"](?:\.{1,2}\/[^'"]+))\.js(['"])/g, '$1$2');
}

function nextJsGeneratedFiles(
  pkg: string,
  features: OidcFeatureConfig,
  scopes: string[],
): GeneratedFile[] {
  // Screens that set a cookie on the response that renders them, and answer
  // with their own status codes, are Route Handlers returning HTML (see
  // _oidc-provider/html.ts).
  const servesHtmlFromRouteHandlers =
    features.deviceAuthorizationGrant || features.ciba || features.rpInitiatedLogout;

  return [
    // --- Shared by every endpoint (private folder, never routed) -------------
    { path: '_oidc-provider/provider.ts', content: nextJsProviderTemplate(pkg, features) },
    {
      path: '_oidc-provider/config.ts',
      // The authorize Route Handler always sends non-redirectable errors to
      // app/oidc-error, so the shared page layer's redirect-path hook is left out.
      content: withBundlerImports(
        configTemplate(pkg, features),
      ),
    },
    { path: '_oidc-provider/store.ts', content: withBundlerImports(storeTemplate(pkg, features)) },
    {
      path: '_oidc-provider/resolvers.ts',
      content: withBundlerImports(
        resolversTemplate(
          pkg,
          features,
          'The Next.js endpoints use the client resolver built in provider.ts instead.',
        ),
      ),
    },
    { path: '_oidc-provider/storage-backend.ts', content: nextJsStorageBackendTemplate() },
    { path: '_oidc-provider/http.ts', content: nextJsHttpTemplate() },
    { path: '_oidc-provider/transaction.ts', content: nextJsTransactionTemplate(pkg, features) },
    { path: '_oidc-provider/error-view.tsx', content: nextJsErrorViewTemplate() },
    ...(servesHtmlFromRouteHandlers
      ? [{ path: '_oidc-provider/html.ts', content: nextJsHtmlTemplate() }]
      : []),
    // Custom scopes (--scope): the scope policy module only exists when at least
    // one was declared.
    ...(scopes.length > 0
      ? [{
        path: '_oidc-provider/scopes.ts',
        content: withBundlerImports(customScopesTemplate(scopes, features, NEXTJS_SCOPE_POLICY_FILE_REFS)),
      }]
      : []),
    // Experimental (JARM): read by the authorization endpoint and the consent action.
    ...(features.jarm
      ? [{ path: '_oidc-provider/jarm.ts', content: withBundlerImports(jarmConfigTemplate()) }]
      : []),
    {
      path: '_oidc-provider/conformance.test.ts',
      content: nextJsConformanceTestTemplate(features, scopes),
    },

    // --- Metadata ------------------------------------------------------------
    {
      path: '.well-known/openid-configuration/route.ts',
      content: nextJsDiscoveryRouteTemplate(pkg, features, scopes),
    },
    { path: '.well-known/jwks.json/route.ts', content: nextJsJwksRouteTemplate(pkg) },

    // --- Authorization Code Flow ----------------------------------------------
    { path: 'authorize/route.ts', content: nextJsAuthorizeRouteTemplate(pkg, features, scopes) },
    // Login and consent are pages with Server Actions. Next.js renders their
    // not-found.tsx for notFound() (an unknown or expired transaction) and their
    // error.tsx for an exception nobody expected.
    { path: 'login/page.tsx', content: nextJsLoginPageTemplate(features) },
    { path: 'login/actions.ts', content: nextJsLoginActionTemplate(pkg) },
    { path: 'login/session.ts', content: nextJsLoginSessionTemplate(pkg, features) },
    { path: 'login/not-found.tsx', content: nextJsNotFoundTemplate('login') },
    { path: 'login/error.tsx', content: nextJsErrorBoundaryTemplate('login') },
    // Extension (google-login): the login_uri Google posts the ID token to.
    ...(features.googleLogin
      ? [{ path: 'login/google/route.ts', content: nextJsGoogleLoginRouteTemplate(pkg) }]
      : []),
    { path: 'consent/page.tsx', content: nextJsConsentPageTemplate(features, scopes) },
    { path: 'consent/actions.ts', content: nextJsConsentActionTemplate(pkg, features, scopes) },
    { path: 'consent/not-found.tsx', content: nextJsNotFoundTemplate('consent') },
    { path: 'consent/error.tsx', content: nextJsErrorBoundaryTemplate('consent') },
    // Errors that must not reach the client, from every step above.
    { path: 'oidc-error/page.tsx', content: nextJsErrorPageTemplate() },
    { path: 'token/route.ts', content: nextJsTokenRouteTemplate(pkg, features) },
    { path: 'userinfo/route.ts', content: nextJsUserinfoRouteTemplate(pkg) },
    ...(features.introspection
      ? [{ path: 'introspect/route.ts', content: nextJsIntrospectionRouteTemplate(pkg, features) }]
      : []),
    ...(features.revocation
      ? [{ path: 'revoke/route.ts', content: nextJsRevocationRouteTemplate(pkg) }]
      : []),

    // --- Experimental features -------------------------------------------------
    // RFC 9126: only generated with --enable par.
    ...(features.par
      ? [
        { path: 'par/route.ts', content: nextJsParRouteTemplate(pkg) },
        { path: 'par/config.ts', content: nextJsParConfigTemplate() },
      ]
      : []),
    // RFC 8693: only generated with --enable token-exchange.
    ...(features.tokenExchange
      ? [{ path: 'token/token-exchange.ts', content: nextJsTokenExchangeGrantTemplate(pkg) }]
      : []),
    // ID-JAG draft: only generated with --enable id-jag.
    ...(features.idJag
      ? [{ path: 'token/id-jag.ts', content: nextJsIdJagGrantTemplate(pkg, features) }]
      : []),
    // RFC 8628: only generated with --enable device-authorization-grant.
    ...(features.deviceAuthorizationGrant
      ? [
        {
          path: 'device_authorization/route.ts',
          content: nextJsDeviceAuthorizationRouteTemplate(pkg, features, scopes),
        },
        { path: 'device_authorization/config.ts', content: nextJsDeviceAuthorizationConfigTemplate() },
        { path: 'device/route.ts', content: nextJsDeviceRouteTemplate(scopes) },
        { path: 'device/login/route.ts', content: nextJsDeviceLoginRouteTemplate(pkg, scopes) },
        { path: 'device/approve/route.ts', content: nextJsDeviceApproveRouteTemplate(scopes) },
        { path: 'device/screens.ts', content: nextJsDeviceScreensTemplate() },
        { path: 'token/device-code.ts', content: nextJsDeviceCodeGrantTemplate(pkg, features) },
      ]
      : []),
    // CIBA Core 1.0: only generated with --enable ciba.
    ...(features.ciba
      ? [
        {
          path: 'backchannel_authentication/route.ts',
          content: nextJsBackchannelAuthenticationRouteTemplate(pkg, features, scopes),
        },
        { path: 'backchannel_authentication/config.ts', content: nextJsCibaConfigTemplate() },
        { path: 'ciba/route.ts', content: nextJsCibaRouteTemplate() },
        { path: 'ciba/login/route.ts', content: nextJsCibaLoginRouteTemplate(pkg) },
        { path: 'ciba/approve/route.ts', content: nextJsCibaApproveRouteTemplate(pkg, scopes) },
        { path: 'ciba/screens.ts', content: nextJsCibaScreensTemplate(scopes) },
        { path: 'token/ciba.ts', content: nextJsCibaGrantTemplate(pkg, features) },
      ]
      : []),
    // RP-Initiated Logout 1.0: only generated with --enable rp-initiated-logout.
    ...(features.rpInitiatedLogout
      ? [
        { path: 'logout/route.ts', content: nextJsLogoutRouteTemplate(pkg) },
        { path: 'logout/approve/route.ts', content: nextJsLogoutApproveRouteTemplate() },
        { path: 'logout/config.ts', content: nextJsLogoutConfigTemplate() },
        { path: 'logout/screens.ts', content: nextJsLogoutScreensTemplate() },
      ]
      : []),
  ];
}
