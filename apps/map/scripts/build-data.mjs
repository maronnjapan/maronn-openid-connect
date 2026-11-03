/**
 * The data of the map: what `maronn-oidc explain <framework> --format json`
 * prints with every feature on, for every framework, with every function of
 * the catalog (each with the flow of its body, see
 * packages/cli/src/extract/function-flow.ts) and the descriptions of the
 * methods of resolvers and stores the code calls (`consentResolver.recordConsent`).
 * Written to public/data/map.json, which the page fetches.
 *
 * Reads the built CLI (packages/cli/dist) and the sources of the repository,
 * so run `pnpm --filter @maronn-openid-connect/cli build` first
 * (pnpm run build:map at the root does both).
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
const { buildOpFlow, edgesForSteps } = await load('flow/build.js');
const { annotateFlowModules } = await load('flow/modules.js');
const { buildOpMap } = await load('explain/map.js');
const { functionProject } = await load('extract/templates.js');
const { FEATURE_CONFIG_KEYS } = await load('registry.js');
const { getAvailableFrameworks } = await load('generator.js');

const features = Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, true]));
const project = functionProject();
const catalog = project.catalog;
const frameworks = getAvailableFrameworks();
const flows = {};
let shared;
for (const framework of frameworks) {
  const flow = annotateFlowModules(buildOpFlow({ features }), framework);
  const map = buildOpMap({ flow, framework, functions: catalog, frameworks });
  flows[framework] = map.flow;
  shared ??= { commands: map.commands, features: map.features };
}

// The arrows of each endpoint for every combination of the features that add steps to it: a page that
// hides the steps of a feature that is off draws the arrows that generation has, not the arrows of every
// feature with holes in them. Keyed by the feature keys that are on, sorted and joined with commas.
const edgeSets = {};
for (const endpoint of flows[frameworks[0]].endpoints) {
  const keys = [...new Set(endpoint.steps.flatMap((step) => (step.feature === undefined ? [] : [step.feature])))].sort();
  const sets = {};
  for (let mask = 0; mask < 1 << keys.length; mask += 1) {
    const on = keys.filter((_key, index) => (mask & (1 << index)) !== 0);
    const stepIds = endpoint.steps.filter((step) => step.feature === undefined || on.includes(step.feature)).map((step) => step.id);
    sets[on.join(',')] = edgesForSteps(endpoint.id, stepIds);
  }
  edgeSets[endpoint.id] = sets;
}

// Every function of the catalog, so each box of a flow and each caller opens a page of its own.
const functions = {};
let withoutFlow = 0;
for (const [id, card] of Object.entries(catalog.functions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  const flow = project.flowOf(id);
  if (flow === undefined) withoutFlow += 1;
  functions[id] = flow === undefined ? card : { ...card, flow };
}

// The calls a source does not show as a function of the catalog: the members of the interfaces they reach,
// by id (`ConsentResolver.recordConsent`). A step names its own (`consentResolver.recordConsent`, the meta's calls).
const members = {};
const memberOfCall = {};
const unresolved = new Set();
const addMember = (id) => {
  const doc = project.memberById(id);
  if (doc !== undefined) members[id] = doc;
};
for (const flow of Object.values(flows)) {
  for (const endpoint of flow.endpoints) {
    for (const step of endpoint.steps) {
      for (const name of step.dynamicCalls ?? []) {
        const doc = project.memberOf(name);
        if (doc === undefined) {
          unresolved.add(name);
          continue;
        }
        memberOfCall[name] = `${doc.type}.${doc.member}`;
        addMember(memberOfCall[name]);
      }
    }
  }
}
for (const card of Object.values(functions)) {
  for (const node of card.flow?.nodes ?? []) if (node.member !== undefined) addMember(node.member);
}
const undescribed = Object.keys(members).filter((id) => members[id].summary === '');

// The page shows the text of a JSDoc as it is, so a {@link Name} of the libraries (a link in their API docs)
// becomes the name as code (`Name`), and {@link Name | text} its text.
const plain = (text) =>
  text.replace(/\{@link(?:code|plain)?\s+([^}|\s]+)(?:\s*\|\s*([^}]+)|\s+([^}]+))?\}/g, (_match, name, piped, spaced) => {
    const label = (piped ?? spaced)?.trim();
    return label === undefined || label === '' ? `\`${name}\`` : label;
  });
for (const card of Object.values(functions)) {
  card.summary = plain(card.summary);
  if (card.description !== undefined) card.description = plain(card.description);
  if (card.throws !== undefined) card.throws = card.throws.map(plain);
  for (const node of card.flow?.nodes ?? []) if (node.note !== undefined) node.note = plain(node.note);
}
for (const doc of Object.values(members)) doc.summary = plain(doc.summary);
for (const flow of Object.values(flows)) {
  for (const endpoint of flow.endpoints) if (endpoint.summary !== undefined) endpoint.summary = plain(endpoint.summary);
}

const data = {
  version: 3,
  frameworks,
  commands: shared.commands,
  features: shared.features,
  flows,
  functions,
  members,
  memberOfCall,
  edgeSets,
};
const out = join(appRoot, 'public', 'data', 'map.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
const steps = Object.values(flows).reduce((n, flow) => n + flow.endpoints.reduce((m, e) => m + e.steps.length, 0), 0);
const undocumented = Object.values(functions).filter((card) => card.summary === '').length;
console.log(
  `Wrote ${out}: ${frameworks.length} frameworks, ${steps} steps, ${Object.keys(functions).length} functions ` +
    `(${withoutFlow} without a flow, ${undocumented} without a summary), ${Object.keys(members).length} interface members ` +
    `(${undescribed.length} without a summary${undescribed.length > 0 ? `: ${undescribed.join(', ')}` : ''})` +
    (unresolved.size > 0 ? `; calls of steps that name no member: ${[...unresolved].join(', ')}` : ''),
);
