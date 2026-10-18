/**
 * Type-check the providers the CLI generates, combination by combination.
 *
 * The apps under apps/ run with every feature on; the generator removes the
 * features a run leaves out. That a combination still compiles is checked
 * here, and only here: each combination is generated into .matrix/<name>/
 * and one `tsc --noEmit` checks them all, with the workspace packages
 * resolved to their dist/ through tsconfig paths (run `pnpm run build` at the
 * repository root first). Nothing compares the generated text.
 *
 * Combinations: the default, everything off, each feature alone (with what
 * it requires), every feature on, --db sql / --db kv, custom scopes, and two
 * --flow documents (a reordered token endpoint; every removable step left
 * out), for hono, express and fastify.
 *
 * Usage: node scripts/test-matrix.mjs   (pnpm --filter @maronn-openid-connect/cli test:matrix)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = join(packageRoot, '..', '..');
const matrixRoot = join(packageRoot, '.matrix');

const { extractProvider } = await import(join(packageRoot, 'dist/generate.js'));
const { DEFAULT_FEATURES, FEATURE_CONFIG_KEYS, FEATURE_REGISTRY, featureKeyOf } = await import(
  join(packageRoot, 'dist/registry.js')
);

const { buildOpFlow } = await import(join(packageRoot, 'dist/flow/build.js'));
const { resolveFlowSelection } = await import(join(packageRoot, 'dist/flow/flow-file.js'));

const FRAMEWORKS = ['hono', 'express', 'fastify'];

/**
 * The steps of two flow documents, checked by flow-file.ts like a --flow
 * file: the token endpoint with the subject resolved after the refresh token
 * decision, and every rearrangeable endpoint without its removable steps.
 */
function flowSteps(features) {
  const flow = buildOpFlow({ features });
  const token = flow.endpoints.find((endpoint) => endpoint.id === 'token');
  const order = token.steps.map((step) => step.id);
  const subject = order.indexOf('resolve-subject');
  const decision = order.indexOf('decide-refresh-token-issuance');
  [order[subject], order[decision]] = [order[decision], order[subject]];
  const reordered = resolveFlowSelection({
    ...flow,
    endpoints: flow.endpoints.map((endpoint) =>
      endpoint.id === 'token' ? { ...endpoint, steps: order.map((id) => ({ id })) } : endpoint,
    ),
  }).steps;
  const minimal = resolveFlowSelection({
    ...flow,
    endpoints: flow.endpoints.map((endpoint) =>
      endpoint.rearrangeable ? { ...endpoint, steps: endpoint.steps.filter((step) => !step.removable) } : endpoint,
    ),
  }).steps;
  return { reordered, minimal };
}

function allOff() {
  return Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, false]));
}

function withFeature(features, id) {
  const entry = FEATURE_REGISTRY.find((candidate) => candidate.id === id);
  const result = { ...features, [featureKeyOf(id)]: true };
  for (const required of entry.requires) Object.assign(result, withFeature(result, required));
  return result;
}

/** The combinations of one framework: name → generate options. */
function combinationsOf(framework) {
  const combinations = new Map([
    ['default', { features: { ...DEFAULT_FEATURES } }],
    ['none', { features: allOff() }],
    ['all', { features: Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, true])) }],
    ['db-sql', { features: { ...DEFAULT_FEATURES }, db: 'sql' }],
    ['db-kv', { features: { ...DEFAULT_FEATURES }, db: 'kv' }],
    ['all-db-sql', { features: Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, true])), db: 'sql' }],
    ['scopes', { features: { ...DEFAULT_FEATURES }, scopes: ['reports.read', 'reports.write'] }],
  ]);
  for (const entry of FEATURE_REGISTRY) {
    combinations.set(`only-${entry.id}`, { features: withFeature(allOff(), entry.id) });
  }
  const everything = Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, true]));
  for (const [name, features] of [['default', { ...DEFAULT_FEATURES }], ['all', everything]]) {
    const { reordered, minimal } = flowSteps(features);
    combinations.set(`flow-reordered-${name}`, { features, steps: reordered });
    combinations.set(`flow-minimal-${name}`, { features, steps: minimal });
  }
  return [...combinations].map(([name, options]) => ({ name: `${framework}-${name}`, framework, ...options }));
}

function writeFiles(directory, files) {
  for (const file of files) {
    const path = join(directory, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
}

rmSync(matrixRoot, { recursive: true, force: true });
const combinations = FRAMEWORKS.flatMap(combinationsOf);
for (const combination of combinations) {
  const files = extractProvider({
    framework: combination.framework,
    features: combination.features,
    scopes: combination.scopes ?? [],
    ...(combination.db === undefined ? {} : { db: combination.db }),
    ...(combination.steps === undefined ? {} : { steps: combination.steps }),
  });
  writeFiles(join(matrixRoot, combination.name), files);
}

const dist = (path) => join(repositoryRoot, 'packages', path);
writeFileSync(
  join(matrixRoot, 'tsconfig.json'),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: ['node'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        jsxImportSource: 'hono/jsx',
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true,
        isolatedModules: true,
        skipLibCheck: true,
        noEmit: true,
        typeRoots: [join(packageRoot, 'node_modules/@types')],
        paths: {
          '@maronn-openid-connect/core': [dist('core/dist/index.d.ts')],
          '@maronn-openid-connect/experimental/*': [dist('experimental/dist/*/index.d.ts')],
          '@maronn-openid-connect/google-login': [dist('google-login/dist/index.d.ts')],
          '@maronn-openid-connect/google-login/sign-in': [dist('google-login/dist/sign-in.d.ts')],
        },
      },
      include: ['**/*.ts', '**/*.tsx'],
    },
    null,
    2,
  )}\n`,
);

console.log(`Type-checking ${combinations.length} generated providers in ${matrixRoot} ...`);
try {
  execFileSync(join(packageRoot, 'node_modules/.bin/tsc'), ['--noEmit', '-p', join(matrixRoot, 'tsconfig.json')], {
    stdio: 'inherit',
  });
} catch {
  console.error('\nA generated combination does not compile: the errors above name its directory under .matrix/.');
  process.exit(1);
}
console.log(`All ${combinations.length} combinations compile.`);
