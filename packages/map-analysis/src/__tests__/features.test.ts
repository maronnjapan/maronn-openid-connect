import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCli, type Cli } from '../cli.js';
import { featureOfPath, sourceFeatureRanges } from '../features.js';

let cli: Cli;
beforeAll(async () => {
  cli = await loadCli(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../cli/dist'));
});

describe('feature ownership', () => {
  it('should recognize provider and library implementations without marking shared code', () => {
    for (const path of [
      'apps/hono/src/oidc-provider/features/par/endpoints/par/pipeline.ts',
      'apps/nextjs/src/app/_oidc-provider/features/par/config.ts',
      'apps/nextjs/src/app/(par)/par/route.ts',
      'packages/experimental/src/par/validate.ts',
    ]) expect(featureOfPath(path, cli.features)).toBe('par');
    for (const path of [
      'apps/hono/src/oidc-provider/endpoints/authorize/pipeline.ts',
      'packages/core/src/client-auth.ts',
      'apps/hono/src/oidc-provider/features/not-registered/file.ts',
      'tests/e2e/specs/pushed-authorization-requests.spec.ts',
    ]) expect(featureOfPath(path, cli.features)).toBeUndefined();
  });

  it('should use exactly the blocks removed by the generator, ending before the next marker or closing brace', () => {
    const code = [
      'function handler() {',
      '  // [resolve-par] (feature: par) Resolve PAR',
      '  const request = resolvePar();',
      '',
      '  // [validate] Validate base request',
      '  validate(request);',
      '  // [enforce-par] (feature: par) Enforce PAR',
      '  enforcePar();',
      '}',
      'base();',
    ].join('\n');
    const ranges = sourceFeatureRanges('apps/nextjs/src/app/authorize/route.ts', code, cli.features, cli.parseOwnerBlocks);
    expect(ranges).toEqual([{ feature: 'par', lines: [2, 3] }, { feature: 'par', lines: [7, 8] }]);
    expect(ranges.flatMap((range) => code.split('\n').slice(range.lines[0] - 1, range.lines[1]))).not.toContain('  validate(request);');
  });

  it('should mark the whole owned file while leaving the surrounding shared file unowned', () => {
    const code = '// helper\nexport function validate() {}';
    expect(sourceFeatureRanges('packages/experimental/src/par/validate.ts', code, cli.features, cli.parseOwnerBlocks)).toEqual([{ feature: 'par', lines: [1, 2] }]);
    expect(sourceFeatureRanges('packages/experimental/src/par/validate.ts', `${code}\n`, cli.features, cli.parseOwnerBlocks)).toEqual([{ feature: 'par', lines: [1, 2] }]);
    expect(sourceFeatureRanges('packages/experimental/src/par/empty.ts', '', cli.features, cli.parseOwnerBlocks)).toEqual([]);
    expect(sourceFeatureRanges('packages/core/src/client-auth.ts', code, cli.features, cli.parseOwnerBlocks)).toEqual([]);
    expect(sourceFeatureRanges('apps/nextjs/src/app/par/route.ts', code, cli.features, cli.parseOwnerBlocks, 'par')).toEqual([{ feature: 'par', lines: [1, 2] }]);
  });
});
