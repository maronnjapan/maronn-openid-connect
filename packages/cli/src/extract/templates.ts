/**
 * The source files the generator extracts from, as extract.json describes
 * them.
 *
 * In the repository the CLI reads them straight from apps/ (so a change to an
 * app is generated without a rebuild). The published package has no apps/: it
 * carries the copy `pnpm run build` makes in templates/ (collect.ts), with the
 * catalog of the steps baked into templates/<source>/catalog.json.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
