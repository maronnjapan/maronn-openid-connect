/**
 * Where each endpoint of the flow lives in the generated output of a framework.
 *
 * The catalog is framework-neutral; this adds the module paths so a diagram or
 * a UI can point at the file to open. Hono, Express and Fastify share one
 * layout (routes/ holds the logic, pages/ the screens); Next.js follows the
 * App Router layout.
 */
import type { OpFlow } from './types.js';

type ModuleMap = Record<string, string>;

const ROUTES_LAYOUT: ModuleMap = {
  discovery: 'routes/discovery.ts',
  jwks: 'routes/jwks.ts',
  authorize: 'routes/authorize.ts',
  login: 'routes/login.ts',
  'login-google': 'routes/login.ts',
  consent: 'routes/consent.ts',
  token: 'routes/token.ts',
  userinfo: 'routes/userinfo.ts',
  introspection: 'routes/introspection.ts',
  revocation: 'routes/revocation.ts',
  par: 'routes/par.ts',
  register: 'routes/register.ts',
  'device-authorization': 'routes/device-authorization.ts',
  device: 'routes/device.ts',
  'backchannel-authentication': 'routes/backchannel-authentication.ts',
  ciba: 'routes/ciba-verification.ts',
  logout: 'routes/logout.ts',
};

const APP_ROUTER_LAYOUT: ModuleMap = {
  discovery: '.well-known/openid-configuration/route.ts',
  jwks: '.well-known/jwks.json/route.ts',
  authorize: 'authorize/route.ts',
  login: 'login/actions.ts',
  'login-google': 'login/google/route.ts',
  consent: 'consent/actions.ts',
  token: 'token/route.ts',
  userinfo: 'userinfo/route.ts',
  introspection: 'introspect/route.ts',
  revocation: 'revoke/route.ts',
  par: 'par/route.ts',
  register: 'register/route.ts',
  'device-authorization': 'device_authorization/route.ts',
  device: 'device/route.ts',
  'backchannel-authentication': 'backchannel_authentication/route.ts',
  ciba: 'ciba/route.ts',
  logout: 'logout/route.ts',
};

const LAYOUTS: Record<string, ModuleMap> = {
  hono: ROUTES_LAYOUT,
  express: ROUTES_LAYOUT,
  fastify: ROUTES_LAYOUT,
  nextjs: APP_ROUTER_LAYOUT,
};

/**
 * Return a copy of the flow whose endpoints and steps name the generated
 * module of the framework. An unknown framework leaves the flow untouched.
 */
export function annotateFlowModules(flow: OpFlow, framework: string): OpFlow {
  const layout = LAYOUTS[framework];
  if (layout === undefined) return flow;
  return {
    ...flow,
    endpoints: flow.endpoints.map((endpoint) => {
      const module = layout[endpoint.id];
      if (module === undefined) return endpoint;
      return {
        ...endpoint,
        module,
        steps: endpoint.steps.map((step) => ({ ...step, module })),
      };
    }),
  };
}
