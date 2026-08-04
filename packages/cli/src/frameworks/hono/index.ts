import type { FrameworkGenerator, GeneratedFile, GeneratorOptions } from '../types.js';
import { DEFAULT_FEATURES } from '../../features.js';
import {
  appTemplate,
  applyTemplate,
  configTemplate,
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

    return [
      { path: 'app.ts', content: appTemplate(pkg, features) },
      { path: 'apply.ts', content: applyTemplate(pkg, features) },
      { path: 'config.ts', content: configTemplate(pkg, features) },
      { path: 'store.ts', content: storeTemplate(pkg, features) },
      { path: 'resolvers.ts', content: resolversTemplate(pkg, features) },
      { path: 'views.ts', content: viewsTemplate() },
      { path: 'routes/authorize.ts', content: authorizeRouteTemplate(pkg, features) },
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
      // Experimental (JARM): settings module, only generated with --enable jarm.
      ...(features.jarm
        ? [{ path: 'routes/jarm.ts', content: jarmConfigTemplate() }]
        : []),
      { path: 'routes/jwks.ts', content: jwksRouteTemplate(pkg) },
      { path: 'routes/discovery.ts', content: discoveryRouteTemplate(pkg, features) },
      { path: 'routes/login.ts', content: loginRouteTemplate(pkg, features) },
      { path: 'routes/consent.ts', content: consentRouteTemplate(pkg, features) },
      { path: 'conformance.test.ts', content: conformanceTestTemplate(pkg, features) },
    ];
  }
}
