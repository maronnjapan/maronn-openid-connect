/**
 * Put the built tests viewer (apps/tests/dist) into the map's page at
 * dist/tests/, so the Worker of the map serves it at <map url>/tests/ and
 * every preview of a pull request carries it. `pnpm run build` runs it after
 * the page is built and before the check, so a pull request whose check
 * fails still deploys the viewer with the map.
 *
 * The viewer's data is not built here: the data step of the map
 * (scripts/build-data.mjs) writes it to apps/tests/public/data, and the
 * viewer's `vite build` copies it to apps/tests/dist/data.
 *
 * Fails (exit 1) when the viewer was not built, when it holds no data, when
 * the map was not built, or when the map's own data still holds the tests
 * (the map shows no test; its data must not carry them).
 *
 * Usage: node scripts/copy-tests-viewer.mjs [viewer dist] [map dist]
 * (default ../tests/dist and dist)
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The files under a directory and their bytes. */
function measure(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += statSync(join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

/**
 * Copy the built viewer into the map's page at `<mapDist>/tests`, replacing
 * what an earlier build put there. Throws when either is not built, when the
 * viewer has no data, or when the map's data still holds the tests.
 */
export function copyTestsViewer({ viewerDist, mapDist }) {
  if (!existsSync(join(viewerDist, 'index.html'))) {
    throw new Error(`The tests viewer is not built: ${join(viewerDist, 'index.html')} is missing. Build it with \`pnpm --filter @maronn-openid-connect/tests build\` after the data step of the map.`);
  }
  if (!existsSync(join(viewerDist, 'data', 'tests.json'))) {
    throw new Error(`The tests viewer was built without its data: ${join(viewerDist, 'data', 'tests.json')} is missing. The data step of the map (scripts/build-data.mjs) writes it to apps/tests/public/data; run it before the viewer's build.`);
  }
  if (!existsSync(join(mapDist, 'index.html'))) {
    throw new Error(`The map is not built: ${join(mapDist, 'index.html')} is missing.`);
  }
  for (const stale of ['tests.json', 'tests']) {
    if (existsSync(join(mapDist, 'data', stale))) {
      throw new Error(`The map's data holds the tests (${join(mapDist, 'data', stale)}): the tests are the viewer's (apps/tests/public/data), and the map shows none.`);
    }
  }
  const target = join(mapDist, 'tests');
  rmSync(target, { recursive: true, force: true });
  cpSync(viewerDist, target, { recursive: true });
  return { target, ...measure(target) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // pnpm passes on the `--` before the arguments of a script.
  const [viewer, map] = process.argv.slice(2).filter((arg) => arg !== '--');
  try {
    const { target, files, bytes } = copyTestsViewer({
      viewerDist: resolve(viewer ?? join(appRoot, '..', 'tests', 'dist')),
      mapDist: resolve(map ?? join(appRoot, 'dist')),
    });
    console.log(`Copied the tests viewer to ${target}: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB (served at <map url>/tests/)`);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
