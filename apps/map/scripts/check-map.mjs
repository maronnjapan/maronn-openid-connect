/**
 * The check of the map's own output (packages/map-analysis check.ts), run by
 * `pnpm run build` after the data and the page are built:
 *
 * - every ready-made choice of every frame has a name, distinct in its frame
 *   (no nameless "exit case" is left), and /token offers named choices for
 *   refresh_token and authorization_code;
 * - every line of the body of every frame is inside a node of its tree, and
 *   so is every line a pull request changes in a frame;
 * - in the map of a pull request (MAP_BASE), every change that reaches an
 *   endpoint, and every change of an endpoint body, has a change note;
 * - every way the request cases took on the live OP (MapData.requests) is a
 *   ready-made choice of its root, the cases a way names took it, and every
 *   case of hono that needs nothing outside the OP was run at the root of
 *   its endpoint, once;
 * - every case run is faithful: the walk of its trace agrees with what its
 *   request ran (no mismatch), its request ran the root unless the case
 *   expects 404 or 405 (the router answers those), and the OP answered the
 *   status and the OAuth error the case expects;
 * - every link of the code (Ctrl/⌘ + click in the code view) sits on a name
 *   and goes to the name of a declaration in a file the map carries.
 *
 * It measures the map, not the code it reads: a failure of the first two is
 * a bug of the map. Prints the measures (with how many cases took a side
 * the rules could not read, which the walk assumed), and exits with 1 on a
 * failure.
 *
 * Usage: node scripts/check-map.mjs [data directory] (default public/data)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLinks, checkMap } from '@maronn-openid-connect/map-analysis';
import { REQUEST_SCENARIOS, requestScenario, requestScenariosFor } from '@maronn-openid-connect/test-catalog/premises';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// pnpm passes on the `--` before the arguments of a script.
const [argument] = process.argv.slice(2).filter((arg) => arg !== '--');
const directory = resolve(argument ?? join(appRoot, 'public', 'data'));
const data = JSON.parse(readFileSync(join(directory, 'map.json'), 'utf8'));
/** A url of the data (`./data/functions/<hash>.json`) as a file of the directory. */
const fileOf = (url) => join(directory, url.replace(/^\.\/data\//, ''));
const readJson = async (url) => JSON.parse(readFileSync(fileOf(url), 'utf8'));
const { metrics, failures } = await checkMap(
  data,
  readJson,
  async (id) => {
    const source = data.sources[id];
    return source === undefined ? undefined : JSON.parse(readFileSync(fileOf(source.url), 'utf8')).code;
  },
  readJson,
  (id) => requestScenario(id, 'hono')?.expected,
);
const { requests } = metrics;
console.log(
  `Checked the map: ${metrics.frames} frames, ${metrics.selections} ready-made choices (${metrics.unnamed} without a name, ${metrics.duplicateNames.length} repeated), ` +
    `${metrics.wiring.entries} wiring entries (${metrics.wiring.untraceable} untraceable, ${metrics.wiring.invalid} invalid), ` +
    `${metrics.uncovered.length} frames with lines in no node, ${metrics.changedOutside.length} frames with changed lines in no node, ${metrics.undocumented.length} changes without a note, ${metrics.untested.length} changes whose tests did not change without a reason, ` +
    (data.requests === undefined
      ? 'no cases run on the live OP'
      : `${requests.cases} cases run on the live OP (probes ${data.liveOp?.probes ?? 'unknown'}) at ${requests.roots} roots, ${requests.cases - requests.unfaithful} faithful, ${requests.mismatches} mismatches, ` +
        `${requests.assumedCases} cases with ${requests.assumed} assumed decisions, ${requests.ways} ways reached by a case (${requests.unmatched} no choice is)`),
);
for (const [framework, names] of Object.entries(metrics.token)) console.log(`  /token (${framework}): ${names.join(' | ')}`);
const links = checkLinks(new Map(Object.entries(data.sources).map(([id, source]) => [id, JSON.parse(readFileSync(fileOf(source.url), 'utf8'))])));
console.log(`Checked the links of the code: ${links.links} names in ${Object.keys(data.sources).length} files, ${links.broken.length} broken`);
failures.push(...links.broken.slice(0, 20), ...(links.broken.length > 20 ? [`… and ${links.broken.length - 20} more broken links of the code`] : []));
const featureIds = data.features.map(({ id }) => id);
const seenScenarios = new Set();
let endpointCount = 0;
for (const [framework, flow] of Object.entries(data.flows)) {
  for (const endpoint of flow.endpoints) {
    endpointCount += 1;
    const scenarios = requestScenariosFor(endpoint.id, featureIds, framework);
    if (scenarios.length === 0) failures.push(`${framework} ${endpoint.path} has no request scenario`);
    for (const scenario of scenarios) seenScenarios.add(scenario.id);
  }
}
const ids = new Set();
for (const { id } of REQUEST_SCENARIOS) {
  if (ids.has(id)) failures.push(`Duplicate request scenario: ${id}`);
  if (!seenScenarios.has(id)) failures.push(`Request scenario is not available at any endpoint: ${id}`);
  ids.add(id);
}
console.log(`Checked the request scenarios: ${seenScenarios.size} scenarios across ${endpointCount} framework endpoints`);
// Every case of hono that needs nothing outside the OP was run, at one root (the build runs them all).
if (data.requests !== undefined) {
  const runs = new Map();
  for (const url of Object.values(data.requests)) for (const run of (await readJson(url)).cases) runs.set(run.id, (runs.get(run.id) ?? 0) + 1);
  for (const scenario of REQUEST_SCENARIOS) {
    if (scenario.external !== undefined || scenario.frameworks?.includes('hono') === false) continue;
    const count = runs.get(scenario.id) ?? 0;
    if (count !== 1) failures.push(`The case ${scenario.id} was run at ${count} roots on the live OP, not 1`);
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
