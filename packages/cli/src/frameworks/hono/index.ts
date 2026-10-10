import type { FrameworkGenerator, GeneratedFile, GeneratorOptions } from '../types.js';
import { DEFAULT_FEATURES } from '../../features.js';
import {
  appTemplate,
  applyTemplate,
  configTemplate,
  customScopesTemplate,
  storeTemplate,
  resolversTemplate,
  authorizeRouteTemplate,
  tokenRouteTemplate,
  userinfoRouteTemplate,
  introspectionRouteTemplate,
  revocationRouteTemplate,
  jwksRouteTemplate,
  parRouteTemplate,
  deviceAuthorizationRouteTemplate,
  deviceVerificationRouteTemplate,
  backchannelAuthenticationRouteTemplate,
  cibaVerificationRouteTemplate,
  endSessionRouteTemplate,
  jarmConfigTemplate,
  discoveryRouteTemplate,
  loginRouteTemplate,
  consentRouteTemplate,
} from './templates.js';
import {
  authorizePageTemplate,
  cibaPageTemplate,
  consentPageTemplate,
  devicePageTemplate,
  errorPageTemplate,
  loginPageTemplate,
  logoutPageTemplate,
  respondTemplate,
} from './pages.js';
import { honoViewsTemplate } from './views.js';
import { dbGeneratedFiles } from '../db/templates.js';

export class HonoGenerator implements FrameworkGenerator {
  readonly name = 'hono';
  readonly displayName = 'Hono';

  generate(options: GeneratorOptions): GeneratedFile[] {
    const pkg = options.corePackageName;
    const features = options.features ?? DEFAULT_FEATURES;
    const scopes = options.scopes ?? [];
    const db = options.db ?? false;

    const files: GeneratedFile[] = [
      { path: 'app.ts', content: appTemplate(pkg, features, db) },
      { path: 'apply.ts', content: applyTemplate(pkg, features, db) },
      { path: 'config.ts', content: configTemplate(pkg, features) },
      // Custom scopes (--scope): the scope policy module is only generated when
      // at least one was declared.
      ...(scopes.length > 0
        ? [{ path: 'scopes.ts', content: customScopesTemplate(scopes, features) }]
        : []),
      { path: 'store.ts', content: storeTemplate(pkg, features) },
      { path: 'resolvers.ts', content: resolversTemplate(pkg, features) },
      // The default screens as hono/jsx components (views.tsx); the other
      // frameworks generate the same contract as HTML strings (views.ts).
      { path: 'views.tsx', content: honoViewsTemplate(features) },
      // Screen routing layer (pages/): every browser-facing GET / POST
      // (authorize, login, consent, and the device / CIBA / logout UIs) plus the
      // render helpers. Each page calls the logic of its routes/ module and only
      // renders or redirects, so the UI is customized in pages/ and views.tsx.
      // The modules that render a view do it with JSX (<views.loginPage />), so
      // they are .tsx; authorize and respond only redirect and stay .ts.
      { path: 'pages/respond.ts', content: respondTemplate() },
      { path: 'pages/errors.tsx', content: errorPageTemplate('jsx') },
      { path: 'pages/authorize.ts', content: authorizePageTemplate() },
      { path: 'pages/login.tsx', content: loginPageTemplate(features, 'jsx') },
      { path: 'pages/consent.tsx', content: consentPageTemplate('jsx') },
      ...(features.deviceAuthorizationGrant
        ? [{ path: 'pages/device.tsx', content: devicePageTemplate('jsx') }]
        : []),
      ...(features.ciba ? [{ path: 'pages/ciba.tsx', content: cibaPageTemplate('jsx') }] : []),
      ...(features.rpInitiatedLogout
        ? [{ path: 'pages/logout.tsx', content: logoutPageTemplate('jsx') }]
        : []),
      { path: 'routes/authorize.ts', content: authorizeRouteTemplate(pkg, features, scopes) },
      { path: 'routes/token.ts', content: tokenRouteTemplate(pkg, features) },
      { path: 'routes/userinfo.ts', content: userinfoRouteTemplate(pkg) },
      ...(features.introspection
        ? [{ path: 'routes/introspection.ts', content: introspectionRouteTemplate(pkg, features) }]
        : []),
      ...(features.revocation
        ? [{ path: 'routes/revocation.ts', content: revocationRouteTemplate(pkg) }]
        : []),
      // Experimental (RFC 9126): only generated with --enable par.
      ...(features.par
        ? [{ path: 'routes/par.ts', content: parRouteTemplate(pkg) }]
        : []),
      // Experimental (RFC 8628): only generated with --enable device-authorization-grant.
      ...(features.deviceAuthorizationGrant
        ? [
          {
            path: 'routes/device-authorization.ts',
            content: deviceAuthorizationRouteTemplate(pkg, features, scopes),
          },
          { path: 'routes/device.ts', content: deviceVerificationRouteTemplate(pkg, scopes) },
        ]
        : []),
      // Experimental (CIBA Core 1.0): only generated with --enable ciba.
      ...(features.ciba
        ? [
          {
            path: 'routes/backchannel-authentication.ts',
            content: backchannelAuthenticationRouteTemplate(pkg, features, scopes),
          },
          { path: 'routes/ciba-verification.ts', content: cibaVerificationRouteTemplate(pkg, scopes) },
        ]
        : []),
      // Experimental (RP-Initiated Logout 1.0): only generated with
      // --enable rp-initiated-logout.
      ...(features.rpInitiatedLogout
        ? [{ path: 'routes/logout.ts', content: endSessionRouteTemplate(pkg) }]
        : []),
      // Experimental (JARM): settings module, only generated with --enable jarm.
      ...(features.jarm
        ? [{ path: 'routes/jarm.ts', content: jarmConfigTemplate() }]
        : []),
      { path: 'routes/jwks.ts', content: jwksRouteTemplate(pkg) },
      { path: 'routes/discovery.ts', content: discoveryRouteTemplate(pkg, features, scopes) },
      { path: 'routes/login.ts', content: loginRouteTemplate(pkg, features) },
      { path: 'routes/consent.ts', content: consentRouteTemplate(pkg, features, scopes) },
      // --db: SQL tables, the stores on them, and the db/instance.ts the user writes.
      ...(db ? dbGeneratedFiles(pkg, features, 'hono') : []),
    ];
    // The templates are shared with the frameworks that write these modules as
    // .ts; point their comments at the .tsx files here ('views.ts' and
    // 'pages/login.ts' become 'views.tsx' and 'pages/login.tsx'). Imports are
    // unaffected: '../views.js' resolves to views.tsx.
    const tsxModules = files
      .filter((file) => file.path.endsWith('.tsx'))
      .map((file) => file.path.slice(0, -'.tsx'.length));
    const tsReference = new RegExp(`\\b(${tsxModules.join('|')})\\.ts\\b`, 'g');
    return files.map((file) => ({
      ...file,
      content: file.content.replace(tsReference, '$1.tsx'),
    }));
  }
}
