import { describe, it, expect } from 'vitest';
import { generate, getAvailableFrameworks } from '../generator.js';
import { DEFAULT_FEATURES } from '../registry.js';
import type { OidcFeatureConfig } from '../registry.js';
import { readExtractionDefinition, readSourceFiles } from '../extract/templates.js';

/** Every feature enabled, so the generated code holds every file it can. */
const EVERY_FEATURE = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map((key) => [key, true])) as unknown as OidcFeatureConfig;

/**
 * The measurement of the tests (packages/test-reach) is started by
 * apps/hono/src/server.ts and apps/nextjs/src/instrumentation.ts when
 * MARONN_REACH is 1. Both are outside the roots extract.json copies, so the
 * package must never reach templates/ nor the code `maronn-oidc generate`
 * writes.
 */
describe('readSourceFiles', () => {
  it('should copy no file that names test-reach into the templates', () => {
    const definition = readExtractionDefinition();
    const naming = Object.keys(definition.sources).flatMap((name) =>
      [...readSourceFiles(name, definition)]
        .filter(([, content]) => content.includes('test-reach'))
        .map(([path]) => `${name}/${path}`),
    );
    expect(naming).toEqual([]);
  });

  it('should leave out the files that start the measurement of the tests', () => {
    const definition = readExtractionDefinition();
    const paths = Object.keys(definition.sources).flatMap((name) => [...readSourceFiles(name, definition).keys()]);
    expect(paths.filter((path) => /(^|\/)(server|instrumentation)\.ts$/.test(path))).toEqual([]);
  });
});

describe('generate', () => {
  it('should write no file that names test-reach for any framework, database or feature set', () => {
    const naming = getAvailableFrameworks().flatMap((framework) =>
      (['sql', 'kv'] as const).flatMap((db) =>
        [DEFAULT_FEATURES, EVERY_FEATURE].flatMap((features) =>
          generate({ framework, outputDir: 'out', features, db })
            .files.filter((file) => file.content.includes('test-reach'))
            .map((file) => `${framework}/${db}/${file.path}`),
        ),
      ),
    );
    expect(naming).toEqual([]);
  });
});
