import { describe, expect, it } from 'vitest';
import { collectSources } from './sources.mjs';

describe('collectSources', () => {
  it('keeps full endpoint files, exact function spans and a single source for shared frameworks', () => {
    const code = '/** docs */\nexport function parse() {\n  return 1;\n}\n';
    const card = { id: 'hono:oidc-provider/token/steps/parse.ts#parse', package: 'hono', module: 'oidc-provider/token/steps/parse.ts' };
    const overload = { id: 'core:helper.ts#helper', package: 'core', module: 'helper.ts' };
    const endpoint = () => ({ module: 'token/pipeline.ts' });
    const flows = { hono: { endpoints: [endpoint()] }, express: { endpoints: [endpoint()] }, fastify: { endpoints: [endpoint()] }, nextjs: { endpoints: [{ module: 'token/route.ts' }] } };
    const sources = collectSources({
      functions: { [card.id]: card, [overload.id]: overload }, flows,
      roots: [
        { name: 'hono', files: new Map([['oidc-provider/token/steps/parse.ts', code], ['oidc-provider/token/pipeline.ts', "import { parse } from './steps/parse';\nexport const pipeline = [parse];\n"]]) },
        { name: 'nextjs', files: new Map([['app/token/route.ts', 'export async function POST() {}\n']]) },
        { name: 'core', files: new Map([['helper.ts', '/** overloads */\nfunction helper(): void;\nfunction helper() {}\n']]) },
      ],
      directories: { hono: 'apps/hono/src', nextjs: 'apps/nextjs/src', core: 'packages/core/src' },
      frameworks: Object.fromEntries(['hono', 'express', 'fastify', 'nextjs'].map((name) => [name, name === 'nextjs' ? { source: 'nextjs', root: 'app' } : { source: 'hono', root: 'oidc-provider' }])),
      spanOf: (id) => id === card.id ? { doc: 1, start: 2, end: 4 } : { doc: 1, start: 2, end: 3 },
    });
    expect(card.source).toEqual({ file: 'hono:oidc-provider/token/steps/parse.ts', start: 1, end: 4 });
    expect(overload.source).toEqual({ file: 'core:helper.ts', start: 1, end: 3 });
    expect(sources[card.source.file]).toEqual({ path: 'apps/hono/src/oidc-provider/token/steps/parse.ts', code });
    expect(flows.express.endpoints[0].source).toBe(flows.hono.endpoints[0].source);
    expect(flows.fastify.endpoints[0].source).toBe(flows.hono.endpoints[0].source);
    expect(flows.nextjs.endpoints[0].source).toBe('nextjs:app/token/route.ts');
    expect(sources[flows.hono.endpoints[0].source].code).toContain('export const pipeline');
    expect(Object.keys(sources)).toHaveLength(4);
  });

  it('fails the build when a referenced source is missing instead of publishing a broken code button', () => {
    expect(() => collectSources({
      functions: { fn: { id: 'fn', package: 'core', module: 'missing.ts' } }, flows: {}, roots: [], directories: {}, frameworks: {}, spanOf: () => ({ start: 1, end: 2 }),
    })).toThrow('Source missing');
  });
});
