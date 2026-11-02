/**
 * `pnpm run build` (after tsc): copy the sources of extract.json into
 * templates/<source>/ and bake the catalog of each hono-layout root into
 * templates/<source>/<root>.catalog.json, so the published package can
 * generate without apps/. The function catalog of every library and source
 * (functions.ts) is baked into templates/functions.catalog.json, and the
 * calls of the Route Handler blocks of a nextjs-layout root into
 * templates/<source>/<root>.blocks.json, so `explain` works without the
 * sources of the packages.
 *
 * Usage: node dist/extract/collect.js
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRouteBlockCalls } from './blocks.js';
import { analyzeFunctions } from './functions.js';
import { buildSourceCatalog } from './meta.js';
import {
  FUNCTION_CATALOG_FILE,
  PACKAGE_ROOT,
  filesUnderRoot,
  readExtractionDefinition,
  readFunctionRoots,
  readSourceFiles,
} from './templates.js';

export function collectTemplates(packageRoot = PACKAGE_ROOT): string[] {
  const definition = readExtractionDefinition(packageRoot);
  const templatesRoot = join(packageRoot, 'templates');
  rmSync(templatesRoot, { recursive: true, force: true });
  const written: string[] = [];
  for (const name of Object.keys(definition.sources)) {
    const files = readSourceFiles(name, definition, packageRoot);
    for (const [path, content] of files) {
      const target = join(templatesRoot, name, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      written.push(`${name}/${path}`);
    }
    // The catalog describes the steps of the hono layout (graph and --flow
    // read it); a Next.js route keeps its step meta in its endpoint.ts.
    const roots = new Set(
      Object.values(definition.frameworks)
        .filter((framework) => framework.source === name && framework.layout === 'hono')
        .map((framework) => framework.root),
    );
    for (const root of roots) {
      const catalog = buildSourceCatalog(filesUnderRoot(files, root));
      writeFileSync(join(templatesRoot, name, `${root}.catalog.json`), `${JSON.stringify(catalog, null, 2)}\n`);
      written.push(`${name}/${root}.catalog.json`);
    }
  }
  const functionRoots = readFunctionRoots(definition, packageRoot);
  if (functionRoots === undefined) {
    throw new Error('The sources of the libraries are missing: the function catalog is baked from the repository');
  }
  const project = analyzeFunctions(functionRoots);
  writeFileSync(join(templatesRoot, FUNCTION_CATALOG_FILE), `${JSON.stringify(project.catalog, null, 2)}\n`);
  written.push(FUNCTION_CATALOG_FILE);
  for (const [frameworkName, framework] of Object.entries(definition.frameworks)) {
    if (framework.layout !== 'nextjs') continue;
    const files = readSourceFiles(framework.source, definition, packageRoot);
    const blocks = readRouteBlockCalls(project, framework.source, framework.root, files);
    const target = join(templatesRoot, framework.source, `${framework.root}.blocks.json`);
    writeFileSync(target, `${JSON.stringify(blocks, null, 2)}\n`);
    written.push(`${framework.source}/${framework.root}.blocks.json`);
    void frameworkName;
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = collectTemplates();
  console.log(`Collected ${written.length} template files into templates/`);
}
