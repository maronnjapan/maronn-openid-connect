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
 *   endpoint, and every change of an endpoint body, has a change note.
 *
 * It measures the map, not the code it reads: a failure of the first two is
 * a bug of the map. Prints the measures, and exits with 1 on a failure.
 *
 * Usage: node scripts/check-map.mjs [data directory] (default public/data)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMap } from '@maronn-openid-connect/map-analysis';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// pnpm passes on the `--` before the arguments of a script.
const [argument] = process.argv.slice(2).filter((arg) => arg !== '--');
const directory = resolve(argument ?? join(appRoot, 'public', 'data'));
const data = JSON.parse(readFileSync(join(directory, 'map.json'), 'utf8'));
/** A url of the data (`./data/functions/<hash>.json`) as a file of the directory. */
const fileOf = (url) => join(directory, url.replace(/^\.\/data\//, ''));
const { metrics, failures } = await checkMap(
  data,
  async (url) => JSON.parse(readFileSync(fileOf(url), 'utf8')),
  async (id) => {
    const source = data.sources[id];
    return source === undefined ? undefined : JSON.parse(readFileSync(fileOf(source.url), 'utf8')).code;
  },
);
console.log(
  `Checked the map: ${metrics.frames} frames, ${metrics.selections} ready-made choices (${metrics.unnamed} without a name, ${metrics.duplicateNames.length} repeated), ` +
    `${metrics.wiring.entries} wiring entries (${metrics.wiring.untraceable} untraceable, ${metrics.wiring.invalid} invalid), ` +
    `${metrics.uncovered.length} frames with lines in no node, ${metrics.changedOutside.length} frames with changed lines in no node, ${metrics.undocumented.length} changes without a note`,
);
for (const [framework, names] of Object.entries(metrics.token)) console.log(`  /token (${framework}): ${names.join(' | ')}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
