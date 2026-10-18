/**
 * Generate the provider by extracting it from the app of the framework
 * (extract.json): the base, the directories of the enabled features and one
 * db kind, with the owner blocks of the disabled features removed from the
 * pipelines.
 *
 * 1. Resolve the features (registry.ts) and the db kind.
 * 2. Select the files: every file of the base, the files of the enabled
 *    features, and the files of one db kind (memory without --db) moved up
 *    into the db directory, whose index.ts is the one of that kind. A
 *    feature owns features/<id>/** in the hono layout, and its route group
 *    (<id>)/** and _oidc-provider/features/<id>/** in the Next.js layout.
 * 3. Render the feature list (features/enabled.ts; _oidc-provider/features.ts)
 *    with the lines of the enabled features, and the custom scopes of
 *    scopes.ts. The manifest is written by the caller.
 * 4. Remove the owner blocks of the disabled features and their imports from
 *    the pipelines (pipeline.ts; route.ts). A value such a block defined that
 *    later code still reads becomes `const <name> = undefined;` (from the
 *    produces of its step: the step meta of the catalog, or the endpoint.ts
 *    beside a route.ts), and a value nothing reads any more loses its binding.
 * 5. Move the relative imports to the output layout and point
 *    @maronn-openid-connect/core at the package name of the run. Express and
 *    Fastify also get Hono replaced with the WebRouter (web.ts).
 */
import { posix } from 'node:path';
import type { DbKind } from './db.js';
import type { GeneratedFile } from './generated-file.js';
import { enabledFeatureIds, type OidcFeatureConfig } from './registry.js';
import { evaluateLiteral, literalArgumentOf, type SourceCatalog } from './extract/meta.js';
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

type Layout = FrameworkDefinition['layout'];
type Owner = { kind: 'base' } | { kind: 'feature' | 'db'; id: string };

/**
 * The owner of a path under the extraction root. In the Next.js layout a
 * route group (<id>) and _oidc-provider/features/<id>/ belong to the feature,
 * and _oidc-provider/db/<kind>/ to the db kind.
 */
function ownerOf(path: string, layout: Layout): Owner {
  const segments = path.split('/');
  if (layout === 'nextjs') {
    const group = segments.find((segment) => /^\([a-z0-9-]+\)$/.test(segment));
    if (group !== undefined) return { kind: 'feature', id: group.slice(1, -1) };
    return segments[0] === '_oidc-provider' ? ownerWithin(segments.slice(1)) : { kind: 'base' };
  }
  return ownerWithin(segments);
}

function ownerWithin(segments: readonly string[]): Owner {
  if (segments[0] === 'features' && segments.length > 2) return { kind: 'feature', id: segments[1] ?? '' };
  if (segments[0] === 'db' && segments.length > 2) return { kind: 'db', id: segments[1] ?? '' };
  return { kind: 'base' };
}

/** Where the files the generator renders or moves sit in a layout. */
function layoutPaths(layout: Layout): { featureList: string; scopes: string; db: string } {
  return layout === 'nextjs'
    ? { featureList: '_oidc-provider/features.ts', scopes: '_oidc-provider/scopes.ts', db: '_oidc-provider/db' }
    : { featureList: 'features/enabled.ts', scopes: 'scopes.ts', db: 'db' };
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
  // The step meta of the hono layout; a Next.js route.ts has its endpoint.ts.
  const catalog: SourceCatalog =
    framework.layout === 'hono'
      ? readSourceCatalog(framework.source, framework.root, sourceFiles, definition)
      : { files: [], steps: [], endpoints: [], contributions: [] };
  const enabled = new Set(enabledFeatureIds(options.features));
  const dbKind = options.db ?? 'memory';
  const paths = layoutPaths(framework.layout);

  // Source path (under the source directory) → output path.
  const placement = selectFiles(framework, sourceFiles, enabled, dbKind);
  const known = new Set(sourceFiles.keys());
  const files: GeneratedFile[] = [];
  for (const [sourcePath, outputPath] of placement) {
    let content = sourceFiles.get(sourcePath) ?? '';
    const rootPath = sourcePath.startsWith(`${framework.root}/`) ? sourcePath.slice(framework.root.length + 1) : undefined;

    if (rootPath === paths.featureList) content = renderEnabledFeatures(content, enabled);
    if (rootPath === paths.scopes) content = renderCustomScopes(content, options.scopes ?? []);
    if (framework.layout === 'nextjs' && rootPath !== undefined && /(^|\/)route\.ts$/.test(rootPath)) {
      const endpointSource = sourceFiles.get(posix.join(posix.dirname(sourcePath), 'endpoint.ts'));
      content = transformRouteHandler(content, enabled, endpointSource);
    }
    if (framework.layout === 'nextjs' && rootPath !== undefined && /(^|\/)endpoint\.ts$/.test(rootPath)) {
      content = withoutDisabledSteps(content, enabled);
    }
    if (framework.layout === 'hono' && rootPath !== undefined && /(^|\/)pipeline\.ts$/.test(rootPath)) {
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
      return target !== undefined && isDisabledFeatureFile(target, framework, enabled);
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
      const placed =
        target === `${framework.root}/${paths.db}/index.ts` ? `${framework.root}/${paths.db}/${dbKind}/index.ts` : target;
      const targetOutput = placement.get(placed);
      if (targetOutput === undefined) {
        throw new Error(`${sourcePath} imports ${specifier}, which this generation leaves out`);
      }
      if (framework.layout === 'nextjs') {
        // Next.js imports without extensions, and a directory for its index.ts.
        const directory = /\/index\.tsx?$/.test(targetOutput) && !/\/index(\.[jt]sx?)?$/.test(specifier);
        return relativeSpecifier(outputPath, targetOutput, { extensionless: true, directory });
      }
      return relativeSpecifier(outputPath, targetOutput);
    });
    if (framework.router === 'web') content = toWebRouter(content, outputPath, 'web-router.ts');
    files.push({
      path: outputPath,
      content,
      ...(rootPath === `${paths.db}/${dbKind}/instance.ts` ? { userOwned: true } : {}),
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

function isDisabledFeatureFile(sourcePath: string, framework: FrameworkDefinition, enabled: ReadonlySet<string>): boolean {
  if (!sourcePath.startsWith(`${framework.root}/`)) return false;
  const owner = ownerOf(sourcePath.slice(framework.root.length + 1), framework.layout);
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
  const db = layoutPaths(framework.layout).db;
  for (const sourcePath of sourceFiles.keys()) {
    if (!sourcePath.startsWith(`${framework.root}/`)) continue;
    const rootPath = sourcePath.slice(framework.root.length + 1);
    if (overlaid.has(rootPath)) continue;
    const owner = ownerOf(rootPath, framework.layout);
    if (owner.kind === 'feature' && !enabled.has(owner.id)) continue;
    if (owner.kind === 'db') {
      if (owner.id !== dbKind) continue;
      // db/<kind>/x.ts → db/x.ts: the kind's index.ts is the db/index.ts of the output.
      placement.set(sourcePath, `${db}/${rootPath.slice(`${db}/${dbKind}/`.length)}`);
      continue;
    }
    if (rootPath === `${db}/index.ts`) continue;
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

/** One import line of the feature list: `./<id>/feature.js` (hono) or `./features/<id>/feature` (Next.js). */
const FEATURE_IMPORT = /^import \{ ([\w$]+) \} from '\.\/(?:features\/)?([a-z0-9-]+)\/feature(?:\.js)?';$/;

/** The feature list with the import and the entry of every disabled feature removed. */
export function renderEnabledFeatures(source: string, enabled: ReadonlySet<string>): string {
  const names = new Map<string, string>();
  for (const line of source.split('\n')) {
    const match = FEATURE_IMPORT.exec(line);
    if (match) names.set(match[1] ?? '', match[2] ?? '');
  }
  return source
    .split('\n')
    .filter((line) => {
      const imported = FEATURE_IMPORT.exec(line);
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
  const produces = new Map<string, readonly string[]>(
    catalog.steps.filter((meta) => meta.endpoint === endpoint?.id).map((meta) => [meta.id, meta.produces]),
  );
  const isRemoved = (block: OwnerBlock) =>
    (block.feature !== undefined && !enabled.has(block.feature)) || (keep !== undefined && !keep.includes(block.id));
  let result = removeBlocks(source, isRemoved, produces, new Set(endpoint?.initial ?? []));
  if (keep !== undefined) result = reorderOwnerBlocks(result, keep);
  if (result === source) return source;
  return dropUnusedImports(dropUnusedBindings(result));
}

/**
 * A Next.js route.ts without the owner blocks of the disabled features. The
 * produces of each step come from the endpoint.ts beside it
 * (defineEndpoint({ steps: [{ id, produces }] })).
 */
export function transformRouteHandler(
  source: string,
  enabled: ReadonlySet<string>,
  endpointSource: string | undefined,
): string {
  const isRemoved = (block: OwnerBlock) => block.feature !== undefined && !enabled.has(block.feature);
  if (!parseOwnerBlocks(source).some(isRemoved)) return source;
  if (endpointSource === undefined) {
    throw new Error('A route.ts with owner blocks needs the endpoint.ts beside it that lists its steps');
  }
  const result = removeBlocks(source, isRemoved, routeStepProduces(endpointSource), new Set());
  return dropUnusedImports(dropUnusedBindings(result));
}

/** The produces of each step of an endpoint.ts of the Next.js layout. */
function routeStepProduces(endpointSource: string): Map<string, readonly string[]> {
  const literal = literalArgumentOf(endpointSource, 'defineEndpoint');
  if (literal === undefined) throw new Error('endpoint.ts has no defineEndpoint({ ... }) to read the steps from');
  const meta = evaluateLiteral(literal) as { steps?: { id: string; produces?: string[] }[] };
  return new Map((meta.steps ?? []).map((step) => [step.id, step.produces ?? []]));
}

/** An endpoint.ts of the Next.js layout without the step lines of the disabled features. */
export function withoutDisabledSteps(source: string, enabled: ReadonlySet<string>): string {
  return source
    .split('\n')
    .filter((line) => {
      const feature = /^\s*\{ id: '[a-z0-9-]+', feature: '([a-z0-9-]+)'/.exec(line)?.[1];
      return feature === undefined || enabled.has(feature);
    })
    .join('\n');
}

/**
 * The source without the blocks isRemoved picks. The values a removed block
 * defined (produces of its step) that the code left still reads become
 * `const <name> = undefined;`, unless they are there before the first step
 * (initial), a remaining step defines them, or the code declares them itself.
 */
function removeBlocks(
  source: string,
  isRemoved: (block: OwnerBlock) => boolean,
  produces: ReadonlyMap<string, readonly string[]>,
  initial: ReadonlySet<string>,
): string {
  const blocks = parseOwnerBlocks(source);
  if (!blocks.some(isRemoved)) return source;
  const remaining = blocks.filter((block) => !isRemoved(block));
  const definedByRemaining = new Set(remaining.flatMap((block) => produces.get(block.id) ?? []));
  const kept = withoutImports(removeOwnerBlocks(source, isRemoved));
  const stillRead = identifiersIn(kept);
  return removeOwnerBlocks(source, isRemoved, (block) =>
    (produces.get(block.id) ?? []).filter(
      (name) => stillRead.has(name) && !initial.has(name) && !definedByRemaining.has(name) && !isDeclared(kept, name),
    ),
  );
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
