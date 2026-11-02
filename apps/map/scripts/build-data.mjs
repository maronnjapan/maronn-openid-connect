/**
 * The data of the map: what `maronn-oidc explain <framework> --format json`
 * prints with every feature on, for every framework, with the function cards
 * merged into one catalog. Written to public/data/map.json, which the page
 * fetches.
 *
 * Reads the built CLI (packages/cli/dist), so run
 * `pnpm --filter @maronn-openid-connect/cli build` first (pnpm run build:map
 * at the root does both).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(appRoot, '../../packages/cli/dist');
if (!existsSync(join(dist, 'index.js'))) {
  console.error('packages/cli is not built: run pnpm --filter @maronn-openid-connect/cli build first');
  process.exit(1);
}
const load = (file) => import(pathToFileURL(join(dist, file)).href);
const { buildOpFlow } = await load('flow/build.js');
const { annotateFlowModules } = await load('flow/modules.js');
const { buildOpMap } = await load('explain/map.js');
const { readFunctionCatalog } = await load('extract/templates.js');
const { FEATURE_CONFIG_KEYS } = await load('registry.js');
const { getAvailableFrameworks } = await load('generator.js');

const features = Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, true]));
const catalog = readFunctionCatalog();
const frameworks = getAvailableFrameworks();
const flows = {};
const functions = {};
let shared;
for (const framework of frameworks) {
  const flow = annotateFlowModules(buildOpFlow({ features }), framework);
  const map = buildOpMap({ flow, framework, functions: catalog, frameworks });
  flows[framework] = map.flow;
  Object.assign(functions, map.functions);
  shared ??= { commands: map.commands, features: map.features };
}
// The callers of a card may be outside the reach of the steps (a Route Handler of
// Next.js); keep those cards too, so the page can climb to them.
for (const card of Object.values(functions)) {
  for (const id of card.calledBy) {
    if (functions[id] === undefined && catalog.functions[id]) functions[id] = catalog.functions[id];
  }
}
const data = {
  version: 2,
  frameworks,
  commands: shared.commands,
  features: shared.features,
  flows,
  functions: Object.fromEntries(Object.entries(functions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
};
const out = join(appRoot, 'public', 'data', 'map.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
const steps = Object.values(flows).reduce((n, flow) => n + flow.endpoints.reduce((m, e) => m + e.steps.length, 0), 0);
console.log(`Wrote ${out}: ${frameworks.length} frameworks, ${steps} steps, ${Object.keys(functions).length} functions`);
