/**
 * The source files the generator extracts from, as extract.json describes
 * them.
 *
 * In the repository the CLI reads them straight from apps/ (so a change to an
 * app is generated without a rebuild). The published package has no apps/: it
 * carries the copy `pnpm run build` makes in templates/ (collect.ts), with the
 * catalog of the steps baked into templates/<source>/<root>.catalog.json.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRouteBlockCalls, type RouteBlockCalls } from './blocks.js';
import { analyzeFunctions, type FunctionCatalog, type FunctionProject, type FunctionRoot } from './functions.js';
import { buildSourceCatalog, type SourceCatalog } from './meta.js';

export interface SourceDefinition {
  /** The directory of the source, relative to the package root. */
  directory: string;
  /** The entries of that directory that are extracted. */
  include: string[];
  /** Regular expressions of the paths that are not (the tests). */
  exclude: string[];
}

export interface FrameworkDefinition {
  source: string;
  /** The directory under the source that becomes the output directory. */
  root: string;
  layout: 'hono' | 'nextjs';
  /** 'web': Hono is replaced with the WebRouter of web-router.ts (Express, Fastify). */
  router?: 'web';
  /** Files placed over the root: output path → path under the source. */
  files: Record<string, string>;
}

export interface ExtractionDefinition {
  sources: Record<string, SourceDefinition>;
  /** The packages whose functions the function catalog reads (see functions.ts). */
  libraries?: Record<string, LibraryDefinition>;
  frameworks: Record<string, FrameworkDefinition>;
}

/** The root of the CLI package (src/extract/ and dist/extract/ both sit two levels below it). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function readExtractionDefinition(packageRoot = PACKAGE_ROOT): ExtractionDefinition {
  return JSON.parse(readFileSync(join(packageRoot, 'extract.json'), 'utf-8')) as ExtractionDefinition;
}

/** The files of a source, by path relative to its directory, tests excluded. */
export function readSourceFiles(
  name: string,
  definition: ExtractionDefinition,
  packageRoot = PACKAGE_ROOT,
): Map<string, string> {
  const source = definition.sources[name];
  if (!source) throw new Error(`extract.json has no source "${name}"`);
  const repositoryDirectory = join(packageRoot, source.directory);
  const directory = existsSync(repositoryDirectory) ? repositoryDirectory : join(packageRoot, 'templates', name);
  if (!existsSync(directory)) {
    throw new Error(`The templates of "${name}" are missing: run pnpm run build in packages/cli`);
  }
  const exclude = source.exclude.map((pattern) => new RegExp(pattern));
  const files = new Map<string, string>();
  for (const entry of source.include) {
    for (const file of listFiles(join(directory, entry))) {
      const path = relative(directory, file).split('\\').join('/');
      if (exclude.some((pattern) => pattern.test(path))) continue;
      files.set(path, readFileSync(file, 'utf-8'));
    }
  }
  return files;
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((entry) => (entry === 'node_modules' ? [] : listFiles(join(path, entry))));
}

/** The files under a framework's root, by path relative to that root. */
export function filesUnderRoot(files: ReadonlyMap<string, string>, root: string): Map<string, string> {
  const prefix = `${root}/`;
  const under = new Map<string, string>();
  for (const [path, content] of files) {
    if (path.startsWith(prefix)) under.set(path.slice(prefix.length), content);
  }
  return under;
}

/**
 * The catalog of a source root: the one templates/ carries, or, in the
 * repository, the one its files describe right now.
 */
export function readSourceCatalog(
  name: string,
  root: string,
  files: ReadonlyMap<string, string>,
  definition: ExtractionDefinition,
  packageRoot = PACKAGE_ROOT,
): SourceCatalog {
  const source = definition.sources[name];
  const inRepository = source !== undefined && existsSync(join(packageRoot, source.directory));
  const baked = join(packageRoot, 'templates', name, `${root}.catalog.json`);
  if (!inRepository && existsSync(baked)) {
    return JSON.parse(readFileSync(baked, 'utf-8')) as SourceCatalog;
  }
  return buildSourceCatalog(filesUnderRoot(files, root));
}

// ---------------------------------------------------------------------------
// The function catalog (functions.ts)

/** A library whose functions the catalog reads (extract.json `libraries`). */
export interface LibraryDefinition {
  /** The specifier the apps import the library by. */
  package: string;
  /** The directory of its sources, relative to the package root. */
  directory: string;
  /** Regular expressions of the paths that are left out (the tests). */
  exclude: string[];
}

/** The name of the baked function catalog under templates/. */
export const FUNCTION_CATALOG_FILE = 'functions.catalog.json';

/** The files of a library, by path relative to its source directory; undefined outside the repository. */
export function readLibraryFiles(
  name: string,
  definition: ExtractionDefinition,
  packageRoot = PACKAGE_ROOT,
): Map<string, string> | undefined {
  const library = definition.libraries?.[name];
  if (!library) throw new Error(`extract.json has no library "${name}"`);
  const directory = join(packageRoot, library.directory);
  if (!existsSync(directory)) return undefined;
  const exclude = library.exclude.map((pattern) => new RegExp(pattern));
  const files = new Map<string, string>();
  for (const file of listFiles(directory)) {
    const path = relative(directory, file).split('\\').join('/');
    if (exclude.some((pattern) => pattern.test(path))) continue;
    files.set(path, readFileSync(file, 'utf-8'));
  }
  return files;
}

/**
 * The roots of the function catalog: every library and every source of
 * extract.json. Undefined outside the repository (the published package has
 * no library sources; it carries the baked catalog instead).
 */
export function readFunctionRoots(definition: ExtractionDefinition, packageRoot = PACKAGE_ROOT): FunctionRoot[] | undefined {
  const roots: FunctionRoot[] = [];
  for (const [name, library] of Object.entries(definition.libraries ?? {})) {
    const files = readLibraryFiles(name, definition, packageRoot);
    if (files === undefined) return undefined;
    roots.push({ name, specifier: library.package, files });
  }
  for (const name of Object.keys(definition.sources)) {
    const source = definition.sources[name] as SourceDefinition;
    if (!existsSync(join(packageRoot, source.directory))) return undefined;
    roots.push({ name, files: readSourceFiles(name, definition, packageRoot) });
  }
  return roots;
}

let cachedProject: FunctionProject | undefined;

/**
 * The function project of the repository, or of the baked catalog in the
 * published package (which answers no `callsIn`: the Route Handler blocks of
 * Next.js are baked with the catalog, see collect.ts).
 */
export function functionProject(packageRoot = PACKAGE_ROOT): FunctionProject {
  if (cachedProject !== undefined) return cachedProject;
  const definition = readExtractionDefinition(packageRoot);
  const roots = readFunctionRoots(definition, packageRoot);
  if (roots !== undefined) {
    cachedProject = analyzeFunctions(roots);
    return cachedProject;
  }
  const baked = join(packageRoot, 'templates', FUNCTION_CATALOG_FILE);
  if (!existsSync(baked)) {
    throw new Error(`The function catalog is missing: run pnpm run build in packages/cli (${baked})`);
  }
  const catalog = JSON.parse(readFileSync(baked, 'utf-8')) as FunctionCatalog;
  cachedProject = {
    catalog,
    callsIn: () => {
      throw new Error('The published package has no sources to read calls from');
    },
    enclosingBody: () => undefined,
  };
  return cachedProject;
}

/** The function catalog (see functionProject). */
export function readFunctionCatalog(packageRoot = PACKAGE_ROOT): FunctionCatalog {
  return functionProject(packageRoot).catalog;
}

/**
 * The calls of the Route Handler blocks of a nextjs-layout framework
 * (blocks.ts): read from the sources in the repository, or from the baked
 * templates/<source>/<root>.blocks.json in the published package.
 */
export function readFrameworkBlockCalls(framework: string, packageRoot = PACKAGE_ROOT): RouteBlockCalls {
  const definition = readExtractionDefinition(packageRoot);
  const entry = definition.frameworks[framework];
  if (!entry) throw new Error(`extract.json has no framework "${framework}"`);
  if (entry.layout !== 'nextjs') return {};
  const source = definition.sources[entry.source];
  const inRepository = source !== undefined && existsSync(join(packageRoot, source.directory));
  if (inRepository) {
    const files = readSourceFiles(entry.source, definition, packageRoot);
    return readRouteBlockCalls(functionProject(packageRoot), entry.source, entry.root, files);
  }
  const baked = join(packageRoot, 'templates', entry.source, `${entry.root}.blocks.json`);
  if (!existsSync(baked)) {
    throw new Error(`The block calls of "${framework}" are missing: run pnpm run build in packages/cli (${baked})`);
  }
  return JSON.parse(readFileSync(baked, 'utf-8')) as RouteBlockCalls;
}
