/**
 * The import boundaries of the apps the CLI extracts its generated code from
 * (apps/hono/src/oidc-provider, apps/nextjs/src/app).
 *
 * Every file there belongs to the base, to one feature or to one db kind, by
 * its path. The CLI generates a provider by copying the base, the directories
 * of the enabled features and one db kind, and by deleting the owner blocks of
 * the disabled features from the pipelines. That only yields code that
 * compiles when the files keep to these rules:
 *
 *   - the base imports no feature directory, and neither the experimental nor
 *     the google-login package; it reaches the features through the hooks of
 *     features/feature.ts and the list of features/enabled.ts
 *   - the base imports the database through db/index.ts, never one db kind
 *   - a db kind imports no feature and no other db kind
 *   - features/<a>/ imports features/<b>/ only when the registry entry of a
 *     lists b in requires (packages/cli/src/registry.ts)
 *   - a pipeline (pipeline.ts; route.ts in Next.js) uses an identifier
 *     imported from features/<id>/ only in the owner blocks of that feature
 *     (`// [step-id] (feature: <id>) ...`)
 *   - in hono, a pipeline imports only its own steps, the modules beside it,
 *     the framework and feature directories, and an owner block of a feature
 *     uses no identifier imported from elsewhere. A Next.js route.ts keeps the
 *     imports of App Router code (core, the modules of _oidc-provider/)
 *
 * Test files are not extracted and are not checked.
 *
 * Usage: node .github/scripts/lint-import-boundaries.mjs (pnpm run lint)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The roots the CLI extracts from, with the layout of their paths. */
export const EXTRACTION_ROOTS = [
  { root: 'apps/hono/src/oidc-provider', layout: 'hono' },
  { root: 'apps/nextjs/src/app', layout: 'nextjs' },
];

const REGISTRY_PATH = 'packages/cli/src/registry.ts';
const RESTRICTED_PACKAGES = ['@maronn-openid-connect/experimental', '@maronn-openid-connect/google-login'];
/** The frameworks a pipeline may import (its app, its request types). */
const FRAMEWORK_PACKAGES = ['hono', 'next', 'next/server', 'next/headers', 'next/navigation'];

/**
 * The owner of a file, by its path relative to the extraction root:
 * { kind: 'feature', id }, { kind: 'db', id } or { kind: 'base' }.
 */
export function ownerOf(path, layout) {
  const segments = path.split('/');
  if (layout === 'nextjs') {
    const group = segments.find((segment) => /^\([a-z0-9-]+\)$/.test(segment));
    if (group) return { kind: 'feature', id: group.slice(1, -1) };
    if (segments[0] === '_oidc-provider') {
      return ownerWithin(segments.slice(1));
    }
    return { kind: 'base' };
  }
  return ownerWithin(segments);
}

function ownerWithin(segments) {
  // features/feature.ts (the hooks) and features/enabled.ts (the list the CLI
  // renders) are the base's way to reach the features.
  if (segments[0] === 'features' && segments.length > 2) return { kind: 'feature', id: segments[1] };
  if (segments[0] === 'db' && segments.length > 2) return { kind: 'db', id: segments[1] };
  return { kind: 'base' };
}

/**
 * The import and re-export declarations of a module: their specifier, the
 * local names they bind (none for a re-export or a side-effect import) and the
 * line they start on.
 */
export function parseImports(source) {
  const imports = [];
  const declaration =
    /^[ \t]*(import|export)[ \t]+(?:type[ \t]+)?([^;'"]*?)[ \t]*from[ \t]*['"]([^'"]+)['"]|^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(declaration)) {
    const line = source.slice(0, match.index).split('\n').length;
    const endLine = line + match[0].split('\n').length - 1;
    if (match[4] !== undefined) {
      imports.push({ specifier: match[4], names: [], line, endLine });
      continue;
    }
    const names = match[1] === 'import' ? bindingNames(match[2]) : [];
    imports.push({ specifier: match[3], names, line, endLine });
  }
  return imports;
}

function bindingNames(clause) {
  const names = [];
  const named = clause.match(/\{([\s\S]*)\}/);
  const outside = clause.replace(/\{[\s\S]*\}/, '').trim();
  for (const part of outside.split(',').map((value) => value.trim()).filter(Boolean)) {
    const namespace = part.match(/^\*\s+as\s+([\w$]+)$/);
    names.push(namespace ? namespace[1] : part);
  }
  if (named) {
    for (const entry of named[1].split(',').map((value) => value.trim()).filter(Boolean)) {
      const withoutType = entry.replace(/^type\s+/, '');
      const alias = withoutType.match(/\s+as\s+([\w$]+)$/);
      names.push(alias ? alias[1] : withoutType);
    }
  }
  return names;
}

const MARKER = /^([ \t]*)\/\/ \[([a-z0-9-]+)\](?: \(feature: ([a-z0-9-]+)\))?/;

/**
 * The owner blocks of a pipeline: from a marker line to the line before the
 * next marker, or to the last line before the code leaves the marker's
 * indentation (the closing of the try block or the function). Lines are
 * 1-based; endLine is the last line of the block.
 */
export function parseOwnerBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(MARKER);
    if (!match) continue;
    const indent = match[1].length;
    let end = index;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (MARKER.test(line)) break;
      if (line.trim() !== '' && line.length - line.trimStart().length < indent) break;
      end = next;
    }
    blocks.push({ id: match[2], feature: match[3], startLine: index + 1, endLine: end + 1 });
  }
  return blocks;
}

/** The requires of every entry of packages/cli/src/registry.ts, by feature id. */
export function readRequires(registrySource) {
  const requires = new Map();
  const entry = /\{\s*id:\s*'([a-z0-9-]+)'[^\n]*?requires:\s*\[([^\]]*)\]/g;
  for (const match of registrySource.matchAll(entry)) {
    const ids = [...match[2].matchAll(/'([a-z0-9-]+)'/g)].map((id) => id[1]);
    requires.set(match[1], ids);
  }
  return requires;
}

function isTestFile(path) {
  return /\.test\.tsx?$/.test(path);
}

function isPipeline(path, layout) {
  const name = posix.basename(path);
  return layout === 'nextjs' ? name === 'route.ts' : name === 'pipeline.ts';
}

/**
 * features/enabled.ts (Next.js: _oidc-provider/features.ts) is the list the
 * CLI renders: it imports the feature.ts of every enabled feature, and nothing
 * else of them.
 */
function isFeatureListEntry(path, target, layout) {
  if (layout === 'nextjs') {
    return path === '_oidc-provider/features.ts' && /^_oidc-provider\/features\/[a-z0-9-]+\/feature(\.(js|ts))?$/.test(target);
  }
  return path === 'features/enabled.ts' && /^features\/[a-z0-9-]+\/feature\.(js|ts)$/.test(target);
}

/** The path a relative specifier points to, relative to the extraction root. */
function targetOf(path, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  return posix.normalize(posix.join(posix.dirname(path), specifier));
}

function isRestrictedPackage(specifier) {
  return RESTRICTED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** The identifiers a range of lines uses, without strings and comments. */
function identifiersIn(lines) {
  const code = lines
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ');
  return new Set(code.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? []);
}

/**
 * The violations of one source file at path (relative to its extraction
 * root): [{ path, line, rule, message }].
 */
export function lintSource({ path, source, layout, requires }) {
  if (isTestFile(path)) return [];
  const owner = ownerOf(path, layout);
  const imports = parseImports(source);
  const violations = [];
  const report = (line, rule, message) => violations.push({ path, line, rule, message });

  for (const { specifier, line } of imports) {
    const target = targetOf(path, specifier);
    const targetOwner = target === undefined ? undefined : ownerOf(target, layout);

    if (owner.kind === 'base') {
      if (isRestrictedPackage(specifier)) {
        report(line, 'base-imports-experimental', `the base must not import ${specifier}; move the code into a feature directory`);
      }
      if (targetOwner?.kind === 'feature' && !isPipeline(path, layout) && !isFeatureListEntry(path, target, layout)) {
        report(line, 'base-imports-feature', `the base must not import features/${targetOwner.id}/; use a hook of features/feature.ts`);
      }
      if (targetOwner?.kind === 'db' && path !== 'db/index.ts' && path !== '_oidc-provider/db/index.ts') {
        report(line, 'base-imports-db-kind', `the base must import the database through db/index.ts, not db/${targetOwner.id}/`);
      }
    }
    if (owner.kind === 'db') {
      if (targetOwner?.kind === 'feature') {
        report(line, 'db-imports-feature', `db/${owner.id}/ must not import features/${targetOwner.id}/`);
      }
      if (targetOwner?.kind === 'db' && targetOwner.id !== owner.id) {
        report(line, 'db-imports-other-db', `db/${owner.id}/ must not import db/${targetOwner.id}/`);
      }
    }
    // A pipeline of a feature may hold the owner blocks of another feature;
    // lintPipeline() checks that their imports stay inside them.
    if (
      owner.kind === 'feature' &&
      targetOwner?.kind === 'feature' &&
      targetOwner.id !== owner.id &&
      !isPipeline(path, layout)
    ) {
      const required = requires.get(owner.id) ?? [];
      if (!required.includes(targetOwner.id)) {
        report(
          line,
          'feature-imports-unrequired-feature',
          `features/${owner.id}/ imports features/${targetOwner.id}/ without requires: ['${targetOwner.id}'] in ${REGISTRY_PATH}`,
        );
      }
    }
  }

  if (isPipeline(path, layout)) {
    violations.push(...lintPipeline({ path, source, layout, owner, imports }));
  }
  return violations;
}

function lintPipeline({ path, source, layout, owner, imports }) {
  const violations = [];
  const report = (line, rule, message) => violations.push({ path, line, rule, message });
  // Which import each local name comes from, and the feature that owns it.
  const origins = new Map();
  for (const { specifier, names, line } of imports) {
    const target = targetOf(path, specifier);
    const targetOwner = target === undefined ? undefined : ownerOf(target, layout);
    const beside = specifier.startsWith('./') && !specifier.slice(2).includes('/');
    const ownSteps = specifier.startsWith('./steps/');
    const feature = targetOwner?.kind === 'feature' && targetOwner.id !== (owner.kind === 'feature' ? owner.id : undefined)
      ? targetOwner.id
      : undefined;
    if (layout === 'hono' && !(beside || ownSteps || feature !== undefined || FRAMEWORK_PACKAGES.includes(specifier))) {
      report(
        line,
        'pipeline-import-not-allowed',
        `a pipeline imports only its steps, the modules beside it, the framework and feature directories; import ${specifier} in a step`,
      );
    }
    for (const name of names) origins.set(name, { feature, line });
  }

  const lines = source.split('\n');
  const blocks = parseOwnerBlocks(source);
  const inBlock = new Set();
  for (const block of blocks) {
    for (let number = block.startLine; number <= block.endLine; number += 1) inBlock.add(number);
    const used = identifiersIn(lines.slice(block.startLine - 1, block.endLine));
    for (const name of used) {
      const origin = origins.get(name);
      if (origin === undefined) continue;
      if (origin.feature !== undefined && origin.feature !== block.feature) {
        report(
          block.startLine,
          'feature-import-outside-its-block',
          `${name} comes from features/${origin.feature}/ but is used in the block [${block.id}]${block.feature ? ` of ${block.feature}` : ''}`,
        );
      }
      if (layout === 'hono' && block.feature !== undefined && origin.feature === undefined) {
        report(
          block.startLine,
          'feature-block-uses-base-import',
          `the block [${block.id}] of ${block.feature} uses ${name}, which is not imported from features/${block.feature}/; pass the value in as an input of the step`,
        );
      }
    }
  }

  // Outside every block and every import declaration (the try / catch around
  // the blocks, the helpers of the file).
  const inImport = new Set();
  for (const { line, endLine } of imports) {
    for (let number = line; number <= endLine; number += 1) inImport.add(number);
  }
  const outside = lines.filter(
    (_, index) => !inBlock.has(index + 1) && !inImport.has(index + 1) && !/^\s*(import|export)\s/.test(lines[index]),
  );
  for (const name of identifiersIn(outside)) {
    const origin = origins.get(name);
    if (origin?.feature !== undefined) {
      report(
        origin.line,
        'feature-import-outside-its-block',
        `${name} comes from features/${origin.feature}/ but is used outside the owner blocks of that feature`,
      );
    }
  }
  return violations;
}

function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules') continue;
      files.push(...listSourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

/** The violations of every extraction root that exists under repositoryRoot. */
export function lintRepository(repositoryRoot) {
  const requires = readRequires(readFileSync(join(repositoryRoot, REGISTRY_PATH), 'utf8'));
  const violations = [];
  for (const { root, layout } of EXTRACTION_ROOTS) {
    const directory = join(repositoryRoot, root);
    if (!existsSync(directory)) continue;
    for (const file of listSourceFiles(directory)) {
      const path = relative(directory, file).split('\\').join('/');
      const source = readFileSync(file, 'utf8');
      for (const violation of lintSource({ path, source, layout, requires })) {
        violations.push({ ...violation, path: `${root}/${violation.path}` });
      }
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const violations = lintRepository(repositoryRoot);
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line}: ${violation.rule}: ${violation.message}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} import boundary violation(s).`);
    process.exitCode = 1;
  } else {
    console.log('Import boundaries verified.');
  }
}
