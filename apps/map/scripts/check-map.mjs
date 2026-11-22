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
 * - with a measured run, every way the requests name is a ready-made choice
 *   of its root, and every request says the line of its test that sent it;
 * - every link of the code (Ctrl/⌘ + click in the code view) sits on a name
 *   and goes to the name of a declaration in a file the map carries.
 *
 * It measures the map, not the code it reads: a failure of the first two is
 * a bug of the map. Prints the measures, and exits with 1 on a failure.
 *
 * Usage: node scripts/check-map.mjs [data directory] (default public/data)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLinks, checkMap } from '@maronn-openid-connect/map-analysis';

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
);
console.log(
  `Checked the map: ${metrics.frames} frames, ${metrics.selections} ready-made choices (${metrics.unnamed} without a name, ${metrics.duplicateNames.length} repeated), ` +
    `${metrics.wiring.entries} wiring entries (${metrics.wiring.untraceable} untraceable, ${metrics.wiring.invalid} invalid), ` +
    `${metrics.uncovered.length} frames with lines in no node, ${metrics.changedOutside.length} frames with changed lines in no node, ${metrics.undocumented.length} changes without a note, ${metrics.untested.length} changes whose tests did not change without a reason, ` +
    `${data.requests === undefined ? 'no measured requests' : `the requests of ${metrics.requests.ways} ways of ${metrics.requests.roots} roots (${metrics.requests.examples} requests, ${metrics.requests.unmatched} ways no choice is)`}`,
);
for (const [framework, names] of Object.entries(metrics.token)) console.log(`  /token (${framework}): ${names.join(' | ')}`);
const links = checkLinks(new Map(Object.entries(data.sources).map(([id, source]) => [id, JSON.parse(readFileSync(fileOf(source.url), 'utf8'))])));
console.log(`Checked the links of the code: ${links.links} names in ${Object.keys(data.sources).length} files, ${links.broken.length} broken`);
failures.push(...links.broken.slice(0, 20), ...(links.broken.length > 20 ? [`… and ${links.broken.length - 20} more broken links of the code`] : []));
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
