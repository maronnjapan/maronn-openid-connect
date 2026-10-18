/**
 * Generate the provider by extracting it from the app of the framework
 * (extract.json): the base, the directories of the enabled features and one
 * db kind, with the owner blocks of the disabled features removed from the
 * pipelines.
 *
 * 1. Resolve the features (registry.ts) and the db kind.
 * 2. Select the files: every file of the base, features/<id>/** of the
 *    enabled features, and db/<kind>/** (memory without --db) moved up into
 *    db/; db/index.ts of the app is the one of that kind.
 * 3. Render features/enabled.ts (the lines of the enabled features) and the
 *    custom scopes of scopes.ts. The manifest is written by the caller.
 * 4. Remove the owner blocks of the disabled features and their imports. A
 *    value such a block defined that later code still reads becomes
 *    `const <name> = undefined;`, and a value nothing reads any more loses
 *    its binding.
 * 5. Move the relative imports to the output layout and point
 *    @maronn-openid-connect/core at the package name of the run. Express and
 *    Fastify also get Hono replaced with the WebRouter (web.ts).
 */
import { posix } from 'node:path';
import type { DbKind } from './db.js';
import type { GeneratedFile } from './frameworks/types.js';
import { enabledFeatureIds, type OidcFeatureConfig } from './registry.js';
import type { SourceCatalog, StepMeta } from './extract/meta.js';
import {
  identifiersIn,
  mapSpecifiers,
  parseImports,
  parseOwnerBlocks,
  type OwnerBlock,
  relativeSpecifier,
  removeImports,
  removeOwnerBlocks,
  resolveRelative,
} from './extract/source.js';
import {
  readExtractionDefinition,
  readSourceCatalog,
  readSourceFiles,
  type ExtractionDefinition,
  type FrameworkDefinition,
} from './extract/templates.js';
import { toWebRouter } from './extract/web.js';

const CORE_PACKAGE = '@maronn-openid-connect/core';

export interface ExtractOptions {
  framework: string;
  features: OidcFeatureConfig;
  scopes?: readonly string[];
  db?: DbKind;
  corePackageName?: string;
  /**
   * `--flow`: the step ids each rearranged endpoint keeps, in order. An
   * endpoint that is absent keeps the steps of the app, in its order.
   */
  steps?: Readonly<Record<string, readonly string[]>>;
  /** For tests: an extraction definition and source files instead of the package's own. */
  definition?: ExtractionDefinition;
  sourceFiles?: ReadonlyMap<string, string>;
}

/** The frameworks extract.json describes. */
export function extractableFrameworks(definition = readExtractionDefinition()): string[] {
  return Object.keys(definition.frameworks);
}

/** The owner of a path under the extraction root of a hono-layout app. */
function ownerOf(path: string): { kind: 'base' } | { kind: 'feature' | 'db'; id: string } {
  const segments = path.split('/');
  if (segments[0] === 'features' && segments.length > 2) return { kind: 'feature', id: segments[1] ?? '' };
  if (segments[0] === 'db' && segments.length > 2) return { kind: 'db', id: segments[1] ?? '' };
  return { kind: 'base' };
}

/** Generate the files of a provider. Paths are relative to the output directory. */
export function extractProvider(options: ExtractOptions): GeneratedFile[] {
  const definition = options.definition ?? readExtractionDefinition();
  const framework = definition.frameworks[options.framework];
  if (!framework) {
    throw new Error(
      `Unknown framework: "${options.framework}". Available frameworks: ${Object.keys(definition.frameworks).join(', ')}`,
    );
  }
  const sourceFiles = options.sourceFiles ?? readSourceFiles(framework.source, definition);
  const catalog = readSourceCatalog(framework.source, framework.root, sourceFiles, definition);
  const enabled = new Set(enabledFeatureIds(options.features));
  const dbKind = options.db ?? 'memory';

  // Source path (under the source directory) → output path.
  const placement = selectFiles(framework, sourceFiles, enabled, dbKind);
  const known = new Set(sourceFiles.keys());
  const files: GeneratedFile[] = [];
  for (const [sourcePath, outputPath] of placement) {
    let content = sourceFiles.get(sourcePath) ?? '';
    const rootPath = sourcePath.startsWith(`${framework.root}/`) ? sourcePath.slice(framework.root.length + 1) : undefined;

    if (rootPath === 'features/enabled.ts') content = renderEnabledFeatures(content, enabled);
    if (rootPath === 'scopes.ts') content = renderCustomScopes(content, options.scopes ?? []);
    if (rootPath !== undefined && /(^|\/)pipeline\.ts$/.test(rootPath)) {
      const endpoint = endpointOfPipeline(rootPath, catalog);
      content = transformPipeline(
        content,
        rootPath,
        enabled,
        catalog,
        endpoint === undefined ? undefined : options.steps?.[endpoint.id],
      );
    }
    content = removeImports(content, (declaration) => {
      const target = resolveRelative(sourcePath, declaration.specifier, known);
      return target !== undefined && isDisabledFeatureFile(target, framework.root, enabled);
    });
    content = mapSpecifiers(content, (specifier) => {
      if (specifier === CORE_PACKAGE) return options.corePackageName ?? CORE_PACKAGE;
      const target = resolveRelative(sourcePath, specifier, known);
      if (target === undefined) {
        if (specifier.startsWith('.')) {
          throw new Error(`${sourcePath} imports ${specifier}, which is not part of the source`);
        }
        return undefined;
      }
      // The app's db/index.ts re-exports one kind; the output's is that kind's own.
      const placed = target === `${framework.root}/db/index.ts` ? `${framework.root}/db/${dbKind}/index.ts` : target;
      const targetOutput = placement.get(placed);
      if (targetOutput === undefined) {
        throw new Error(`${sourcePath} imports ${specifier}, which this generation leaves out`);
      }
      return relativeSpecifier(outputPath, targetOutput);
    });
    if (framework.router === 'web') content = toWebRouter(content, outputPath, 'web-router.ts');
    files.push({
      path: outputPath,
      content,
      ...(rootPath === `db/${dbKind}/instance.ts` ? { userOwned: true } : {}),
    });
  }
  return dropUnreachableSteps(files, options.steps ?? {}, catalog).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

/**
 * The step files a flow document left out, when no other file imports them
 * any more (a step another block still calls stays).
 */
function dropUnreachableSteps(
  files: GeneratedFile[],
  steps: Readonly<Record<string, readonly string[]>>,
  catalog: SourceCatalog,
): GeneratedFile[] {
  const leftOut = new Set(
    catalog.steps
      .filter((meta) => steps[meta.endpoint] !== undefined && !steps[meta.endpoint]!.includes(meta.id))
      // A step file keeps its path in the output (only db/ moves).
      .map((meta) => meta.file),
  );
  if (leftOut.size === 0) return files;
  const outputs = new Set(files.map((file) => file.path));
  const imported = new Set<string>();
  for (const file of files) {
    for (const declaration of parseImports(file.content)) {
      const target = resolveRelative(file.path, declaration.specifier, outputs);
      if (target !== undefined) imported.add(target);
    }
  }
  return files.filter((file) => !leftOut.has(file.path) || imported.has(file.path));
}

function isDisabledFeatureFile(sourcePath: string, root: string, enabled: ReadonlySet<string>): boolean {
  if (!sourcePath.startsWith(`${root}/`)) return false;
  const owner = ownerOf(sourcePath.slice(root.length + 1));
  return owner.kind === 'feature' && !enabled.has(owner.id);
}

/** Which source files the run writes, and where. */
function selectFiles(
  framework: FrameworkDefinition,
  sourceFiles: ReadonlyMap<string, string>,
  enabled: ReadonlySet<string>,
  dbKind: string,
): Map<string, string> {
  const placement = new Map<string, string>();
  const overlaid = new Set(Object.keys(framework.files));
  for (const sourcePath of sourceFiles.keys()) {
    if (!sourcePath.startsWith(`${framework.root}/`)) continue;
    const rootPath = sourcePath.slice(framework.root.length + 1);
    if (overlaid.has(rootPath)) continue;
    const owner = ownerOf(rootPath);
    if (owner.kind === 'feature' && !enabled.has(owner.id)) continue;
    if (owner.kind === 'db') {
      if (owner.id !== dbKind) continue;
      // db/<kind>/x.ts → db/x.ts: the kind's index.ts is the db/index.ts of the output.
      placement.set(sourcePath, `db/${rootPath.slice(`db/${dbKind}/`.length)}`);
      continue;
    }
    if (rootPath === 'db/index.ts') continue;
    placement.set(sourcePath, rootPath);
  }
  for (const [outputPath, sourcePath] of Object.entries(framework.files)) {
    if (!sourceFiles.has(sourcePath)) {
      throw new Error(`extract.json places ${sourcePath} at ${outputPath}, but the source has no such file`);
    }
    placement.set(sourcePath, outputPath);
  }
  return placement;
}

/** features/enabled.ts with the import and the entry of every disabled feature removed. */
export function renderEnabledFeatures(source: string, enabled: ReadonlySet<string>): string {
  const names = new Map<string, string>();
  for (const match of source.matchAll(/^import \{ ([\w$]+) \} from '\.\/([a-z0-9-]+)\/feature\.js';$/gm)) {
    names.set(match[1] ?? '', match[2] ?? '');
  }
  return source
    .split('\n')
    .filter((line) => {
      const imported = /^import \{ ([\w$]+) \} from '\.\/([a-z0-9-]+)\/feature\.js';$/.exec(line);
      if (imported) return enabled.has(imported[2] ?? '');
      const entry = /^ {2}([\w$]+),$/.exec(line);
      const id = entry ? names.get(entry[1] ?? '') : undefined;
      return id === undefined || enabled.has(id);
    })
    .join('\n');
}

const CUSTOM_SCOPES_LINE = /^export const CUSTOM_SCOPES: readonly string\[\] = \[\];$/m;

/** scopes.ts with the --scope values in CUSTOM_SCOPES. */
export function renderCustomScopes(source: string, scopes: readonly string[]): string {
  if (!CUSTOM_SCOPES_LINE.test(source)) {
    throw new Error('scopes.ts has no `export const CUSTOM_SCOPES: readonly string[] = [];` line to render');
  }
  const list = scopes.map((scope) => `'${scope}'`).join(', ');
  return source.replace(CUSTOM_SCOPES_LINE, `export const CUSTOM_SCOPES: readonly string[] = [${list}];`);
}

/**
 * A pipeline without the owner blocks of the disabled features and, with a
 * flow document, without the steps it leaves out and in the order it lists
 * (keep: the step ids of the endpoint, in order). The values a removed block
 * defined (its step's produces) that the code left still reads become
 * `const <name> = undefined;`, unless the endpoint has them before its first
 * step (initial) or a remaining step defines them. Then the bindings and the
 * imports nothing reads any more are dropped.
 */
export function transformPipeline(
  source: string,
  rootPath: string,
  enabled: ReadonlySet<string>,
  catalog: SourceCatalog,
  keep?: readonly string[],
): string {
  const endpoint = endpointOfPipeline(rootPath, catalog);
  const steps = new Map<string, StepMeta>(
    catalog.steps.filter((meta) => meta.endpoint === endpoint?.id).map((meta) => [meta.id, meta]),
  );
  const isRemoved = (block: OwnerBlock) =>
    (block.feature !== undefined && !enabled.has(block.feature)) || (keep !== undefined && !keep.includes(block.id));
  const blocks = parseOwnerBlocks(source);
  let result = source;
  if (blocks.some(isRemoved)) {
    const remaining = blocks.filter((block) => !isRemoved(block));
    const definedByRemaining = new Set(remaining.flatMap((block) => steps.get(block.id)?.produces ?? []));
    const initial = new Set(endpoint?.initial ?? []);
    const stillRead = identifiersIn(withoutImports(removeOwnerBlocks(source, isRemoved)));
    const kept = withoutImports(removeOwnerBlocks(source, isRemoved));
    result = removeOwnerBlocks(source, isRemoved, (block) =>
      (steps.get(block.id)?.produces ?? []).filter(
        (name) =>
          stillRead.has(name) && !initial.has(name) && !definedByRemaining.has(name) && !isDeclared(kept, name),
      ),
    );
  }
  if (keep !== undefined) result = reorderOwnerBlocks(result, keep);
  if (result === source) return source;
  return dropUnusedImports(dropUnusedBindings(result));
}

/** Whether the code declares the name itself (a `let` before the blocks the removed one assigned). */
function isDeclared(code: string, name: string): boolean {
  return (
    new RegExp(`\\b(?:let|const|var)\\s+${name}\\b`).test(code) ||
    new RegExp(`\\b(?:let|const|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(code)
  );
}

function withoutImports(source: string): string {
  return removeImports(source, () => true);
}

/**
 * Put the owner blocks in the order of `order`. The blocks of a pipeline sit
 * one after the other, so their run is cut into one chunk per block and the
 * chunks are put back in the new order, a blank line apart. A block whose id
 * order does not list keeps its place relative to the others.
 */
export function reorderOwnerBlocks(source: string, order: readonly string[]): string {
  const blocks = parseOwnerBlocks(source);
  if (blocks.length < 2) return source;
  const lines = source.split('\n');
  const first = blocks[0]!.startLine;
  const last = blocks[blocks.length - 1]!.endLine;
  const chunks = blocks.map((block, index) => {
    const end = index + 1 < blocks.length ? blocks[index + 1]!.startLine - 1 : block.endLine;
    const chunk = lines.slice(block.startLine, end + 1);
    while (chunk.length > 0 && chunk[chunk.length - 1]!.trim() === '') chunk.pop();
    return { id: block.id, chunk };
  });
  const rank = (id: string) => {
    const position = order.indexOf(id);
    return position === -1 ? Number.MAX_SAFE_INTEGER : position;
  };
  const sorted = chunks
    .map((chunk, index) => ({ ...chunk, index }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index);
  if (sorted.every((chunk, index) => chunk.index === index)) return source;
  const region = sorted.flatMap((chunk, index) => (index === 0 ? chunk.chunk : ['', ...chunk.chunk]));
  lines.splice(first, last - first + 1, ...region);
  return lines.join('\n');
}

/** Remove the imports whose bound names the module no longer reads. */
export function dropUnusedImports(source: string): string {
  const read = identifiersIn(withoutImports(source));
  return removeImports(
    source,
    (declaration) => declaration.names.length > 0 && declaration.names.every((name) => !read.has(name)),
  );
}

function endpointOfPipeline(rootPath: string, catalog: SourceCatalog) {
  const endpointFile = posix.join(posix.dirname(rootPath), 'endpoint.ts');
  return catalog.endpoints.find((endpoint) => endpoint.file === endpointFile);
}

/**
 * Drop the bindings of the owner blocks that nothing reads (a removed block
 * was their only reader): `const name = expr;` becomes `expr;`, and a name of
 * `const { a, b } = expr;` leaves the pattern. Without this, a project built
 * with noUnusedLocals would reject the output.
 */
export function dropUnusedBindings(source: string): string {
  const lines = source.split('\n');
  for (const block of parseOwnerBlocks(source)) {
    for (let index = block.startLine + 1; index <= block.endLine; index += 1) {
      const line = lines[index] ?? '';
      const single = /^(\s*)const ([A-Za-z_$][\w$]*) =( ?)(.*)$/.exec(line);
      const pattern = /^(\s*)const \{ ([\w$, ]+) \} = (.*)$/.exec(line);
      if (single) {
        const [, indent, name, , rest] = single;
        if (isReadElsewhere(lines, index, name ?? '')) continue;
        lines[index] = `${indent}${rest ?? ''}`;
      } else if (pattern) {
        const [, indent, namesText, rest] = pattern;
        const names = (namesText ?? '').split(',').map((name) => name.trim()).filter(Boolean);
        if (names.some((name) => name.includes(':'))) continue;
        const kept = names.filter((name) => isReadElsewhere(lines, index, name));
        if (kept.length === names.length) continue;
        lines[index] = kept.length === 0 ? `${indent}${rest ?? ''}` : `${indent}const { ${kept.join(', ')} } = ${rest ?? ''}`;
      }
    }
  }
  return lines.join('\n');
}

function isReadElsewhere(lines: readonly string[], declarationLine: number, name: string): boolean {
  const others = lines.filter((_line, index) => index !== declarationLine).join('\n');
  return identifiersIn(others).has(name);
}
