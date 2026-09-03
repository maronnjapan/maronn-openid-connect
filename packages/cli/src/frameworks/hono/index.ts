import type { FrameworkGenerator, GeneratedFile, GeneratorOptions } from '../types.js';
import { DEFAULT_FEATURES } from '../../features.js';
import { NO_CUSTOM_SCOPES, hasCustomScopes } from '../../scopes.js';
import {
  appTemplate,
  applyTemplate,
  configTemplate,
  customScopesTemplate,
  storeTemplate,
  resolversTemplate,
  viewsTemplate,
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
  jarmConfigTemplate,
  discoveryRouteTemplate,
  loginRouteTemplate,
  consentRouteTemplate,
  conformanceTestTemplate,
} from './templates.js';

export class HonoGenerator implements FrameworkGenerator {
  readonly name = 'hono';
  readonly displayName = 'Hono';

  generate(options: GeneratorOptions): GeneratedFile[] {
    const pkg = options.corePackageName;
    const features = options.features ?? DEFAULT_FEATURES;
    const scopes = options.scopes ?? NO_CUSTOM_SCOPES;

    return [
      { path: 'app.ts', content: appTemplate(pkg, features) },
      { path: 'apply.ts', content: applyTemplate(pkg, features) },
      { path: 'config.ts', content: configTemplate(pkg, features) },
      // Custom scopes (--scope / --user-scope): the policy module is only
      // generated when at least one was declared.
      ...(hasCustomScopes(scopes)
        ? [{ path: 'scopes.ts', content: customScopesTemplate(scopes, features) }]
        : []),
      { path: 'store.ts', content: storeTemplate(pkg, features) },
      { path: 'resolvers.ts', content: resolversTemplate(pkg, features) },
      { path: 'views.ts', content: viewsTemplate(features) },
      { path: 'routes/authorize.ts', content: authorizeRouteTemplate(pkg, features, scopes) },
      { path: 'routes/token.ts', content: tokenRouteTemplate(pkg, features) },
      { path: 'routes/userinfo.ts', content: userinfoRouteTemplate(pkg) },
      ...(features.introspection
        ? [{ path: 'routes/introspection.ts', content: introspectionRouteTemplate(pkg) }]
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
      // Experimental (JARM): settings module, only generated with --enable jarm.
      ...(features.jarm
        ? [{ path: 'routes/jarm.ts', content: jarmConfigTemplate() }]
        : []),
      { path: 'routes/jwks.ts', content: jwksRouteTemplate(pkg) },
      { path: 'routes/discovery.ts', content: discoveryRouteTemplate(pkg, features, scopes) },
      { path: 'routes/login.ts', content: loginRouteTemplate(pkg, features) },
      { path: 'routes/consent.ts', content: consentRouteTemplate(pkg, features, scopes) },
      { path: 'conformance.test.ts', content: conformanceTestTemplate(pkg, features, scopes) },
    ];
  }
}
