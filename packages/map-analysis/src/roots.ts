/**
 * The roots of the function catalog (packages/cli/extract.json) as the
 * analysis compiles them: the directory of each root in the repository, the
 * files of it the catalog reads, the tsconfig.json it compiles with, and how
 * the apps import the libraries.
 *
 * The apps import the libraries by their package names, whose `exports`
 * point at the built `dist/`. The analysis compiles every root with a
 * tsconfig laid over its own (never written to disk) whose `paths` send those
 * names to the sources, so a call in apps/hono resolves to the function in
 * packages/core/src, with no build of the libraries.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

export interface AnalysisRoot {
  /** The first part of every id of the root (core, experimental, google-login, hono, nextjs). */
  name: string;
  /** The directory of its files, from the root of the repository (packages/core/src, apps/hono/src). */
  directory: string;
  /** The entries of the directory a source takes (absent for a library: every file). */
  include?: string[];
  exclude: RegExp[];
  /** The directory of the tsconfig.json the root is compiled with (packages/core, apps/hono). */
  project: string;
  /** A library: the package name the apps import it by, and its exports mapped to the sources (`./ciba` → `src/ciba/index.ts`). */
  library?: { name: string; exports: Record<string, string> };
}

/** What extract.json says about the roots (packages/cli/src/extract/templates.ts). */
export interface ExtractionDefinition {
  sources: Record<string, { directory: string; include: string[]; exclude: string[] }>;
  libraries?: Record<string, { package: string; directory: string; exclude: string[] }>;
  frameworks: Record<string, { source: string; root: string; layout: 'hono' | 'nextjs'; router?: 'web'; files: Record<string, string> }>;
}

/** The name of the tsconfig the analysis lays over a root's own (virtual: it is never written). */
export const OVERLAY_CONFIG = 'tsconfig.map-analysis.json';

/**
 * Whether a path of the repository is a test: a test or spec of Vitest or
 * Playwright (`*.test.ts`, `*.spec.ts`, `*.test.mjs`, ...) or a feature file
 * of Gherkin. The map reads none of them as frames; the diff of the tests
 * (packages/test-catalog) reads them.
 */
export function isTestPath(path: string): boolean {
  return /\.(test|spec)\.(c|m)?[jt]sx?$/.test(path) || path.endsWith('.feature');
}

/** The nearest directory at or above `directory` that holds a tsconfig.json, from the root of the repository. */
function projectOf(repository: string, directory: string): string {
  let current = directory;
  for (;;) {
    if (existsSync(join(repository, current, 'tsconfig.json'))) return current;
    const parent = posix.dirname(current);
    if (parent === current || parent === '.') throw new Error(`No tsconfig.json at or above ${directory}`);
    current = parent;
  }
}

/** The exports of a library mapped to its sources: `./dist/ciba/index.d.ts` → `src/ciba/index.ts`, by the subpath (`.`, `./ciba`). */
function sourceExports(repository: string, project: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(repository, project, 'package.json'), 'utf8')) as { exports?: Record<string, { types?: string } | string> };
  const exports: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const types = typeof target === 'string' ? target : target.types;
    if (types === undefined) continue;
    exports[subpath] = types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts');
  }
  return exports;
}

/**
 * The roots of extract.json, read relative to the CLI package (`cli`, from
 * the root of the repository: packages/cli).
 */
export function readRoots(repository: string, definition: ExtractionDefinition, cli = 'packages/cli'): AnalysisRoot[] {
  const roots: AnalysisRoot[] = [];
  for (const [name, library] of Object.entries(definition.libraries ?? {})) {
    const directory = posix.normalize(posix.join(cli, library.directory));
    const project = projectOf(repository, directory);
    roots.push({ name, directory, exclude: library.exclude.map((pattern) => new RegExp(pattern)), project, library: { name: library.package, exports: sourceExports(repository, project) } });
  }
  for (const [name, source] of Object.entries(definition.sources)) {
    const directory = posix.normalize(posix.join(cli, source.directory));
    roots.push({ name, directory, include: source.include, exclude: source.exclude.map((pattern) => new RegExp(pattern)), project: projectOf(repository, directory) });
  }
  return roots;
}

/** The root and the module (the path under the root, as in an id) of a path of the repository; undefined for a file the catalog does not read. */
export function moduleOf(roots: readonly AnalysisRoot[], path: string): { root: string; module: string } | undefined {
  if (!/\.tsx?$/.test(path) || /\.d\.ts$/.test(path)) return undefined;
  for (const root of roots) {
    if (!path.startsWith(`${root.directory}/`)) continue;
    const module = path.slice(root.directory.length + 1);
    if (root.include !== undefined && !root.include.some((entry) => module === entry || module.startsWith(`${entry}/`))) continue;
    if (root.exclude.some((pattern) => pattern.test(module))) continue;
    return { root: root.name, module };
  }
  return undefined;
}

/** The path in the repository of a module of a root. */
export function pathOf(roots: readonly AnalysisRoot[], root: string, module: string): string {
  const entry = roots.find((candidate) => candidate.name === root);
  if (entry === undefined) throw new Error(`No root ${root}`);
  return posix.join(entry.directory, module);
}

/**
 * The tsconfig laid over the one of each project the roots compile with:
 * absolute path → text. It extends the project's own, sends the package
 * names of the libraries to their sources, and names the files of the roots
 * (`files`): an `include` glob skips a directory whose name starts with a dot
 * (`app/.well-known/`), and the catalog reads those too.
 */
export function overlayConfigs(repository: string, roots: readonly AnalysisRoot[], modules: ReadonlyMap<string, readonly string[]> = new Map()): Map<string, string> {
  const configs = new Map<string, string>();
  for (const project of new Set(roots.map((root) => root.project))) {
    const paths: Record<string, string[]> = {};
    for (const root of roots) {
      if (root.library === undefined) continue;
      for (const [subpath, source] of Object.entries(root.library.exports)) {
        const specifier = subpath === '.' ? root.library.name : `${root.library.name}/${subpath.replace(/^\.\//, '')}`;
        const target = relative(join(repository, project), join(repository, root.project, source)).split('\\').join('/');
        paths[specifier] = [target.startsWith('.') ? target : `./${target}`];
      }
    }
    const files = roots
      .filter((root) => root.project === project)
      .flatMap((root) => (modules.get(root.name) ?? []).map((module) => relative(join(repository, project), join(repository, root.directory, module)).split('\\').join('/')));
    const config: Record<string, unknown> = { extends: './tsconfig.json', compilerOptions: { paths } };
    if (files.length > 0) config['files'] = files.map((file) => (file.startsWith('.') ? file : `./${file}`));
    configs.set(join(repository, project, OVERLAY_CONFIG), JSON.stringify(config));
  }
  return configs;
}

/** The absolute path of the overlay tsconfig of a root's project. */
export function overlayOf(repository: string, root: AnalysisRoot): string {
  return join(repository, root.project, OVERLAY_CONFIG);
}

