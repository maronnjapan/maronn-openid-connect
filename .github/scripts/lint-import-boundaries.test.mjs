import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  lintEndpointMeta,
  lintSource,
  ownerOf,
  parseImports,
  parseOwnerBlocks,
  readRequires,
} from './lint-import-boundaries.mjs';

const HONO = 'hono';
const NEXTJS = 'nextjs';
const REQUIRES = new Map([
  ['par', []],
  ['introspection', []],
  ['jwt-introspection-response', ['introspection']],
]);

const lint = (path, source, layout = HONO) => lintSource({ path, source, layout, requires: REQUIRES });
const rulesOf = (violations) => violations.map((violation) => violation.rule);

describe('ownerOf', () => {
  it('should give a file under features/<id>/ to that feature', () => {
    assert.deepEqual(ownerOf('features/par/store.ts', HONO), { kind: 'feature', id: 'par' });
  });

  it('should give a file under db/<kind>/ to that db kind', () => {
    assert.deepEqual(ownerOf('db/sql/stores.ts', HONO), { kind: 'db', id: 'sql' });
  });

  it('should give features/feature.ts and features/enabled.ts to the base', () => {
    assert.deepEqual(
      [ownerOf('features/feature.ts', HONO), ownerOf('features/enabled.ts', HONO)],
      [{ kind: 'base' }, { kind: 'base' }],
    );
  });

  it('should give db/index.ts and every other file to the base', () => {
    assert.deepEqual(
      [ownerOf('db/index.ts', HONO), ownerOf('endpoints/token/pipeline.ts', HONO)],
      [{ kind: 'base' }, { kind: 'base' }],
    );
  });

  it('should give a Next.js route group (<id>) to that feature', () => {
    assert.deepEqual(ownerOf('(par)/par/route.ts', NEXTJS), { kind: 'feature', id: 'par' });
  });

  it('should give a file under _oidc-provider/features/<id>/ to that feature in Next.js', () => {
    assert.deepEqual(ownerOf('_oidc-provider/features/jarm/response-mode.ts', NEXTJS), {
      kind: 'feature',
      id: 'jarm',
    });
  });

  it('should give _oidc-provider/features.ts to the base in Next.js', () => {
    assert.deepEqual(ownerOf('_oidc-provider/features.ts', NEXTJS), { kind: 'base' });
  });
});

describe('parseImports', () => {
  it('should read the local names and the lines of a multi-line named import', () => {
    const imports = parseImports(
      ["import {", "  a,", "  b as c,", "  type D,", "} from './x.js';", ''].join('\n'),
    );

    assert.deepEqual(imports, [{ specifier: './x.js', names: ['a', 'c', 'D'], line: 1, endLine: 5 }]);
  });

  it('should read default, namespace and side-effect imports', () => {
    const imports = parseImports(
      ["import x from 'x';", "import * as y from 'y';", "import './z.js';", ''].join('\n'),
    );

    assert.deepEqual(imports, [
      { specifier: 'x', names: ['x'], line: 1, endLine: 1 },
      { specifier: 'y', names: ['y'], line: 2, endLine: 2 },
      { specifier: './z.js', names: [], line: 3, endLine: 3 },
    ]);
  });

  it('should read a re-export as an import without local names', () => {
    const imports = parseImports("export { a } from './a.js';\n");

    assert.deepEqual(imports, [{ specifier: './a.js', names: [], line: 1, endLine: 1 }]);
  });
});

describe('parseOwnerBlocks', () => {
  it('should split a pipeline into the blocks of its markers, with their features', () => {
    const source = [
      'export async function run(c) {',
      '  try {',
      '    // [parse-request] Parse',
      '    const params = await parse(c);',
      '',
      '    // [resolve-pushed-request] (feature: par) Expand',
      '    const expanded = await expand(c, params);',
      '',
      '    // [respond] Respond',
      '    return respond(c, expanded);',
      '  } catch (error) {',
      '    return fail(c, error);',
      '  }',
      '}',
      '',
    ].join('\n');

    assert.deepEqual(parseOwnerBlocks(source), [
      { id: 'parse-request', feature: undefined, startLine: 3, endLine: 5 },
      { id: 'resolve-pushed-request', feature: 'par', startLine: 6, endLine: 8 },
      { id: 'respond', feature: undefined, startLine: 9, endLine: 10 },
    ]);
  });
});

describe('readRequires', () => {
  it('should read the requires of every registry entry', () => {
    const registry = [
      "  { id: 'introspection', tier: 'stable', requires: [], packages: [] },",
      "  { id: 'jwt-introspection-response', tier: 'experimental', requires: ['introspection'], packages: [] },",
      '',
    ].join('\n');

    assert.deepEqual(
      readRequires(registry),
      new Map([
        ['introspection', []],
        ['jwt-introspection-response', ['introspection']],
      ]),
    );
  });
});

describe('lintSource', () => {
  describe('base', () => {
    it('should accept a base file that imports the hook plumbing of features/', () => {
      const source = [
        "import { features } from '../../features/enabled.js';",
        "import { tokenGrantsOf } from '../../features/feature.js';",
        '',
      ].join('\n');

      assert.deepEqual(lint('endpoints/token/steps/validate-grant-type.ts', source), []);
    });

    it('should accept features/enabled.ts importing the feature.ts of each feature', () => {
      const source = [
        "import type { Feature } from './feature.js';",
        "import { par } from './par/feature.js';",
        '',
      ].join('\n');

      assert.deepEqual(lint('features/enabled.ts', source), []);
    });

    it('should reject features/enabled.ts importing anything else of a feature', () => {
      const source = "import { parStore } from './par/store.js';\n";

      assert.deepEqual(rulesOf(lint('features/enabled.ts', source)), ['base-imports-feature']);
    });

    it('should reject a base file that imports a feature directory', () => {
      const source = "import { parStore } from '../../../features/par/store.js';\n";

      assert.deepEqual(rulesOf(lint('endpoints/authorize/steps/parse-request.ts', source)), [
        'base-imports-feature',
      ]);
    });

    it('should reject a base file that imports the experimental package', () => {
      const source = "import { PAR } from '@maronn-openid-connect/experimental/par';\n";

      assert.deepEqual(rulesOf(lint('config.ts', source)), ['base-imports-experimental']);
    });

    it('should reject a base file that imports the google-login package', () => {
      const source = "import { x } from '@maronn-openid-connect/google-login';\n";

      assert.deepEqual(rulesOf(lint('views.tsx', source)), ['base-imports-experimental']);
    });

    it('should reject a base file that imports one db kind instead of db/index', () => {
      const source = "import { createDatabase } from './db/memory/index.js';\n";

      assert.deepEqual(rulesOf(lint('app.ts', source)), ['base-imports-db-kind']);
    });

    it('should accept db/index.ts re-exporting the db kind it is rendered with', () => {
      assert.deepEqual(lint('db/index.ts', "export * from './memory/index.js';\n"), []);
    });
  });

  describe('features', () => {
    it('should accept a feature that imports a feature it requires', () => {
      const source = "import { respondIntrospection } from '../../introspection/endpoints/introspection/steps/respond.js';\n";

      assert.deepEqual(lint('features/jwt-introspection-response/steps/sign-response.ts', source), []);
    });

    it('should reject a feature that imports a feature it does not require', () => {
      const source = "import { parStore } from '../par/store.js';\n";

      assert.deepEqual(rulesOf(lint('features/introspection/feature.ts', source)), [
        'feature-imports-unrequired-feature',
      ]);
    });

    it('should accept a feature that imports the base and the experimental package', () => {
      const source = [
        "import { step } from '../../../endpoints/step.js';",
        "import { PAR } from '@maronn-openid-connect/experimental/par';",
        '',
      ].join('\n');

      assert.deepEqual(lint('features/par/steps/resolve-pushed-request.ts', source), []);
    });
  });

  describe('db', () => {
    it('should reject a db kind that imports a feature', () => {
      const source = "import { parStore } from '../../features/par/store.js';\n";

      assert.deepEqual(rulesOf(lint('db/kv/stores.ts', source)), ['db-imports-feature']);
    });

    it('should reject a db kind that imports another db kind', () => {
      const source = "import { hashPassword } from '../sql/users.js';\n";

      assert.deepEqual(rulesOf(lint('db/kv/users.ts', source)), ['db-imports-other-db']);
    });
  });

  describe('pipeline', () => {
    const pipeline = (blocks, imports) =>
      [
        ...imports,
        '',
        'export async function run(c) {',
        '  try {',
        ...blocks,
        '  } catch (error) {',
        '    return fail(c, error);',
        '  }',
        '}',
        '',
      ].join('\n');

    it('should accept a feature import used only in the block of that feature', () => {
      const source = pipeline(
        [
          '    // [parse-request] Parse',
          '    const params = await parse(c);',
          '    // [resolve-pushed-request] (feature: par) Expand',
          '    const expanded = await expand(c, params);',
          '    // [respond] Respond',
          '    return respond(c, expanded);',
        ],
        [
          "import { expand } from '../../features/par/steps/resolve-pushed-request.js';",
          "import { fail } from './steps/respond-error.js';",
          "import { parse } from './steps/parse-request.js';",
          "import { respond } from './steps/respond.js';",
        ],
      );

      assert.deepEqual(lint('endpoints/authorize/pipeline.ts', source), []);
    });

    it('should reject a feature import used outside the block of that feature', () => {
      const source = pipeline(
        [
          '    // [parse-request] Parse',
          '    const params = await expand(c, await parse(c));',
          '    // [respond] Respond',
          '    return respond(c, params);',
        ],
        [
          "import { expand } from '../../features/par/steps/resolve-pushed-request.js';",
          "import { fail } from './steps/respond-error.js';",
          "import { parse } from './steps/parse-request.js';",
          "import { respond } from './steps/respond.js';",
        ],
      );

      assert.deepEqual(rulesOf(lint('endpoints/authorize/pipeline.ts', source)), [
        'feature-import-outside-its-block',
      ]);
    });

    it('should reject a feature block that calls a base step', () => {
      const source = pipeline(
        [
          '    // [resolve-pushed-request] (feature: par) Expand',
          '    const params = await parse(c);',
          '    // [respond] Respond',
          '    return respond(c, params);',
        ],
        [
          "import { fail } from './steps/respond-error.js';",
          "import { parse } from './steps/parse-request.js';",
          "import { respond } from './steps/respond.js';",
        ],
      );

      assert.deepEqual(rulesOf(lint('endpoints/authorize/pipeline.ts', source)), [
        'feature-block-uses-base-import',
      ]);
    });

    it('should reject a pipeline that imports a core function', () => {
      const source = pipeline(
        ['    // [respond] Respond', '    return respond(c, sanitize(c));'],
        [
          "import { sanitize } from '@maronn-openid-connect/core';",
          "import { fail } from './steps/respond-error.js';",
          "import { respond } from './steps/respond.js';",
        ],
      );

      assert.deepEqual(rulesOf(lint('endpoints/token/pipeline.ts', source)), ['pipeline-import-not-allowed']);
    });

    it('should accept a feature pipeline holding the owner block of another feature', () => {
      const source = pipeline(
        [
          '    // [build-response] Build',
          '    const response = await build(c);',
          '    // [sign-response] (feature: jwt-introspection-response) Sign',
          '    const signed = await sign(c, response);',
          '    if (signed) return signed;',
          '    // [respond] Respond',
          '    return respond(c, response);',
        ],
        [
          "import { sign } from '../../../jwt-introspection-response/steps/sign-response.js';",
          "import { build } from './steps/build-response.js';",
          "import { fail } from './steps/respond-error.js';",
          "import { respond } from './steps/respond.js';",
        ],
      );

      assert.deepEqual(lint('features/introspection/endpoints/introspection/pipeline.ts', source), []);
    });

    it('should accept the framework and the modules beside the pipeline', () => {
      const source = [
        "import { Hono } from 'hono';",
        "import type { Outcome } from './outcome.js';",
        "import { respond } from './steps/respond.js';",
        '',
        'export const app = new Hono();',
        'app.get("/", (c) => {',
        '  // [respond] Respond',
        '  return respond(c) as Outcome;',
        '});',
        '',
      ].join('\n');

      assert.deepEqual(lint('endpoints/jwks/pipeline.ts', source), []);
    });
  });

  describe('Next.js route handler', () => {
    const route = (blocks, imports) =>
      [
        ...imports,
        '',
        'export async function POST(request) {',
        '  try {',
        ...blocks,
        '  } catch (error) {',
        '    return oauthError(error);',
        '  }',
        '}',
        '',
      ].join('\n');

    it('should accept a route.ts importing core and the base modules, as App Router code does', () => {
      const source = route(
        [
          '    // [validate-grant-type] Validate grant_type',
          '    const grantType = validateGrantTypeSupported(await request.text());',
          '    // [dispatch-ciba] (feature: ciba) Redeem an auth_req_id',
          '    const answered = await dispatchCiba(grantType, stores);',
          '    if (answered) return answered;',
          '    // [respond] Respond',
          '    return noStoreJson(grantType);',
        ],
        [
          "import { validateGrantTypeSupported } from '@maronn-openid-connect/core';",
          "import { dispatchCiba } from '../_oidc-provider/features/ciba/grant';",
          "import { noStoreJson, oauthError } from '../_oidc-provider/http';",
          "import { stores } from '../_oidc-provider/provider';",
        ],
      );

      assert.deepEqual(lint('token/route.ts', source, NEXTJS), []);
    });

    it('should reject a feature import used outside the block of that feature in a route.ts', () => {
      const source = route(
        ['    // [respond] Respond', '    return (await dispatchCiba(request)) ?? oauthError(request);'],
        [
          "import { dispatchCiba } from '../_oidc-provider/features/ciba/grant';",
          "import { oauthError } from '../_oidc-provider/http';",
        ],
      );

      assert.deepEqual(rulesOf(lint('token/route.ts', source, NEXTJS)), ['feature-import-outside-its-block']);
    });

    it('should not count the names of a multi-line import as a use outside the blocks', () => {
      const source = route(
        [
          '    // [validate-refresh-token-grant] (feature: refresh-token) Validate',
          '    const refreshed = await validateRefreshTokenGrant(request);',
          '    // [issue-refresh-token] (feature: refresh-token) Issue',
          '    const token = await issueRefreshToken(refreshed);',
          '    // [respond] Respond',
          '    return oauthError(token);',
        ],
        [
          'import {',
          '  issueRefreshToken,',
          '  validateRefreshTokenGrant,',
          "} from '../_oidc-provider/features/refresh-token/token';",
          "import { oauthError } from '../_oidc-provider/http';",
        ],
      );

      assert.deepEqual(lint('token/route.ts', source, NEXTJS), []);
    });

    it('should accept _oidc-provider/features.ts importing the extensionless feature.ts of each feature', () => {
      const source = "import { par } from './features/par/feature';\n\nexport const features = [\n  par,\n];\n";

      assert.deepEqual(lint('_oidc-provider/features.ts', source, NEXTJS), []);
    });
  });

  it('should skip test files', () => {
    const source = "import { parStore } from '../../features/par/store.js';\n";

    assert.deepEqual(lint('endpoints/authorize/steps/parse-request.test.ts', source), []);
  });
});

describe('lintEndpointMeta', () => {
  const routeSource = [
    'export async function POST(request) {',
    '  // [parse-request] Parse',
    '  const params = await request.text();',
    '  // [dispatch-ciba] (feature: ciba) Redeem',
    '  const answered = await dispatchCiba(params);',
    '  // [respond] Respond',
    '  return answered;',
    '}',
    '',
  ].join('\n');
  const endpointSource = (steps) => ['export const endpoint = defineEndpoint({', "  path: '/token',", '  steps: [', ...steps, '  ],', '});', ''].join('\n');

  it('should accept an endpoint.ts that lists the markers of its route.ts in order', () => {
    const steps = endpointSource([
      "    { id: 'parse-request', consumes: [], produces: ['params'] },",
      "    { id: 'dispatch-ciba', feature: 'ciba', consumes: ['params'], produces: [] },",
      "    { id: 'respond', consumes: [], produces: [] },",
    ]);

    assert.deepEqual(lintEndpointMeta({ path: 'token/route.ts', routeSource, endpointSource: steps }), []);
  });

  it('should reject an endpoint.ts whose steps differ from the markers', () => {
    const steps = endpointSource([
      "    { id: 'parse-request', consumes: [], produces: ['params'] },",
      "    { id: 'dispatch-ciba', consumes: ['params'], produces: [] },",
      "    { id: 'respond', consumes: [], produces: [] },",
    ]);

    assert.deepEqual(rulesOf(lintEndpointMeta({ path: 'token/route.ts', routeSource, endpointSource: steps })), [
      'endpoint-meta-mismatch',
    ]);
  });

  it('should reject a route.ts with markers and no endpoint.ts beside it', () => {
    assert.deepEqual(rulesOf(lintEndpointMeta({ path: 'token/route.ts', routeSource, endpointSource: undefined })), [
      'endpoint-meta-missing',
    ]);
  });

  it('should accept a route.ts without markers and without endpoint.ts', () => {
    assert.deepEqual(
      lintEndpointMeta({ path: 'jwks/route.ts', routeSource: 'export function GET() {}\n', endpointSource: undefined }),
      [],
    );
  });
});
