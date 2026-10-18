/**
 * Where each endpoint and step of the flow lives in the generated output of a
 * framework, so a diagram or a UI can point at the file to open.
 *
 * Hono, Express and Fastify are extracted from apps/hono: an endpoint is the
 * pipeline.ts beside its endpoint.ts (or the page that runs its steps, for a
 * screen), and a step is its own file under steps/. Next.js follows the App
 * Router layout.
 */
import { posix } from 'node:path';
import type { SourceCatalog } from '../extract/meta.js';
import { providerCatalog } from './build.js';
import type { OpFlow } from './types.js';

type ModuleMap = Record<string, string>;

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

const EXTRACTED_FRAMEWORKS = new Set(['hono', 'express', 'fastify']);

/**
 * Return a copy of the flow whose endpoints and steps name the generated
 * module of the framework. An unknown framework leaves the flow untouched.
 */
export function annotateFlowModules(flow: OpFlow, framework: string, catalog?: SourceCatalog): OpFlow {
  if (EXTRACTED_FRAMEWORKS.has(framework)) return annotateExtractedModules(flow, catalog ?? providerCatalog());
  if (framework !== 'nextjs') return flow;
  return {
    ...flow,
    endpoints: flow.endpoints.map((endpoint) => {
      const module = APP_ROUTER_LAYOUT[endpoint.id];
      if (module === undefined) return endpoint;
      return {
        ...endpoint,
        module,
        steps: endpoint.steps.map((step) => ({ ...step, module })),
      };
    }),
  };
}

function annotateExtractedModules(flow: OpFlow, catalog: SourceCatalog): OpFlow {
  return {
    ...flow,
    endpoints: flow.endpoints.map((endpoint) => {
      const definition = catalog.endpoints.find((candidate) => candidate.id === endpoint.id);
      if (definition === undefined) return endpoint;
      const directory = posix.dirname(definition.file);
      return {
        ...endpoint,
        module: endpointModule(directory, catalog),
        steps: endpoint.steps.map((step) => {
          const file = catalog.steps.find((candidate) => candidate.endpoint === endpoint.id && candidate.id === step.id)?.file;
          return file === undefined ? step : { ...step, module: file };
        }),
      };
    }),
  };
}

/** The pipeline of an endpoint directory, or the page of a screen that has none. */
function endpointModule(directory: string, catalog: SourceCatalog): string {
  const files = new Set(catalog.files);
  for (const name of ['pipeline.ts', 'page.tsx', 'page.ts']) {
    const path = `${directory}/${name}`;
    if (files.has(path)) return path;
  }
  return `${directory}/endpoint.ts`;
}
