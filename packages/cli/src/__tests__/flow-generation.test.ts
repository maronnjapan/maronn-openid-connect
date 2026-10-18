import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES } from '../registry.js';
import { generate } from '../generator.js';
import { extractProvider } from '../generate.js';
import type { ExtractionDefinition } from '../extract/templates.js';

/**
 * A tiny app in the layout of apps/hono, to see what the generator does with
 * a pipeline: one endpoint with three base steps and one step of the par
 * feature between them.
 */
const DEFINITION: ExtractionDefinition = {
  sources: { app: { directory: 'unused', include: ['provider'], exclude: [] } },
  frameworks: {
    hono: { source: 'app', root: 'provider', layout: 'hono', files: {} },
  },
};

function stepFile(id: string, consumes: string[], produces: string[], extra = ''): string {
  const list = (names: string[]) => names.map((name) => `'${name}'`).join(', ');
  return `export const meta = step({ id: '${id}', endpoint: 'demo', kind: 'resolve', label: '${id}', function: '${id}', consumes: [${list(consumes)}], produces: [${list(produces)}], removable: true${extra} });\n`;
}

const PIPELINE = [
  "import { expand } from '../../features/par/steps/expand.js';",
  "import { first } from './steps/first.js';",
  "import { second } from './steps/second.js';",
  "import { third } from './steps/third.js';",
  '',
  'export async function run(c: unknown) {',
  '  // [first] First',
  '  const value = first(c);',
  '',
  '  // [expand] (feature: par) Expand',
  '  const expanded = expand(value);',
  '',
  '  // [second] Second',
  '  const other = second(value, expanded);',
  '',
  '  // [third] Third',
  '  return third(other);',
  '}',
  '',
].join('\n');

const SOURCE = new Map<string, string>([
  ['provider/endpoints/demo/pipeline.ts', PIPELINE],
  [
    'provider/endpoints/demo/endpoint.ts',
    "export const endpoint = defineEndpoint({ id: 'demo', order: 10, label: 'Demo', path: '/demo', methods: ['GET'], layer: 'api', group: { id: 'demo', label: 'Demo' }, rearrangeable: true, steps: ['first', 'expand', 'second', 'third'], edges: { chain: true } });\n",
  ],
  ['provider/endpoints/demo/steps/first.ts', stepFile('first', [], ['value'])],
  ['provider/endpoints/demo/steps/second.ts', stepFile('second', ['value', 'expanded'], ['other'], ", optional: ['expanded']")],
  ['provider/endpoints/demo/steps/third.ts', stepFile('third', ['other'], [])],
  ['provider/features/par/steps/expand.ts', stepFile('expand', ['value'], ['expanded'], ", feature: 'par'")],
  ['provider/features/enabled.ts', "import { par } from './par/feature.js';\n\nexport const features = [\n  par,\n];\n"],
  ['provider/features/par/feature.ts', 'export const par = {};\n'],
  ['provider/scopes.ts', 'export const CUSTOM_SCOPES: readonly string[] = [];\n'],
  ['provider/db/index.ts', "export * from './memory/index.js';\n"],
  ['provider/db/memory/index.ts', 'export const kind = 1;\n'],
]);

function generateDemo(options: { par: boolean; scopes?: string[]; steps?: Record<string, string[]> }) {
  const files = extractProvider({
    framework: 'hono',
    features: { ...DEFAULT_FEATURES, par: options.par },
    scopes: options.scopes ?? [],
    ...(options.steps === undefined ? {} : { steps: options.steps }),
    definition: DEFINITION,
    sourceFiles: SOURCE,
  });
  return new Map(files.map((file) => [file.path, file.content]));
}

describe('extractProvider', () => {
  describe('features', () => {
    it('should keep the owner block of an enabled feature', () => {
      expect(generateDemo({ par: true }).get('endpoints/demo/pipeline.ts')).toBe(PIPELINE);
    });

    it('should remove the owner block and the import of a disabled feature and leave its value undefined', () => {
      expect(generateDemo({ par: false }).get('endpoints/demo/pipeline.ts')).toBe(
        [
          "import { first } from './steps/first.js';",
          "import { second } from './steps/second.js';",
          "import { third } from './steps/third.js';",
          '',
          'export async function run(c: unknown) {',
          '  // [first] First',
          '  const value = first(c);',
          '',
          '  const expanded = undefined;',
          '',
          '  // [second] Second',
          '  const other = second(value, expanded);',
          '',
          '  // [third] Third',
          '  return third(other);',
          '}',
          '',
        ].join('\n'),
      );
    });

    it('should leave out the directory of a disabled feature', () => {
      const paths = [...generateDemo({ par: false }).keys()];
      expect(paths.filter((path) => path.startsWith('features/par/'))).toEqual([]);
    });

    it('should list only the enabled features in features/enabled.ts', () => {
      expect(generateDemo({ par: false }).get('features/enabled.ts')).toBe('\nexport const features = [\n];\n');
    });
  });

  describe('custom scopes', () => {
    it('should write the --scope values into CUSTOM_SCOPES', () => {
      expect(generateDemo({ par: true, scopes: ['reports.read', 'reports.write'] }).get('scopes.ts')).toBe(
        "export const CUSTOM_SCOPES: readonly string[] = ['reports.read', 'reports.write'];\n",
      );
    });
  });

  describe('db', () => {
    it('should move the files of the db kind into db/ in place of db/index.ts', () => {
      const generated = generateDemo({ par: true });
      expect([...generated.keys()].filter((path) => path.startsWith('db/'))).toEqual(['db/index.ts']);
      expect(generated.get('db/index.ts')).toBe('export const kind = 1;\n');
    });
  });

  describe('flow steps', () => {
    it('should put the owner blocks in the order of the flow document', () => {
      const pipeline = generateDemo({ par: true, steps: { demo: ['first', 'second', 'expand', 'third'] } }).get(
        'endpoints/demo/pipeline.ts',
      );
      expect(pipeline?.split('\n').filter((line) => line.includes('// ['))).toEqual([
        '  // [first] First',
        '  // [second] Second',
        '  // [expand] (feature: par) Expand',
        '  // [third] Third',
      ]);
    });

    it('should remove a step the flow document leaves out, with its import and its step file', () => {
      const generated = generateDemo({ par: true, steps: { demo: ['first', 'second', 'third'] } });
      const pipeline = generated.get('endpoints/demo/pipeline.ts') ?? '';
      expect(pipeline.includes('// [expand]')).toBe(false);
      expect(pipeline.includes("from '../../features/par/steps/expand.js'")).toBe(false);
      expect(generated.has('features/par/steps/expand.ts')).toBe(false);
    });
  });
});

describe('generate', () => {
  it('should refuse a rearranged step order for the Next.js output', () => {
    expect(() =>
      generate({
        framework: 'nextjs',
        outputDir: 'out',
        features: DEFAULT_FEATURES,
        steps: { token: ['parse-request'] },
      }),
    ).toThrow(
      'The Next.js output does not follow a rearranged step order yet (endpoint "token"). ' +
        'Remove the steps changes from the flow document, or generate for hono, express or fastify',
    );
  });
});
