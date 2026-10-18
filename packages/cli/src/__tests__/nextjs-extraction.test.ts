import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES } from '../registry.js';
import { extractProvider } from '../generate.js';
import type { ExtractionDefinition } from '../extract/templates.js';

/**
 * A tiny app in the layout of apps/nextjs: a token route with a step of the
 * refresh-token feature, a route group of the par feature, a feature
 * directory, the feature list and two db kinds.
 */
const DEFINITION: ExtractionDefinition = {
  sources: { app: { directory: 'unused', include: ['app'], exclude: [] } },
  frameworks: {
    nextjs: { source: 'app', root: 'app', layout: 'nextjs', files: {} },
  },
};

const ROUTE = [
  "import { validateRefreshTokenGrant } from '../_oidc-provider/features/refresh-token/token';",
  "import { noStoreJson } from '../_oidc-provider/http';",
  '',
  'export async function POST(request: Request): Promise<Response> {',
  '  // [parse-request] Parse the token request',
  '  const params = await request.text();',
  '',
  '  // [validate-refresh-token-grant] (feature: refresh-token) Validate the refresh_token grant',
  '  const refreshTokenRequest = await validateRefreshTokenGrant(params);',
  '',
  '  // [respond] Respond',
  '  return noStoreJson(refreshTokenRequest ?? params);',
  '}',
  '',
].join('\n');

const ENDPOINT = [
  "import { defineEndpoint } from '../_oidc-provider/endpoint';",
  '',
  'export const endpoint = defineEndpoint({',
  "  path: '/token',",
  '  steps: [',
  "    { id: 'parse-request', consumes: [], produces: ['params'] },",
  "    { id: 'validate-refresh-token-grant', feature: 'refresh-token', consumes: ['params'], produces: ['refreshTokenRequest'] },",
  "    { id: 'respond', consumes: ['refreshTokenRequest', 'params'], produces: [] },",
  '  ],',
  '});',
  '',
].join('\n');

const FEATURES = [
  "import type { Feature } from './feature';",
  "import { refreshToken } from './features/refresh-token/feature';",
  "import { par } from './features/par/feature';",
  '',
  'export const features: readonly Feature[] = [',
  '  refreshToken,',
  '  par,',
  '];',
  '',
].join('\n');

const SOURCE = new Map<string, string>([
  ['app/token/route.ts', ROUTE],
  ['app/token/endpoint.ts', ENDPOINT],
  ['app/(par)/par/route.ts', 'export function POST(): Response { return new Response(); }\n'],
  ['app/_oidc-provider/endpoint.ts', 'export function defineEndpoint<E>(endpoint: E): E { return endpoint; }\n'],
  ['app/_oidc-provider/http.ts', 'export function noStoreJson(value: unknown): Response { return Response.json(value); }\n'],
  ['app/_oidc-provider/feature.ts', 'export interface Feature { id: string }\n'],
  ['app/_oidc-provider/features.ts', FEATURES],
  ['app/_oidc-provider/features/refresh-token/feature.ts', "export const refreshToken = { id: 'refresh-token' };\n"],
  ['app/_oidc-provider/features/refresh-token/token.ts', 'export async function validateRefreshTokenGrant(params: string) { return params; }\n'],
  ['app/_oidc-provider/features/par/feature.ts', "export const par = { id: 'par' };\n"],
  ['app/_oidc-provider/scopes.ts', 'export const CUSTOM_SCOPES: readonly string[] = [];\n'],
  ['app/_oidc-provider/db/index.ts', "export * from './kv/index';\n"],
  ['app/_oidc-provider/db/kv/index.ts', "export { createDatabase } from './instance';\n"],
  ['app/_oidc-provider/db/kv/instance.ts', 'export function createDatabase() { return {}; }\n'],
  ['app/_oidc-provider/db/sql/index.ts', 'export const kind = 2;\n'],
]);

function generateDemo(options: { refreshToken: boolean; par: boolean; db?: 'sql' | 'kv'; scopes?: string[] }) {
  const files = extractProvider({
    framework: 'nextjs',
    features: { ...DEFAULT_FEATURES, refreshToken: options.refreshToken, par: options.par },
    scopes: options.scopes ?? [],
    ...(options.db === undefined ? {} : { db: options.db }),
    definition: DEFINITION,
    sourceFiles: SOURCE,
  });
  return new Map(files.map((file) => [file.path, file]));
}

describe('extractProvider for Next.js', () => {
  it('should keep the route group and the directory of an enabled feature', () => {
    const paths = [...generateDemo({ refreshToken: true, par: true, db: 'kv' }).keys()];

    expect(paths.filter((path) => path.includes('par'))).toEqual([
      '_oidc-provider/features/par/feature.ts',
      '(par)/par/route.ts',
    ]);
  });

  it('should leave out the route group and the directory of a disabled feature', () => {
    const paths = [...generateDemo({ refreshToken: true, par: false, db: 'kv' }).keys()];

    expect(paths.filter((path) => path.includes('par'))).toEqual([]);
  });

  it('should list only the enabled features in _oidc-provider/features.ts', () => {
    expect(generateDemo({ refreshToken: true, par: false, db: 'kv' }).get('_oidc-provider/features.ts')?.content).toBe(
      [
        "import type { Feature } from './feature';",
        "import { refreshToken } from './features/refresh-token/feature';",
        '',
        'export const features: readonly Feature[] = [',
        '  refreshToken,',
        '];',
        '',
      ].join('\n'),
    );
  });

  it('should keep the owner block of an enabled feature in a route.ts', () => {
    expect(generateDemo({ refreshToken: true, par: true, db: 'kv' }).get('token/route.ts')?.content).toBe(ROUTE);
  });

  it('should remove the owner block of a disabled feature and leave the value a later step reads undefined', () => {
    expect(generateDemo({ refreshToken: false, par: true, db: 'kv' }).get('token/route.ts')?.content).toBe(
      [
        "import { noStoreJson } from '../_oidc-provider/http';",
        '',
        'export async function POST(request: Request): Promise<Response> {',
        '  // [parse-request] Parse the token request',
        '  const params = await request.text();',
        '',
        '  const refreshTokenRequest = undefined;',
        '',
        '  // [respond] Respond',
        '  return noStoreJson(refreshTokenRequest ?? params);',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('should leave the steps of a disabled feature out of endpoint.ts', () => {
    expect(generateDemo({ refreshToken: false, par: true, db: 'kv' }).get('token/endpoint.ts')?.content).toBe(
      ENDPOINT.split('\n').filter((line) => !line.includes("feature: 'refresh-token'")).join('\n'),
    );
  });

  it('should move the files of the db kind into _oidc-provider/db/ in place of its index.ts', () => {
    const generated = generateDemo({ refreshToken: true, par: true, db: 'kv' });

    expect([...generated.keys()].filter((path) => path.startsWith('_oidc-provider/db/'))).toEqual([
      '_oidc-provider/db/index.ts',
      '_oidc-provider/db/instance.ts',
    ]);
    expect(generated.get('_oidc-provider/db/instance.ts')?.userOwned).toBe(true);
  });

  it('should write the --scope values into CUSTOM_SCOPES of _oidc-provider/scopes.ts', () => {
    expect(generateDemo({ refreshToken: true, par: true, db: 'kv', scopes: ['reports.read'] }).get('_oidc-provider/scopes.ts')?.content).toBe(
      "export const CUSTOM_SCOPES: readonly string[] = ['reports.read'];\n",
    );
  });
});
