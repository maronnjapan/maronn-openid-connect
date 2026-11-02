/**
 * Build the OIDC Provider Map: a static page that walks the generated
 * provider from the CLI commands down to the functions of core, for every
 * framework, with every feature on (the viewer's toggles narrow it).
 *
 * The data is what `maronn-oidc explain <framework> --format json --enable
 * <every feature>` prints, with the function cards merged into one catalog.
 * It is inlined into the page (packages/cli/map/template.html), so the page
 * works from a file, an artifact and a static host alike.
 *
 * Usage: node packages/cli/scripts/build-map.mjs [--out <dir>]   (after pnpm --filter @maronn-openid-connect/cli build)
 *
 * Writes <dir>/index.html (a full document), <dir>/artifact.html (the page
 * without the document skeleton, for hosts that add their own) and
 * <dir>/data.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(packageRoot, 'dist');
if (!existsSync(join(dist, 'index.js'))) {
  console.error('packages/cli is not built: run pnpm --filter @maronn-openid-connect/cli build first');
  process.exit(1);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = resolve(outIndex === -1 ? 'dist-map' : (args[outIndex + 1] ?? 'dist-map'));

const { buildOpFlow } = await import(pathToFileURL(join(dist, 'flow/build.js')).href);
const { annotateFlowModules } = await import(pathToFileURL(join(dist, 'flow/modules.js')).href);
const { buildOpMap } = await import(pathToFileURL(join(dist, 'explain/map.js')).href);
const { readFunctionCatalog } = await import(pathToFileURL(join(dist, 'extract/templates.js')).href);
const { FEATURE_CONFIG_KEYS } = await import(pathToFileURL(join(dist, 'registry.js')).href);
const { getAvailableFrameworks } = await import(pathToFileURL(join(dist, 'generator.js')).href);

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
// The callers of a card may be outside the reach of the steps (a Route Handler of Next.js);
// keep those cards too, so the viewer can climb to them.
for (const card of Object.values(functions)) {
  for (const id of card.calledBy) if (functions[id] === undefined && catalog.functions[id]) functions[id] = catalog.functions[id];
}
const data = {
  version: 2,
  frameworks,
  commands: shared.commands,
  features: shared.features,
  flows,
  functions: Object.fromEntries(Object.entries(functions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
};

const template = readFileSync(join(packageRoot, 'map', 'template.html'), 'utf8');
const json = JSON.stringify(data).replace(/<\//g, '<\\/');
const page = template.replace('__MAP_DATA__', json);
const document = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${page.replace(/^<meta name="claude:viewport-fit-sides"[^\n]*\n/m, '')}\n</head>\n<body></body>\n</html>\n`
  // The template is body content with its title and style first; move everything after </style> into the body.
  .replace(/(<\/style>\n)([\s\S]*?)\n<\/head>\n<body><\/body>/, '$1</head>\n<body>\n$2\n</body>');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), document);
writeFileSync(join(outDir, 'artifact.html'), page);
writeFileSync(join(outDir, 'data.json'), `${JSON.stringify(data, null, 2)}\n`);
const cards = Object.keys(functions).length;
const steps = Object.values(flows).reduce((n, flow) => n + flow.endpoints.reduce((m, e) => m + e.steps.length, 0), 0);
console.log(`Wrote ${outDir}/index.html (${(document.length / 1024).toFixed(0)} KB): ${frameworks.length} frameworks, ${steps} steps, ${cards} functions`);
