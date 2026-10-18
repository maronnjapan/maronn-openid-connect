/**
 * The text operations the generator applies to the files it extracts from
 * apps/: reading the import declarations, moving relative imports to the
 * output layout, and finding and removing the owner blocks of the pipelines.
 *
 * Everything works on lines and paths, never on a syntax tree: the CLI has no
 * runtime dependencies, so it cannot load the TypeScript compiler. The apps
 * keep to the shapes these functions read (one declaration per import, one
 * marker comment per block); .github/scripts/lint-import-boundaries.mjs checks
 * the rules that make that safe.
 */
import { posix } from 'node:path';

/** One import or re-export declaration with a module specifier. */
export interface ImportDeclaration {
  /** Offset of the first character of the declaration's line. */
  start: number;
  /** Offset just past the declaration's line break. */
  end: number;
  specifier: string;
  /** The local names it binds; none for a re-export or a side-effect import. */
  names: string[];
}

const DECLARATION =
  /^[ \t]*(import|export)[ \t]+(?:type[ \t]+)?((?:[\w$]+[ \t]*,[ \t]*)?(?:\{[^}]*\}|\*(?:[ \t]+as[ \t]+[\w$]+)?)|[\w$]+)[ \t]*from[ \t]*(['"])([^'"\n]+)\3[ \t]*;?[ \t]*(?:\r?\n|$)/gm;
const SIDE_EFFECT = /^[ \t]*import[ \t]*(['"])([^'"\n]+)\1[ \t]*;?[ \t]*(?:\r?\n|$)/gm;

/** The import and re-export declarations of a module, in source order. */
export function parseImports(source: string): ImportDeclaration[] {
  const declarations: ImportDeclaration[] = [];
  for (const match of source.matchAll(DECLARATION)) {
    const kind = match[1];
    const clause = match[2] ?? '';
    declarations.push({
      start: match.index,
      end: match.index + match[0].length,
      specifier: match[4] ?? '',
      names: kind === 'import' ? bindingNames(clause) : [],
    });
  }
  for (const match of source.matchAll(SIDE_EFFECT)) {
    declarations.push({ start: match.index, end: match.index + match[0].length, specifier: match[2] ?? '', names: [] });
  }
  return declarations.sort((a, b) => a.start - b.start);
}

function bindingNames(clause: string): string[] {
  const names: string[] = [];
  const named = /\{([^}]*)\}/.exec(clause);
  const outside = clause.replace(/\{[^}]*\}/, '');
  for (const part of outside.split(',').map((value) => value.trim()).filter(Boolean)) {
    const namespace = /^\*\s+as\s+([\w$]+)$/.exec(part);
    names.push(namespace?.[1] ?? part);
  }
  for (const entry of (named?.[1] ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    const withoutType = entry.replace(/^type\s+/, '');
    const alias = /\s+as\s+([\w$]+)$/.exec(withoutType);
    names.push(alias?.[1] ?? withoutType);
  }
  return names;
}

/** Remove the declarations the predicate selects, whole lines included. */
export function removeImports(source: string, select: (declaration: ImportDeclaration) => boolean): string {
  let result = source;
  for (const declaration of parseImports(source).reverse()) {
    if (select(declaration)) {
      result = result.slice(0, declaration.start) + result.slice(declaration.end);
    }
  }
  return result;
}

/** Replace the specifier of every declaration with what map returns for it (unchanged for undefined). */
export function mapSpecifiers(source: string, map: (specifier: string) => string | undefined): string {
  let result = source;
  for (const declaration of parseImports(source).reverse()) {
    const replacement = map(declaration.specifier);
    if (replacement === undefined || replacement === declaration.specifier) continue;
    const text = result.slice(declaration.start, declaration.end);
    const replaced = text.replace(
      new RegExp(`(['"])${escapeRegExp(declaration.specifier)}\\1`),
      (_quoted, quote: string) => `${quote}${replacement}${quote}`,
    );
    result = result.slice(0, declaration.start) + replaced + result.slice(declaration.end);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The source file a relative specifier points to, among the known source
 * paths: a `.js` specifier names its `.ts` or `.tsx` file, and a directory its
 * index. undefined for a package specifier or a path that is not known.
 */
export function resolveRelative(fromPath: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const stem = target.replace(/\.(js|ts|tsx|jsx)$/, '');
  for (const candidate of [target, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The relative specifier from one output file to another: with the .js
 * extension TypeScript expects (the hono layout), or without an extension, the
 * way a Next.js app imports (`./x`, and `./dir` for dir/index.ts).
 */
export function relativeSpecifier(
  fromOutput: string,
  toOutput: string,
  style: { extensionless?: boolean; directory?: boolean } = {},
): string {
  const target = style.directory ? posix.dirname(toOutput) : toOutput;
  const relative = style.extensionless
    ? posix.relative(posix.dirname(fromOutput), target).replace(/\.(ts|tsx)$/, '')
    : posix.relative(posix.dirname(fromOutput), target).replace(/\.(ts|tsx)$/, '.js');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/** One owner block of a pipeline: a marker line and the statements under it. */
export interface OwnerBlock {
  /** The step id of the marker. */
  id: string;
  /** The feature that owns the block; undefined for a block of the base. */
  feature: string | undefined;
  /** 0-based index of the marker line. */
  startLine: number;
  /** 0-based index of the last line of the block. */
  endLine: number;
  /** The indentation of the marker. */
  indent: string;
}

const MARKER = /^([ \t]*)\/\/ \[([a-z0-9-]+)\](?: \(feature: ([a-z0-9-]+)\))?/;

/**
 * The owner blocks of a pipeline. A block runs from its marker line to the
 * line before the next marker, or to the last line before the code leaves the
 * marker's indentation (the closing of the try block or the function).
 * Trailing blank lines stay outside the block.
 */
export function parseOwnerBlocks(source: string): OwnerBlock[] {
  const lines = source.split('\n');
  const blocks: OwnerBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = MARKER.exec(lines[index] ?? '');
    if (!match) continue;
    const indent = match[1] ?? '';
    let end = index;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? '';
      if (MARKER.test(line)) break;
      if (line.trim() !== '' && line.length - line.trimStart().length < indent.length) break;
      if (line.trim() !== '') end = next;
    }
    blocks.push({ id: match[2] ?? '', feature: match[3], startLine: index, endLine: end, indent });
  }
  return blocks;
}

/**
 * Remove the blocks of the features remove() selects. A removed block that
 * defined values later code still reads is replaced by `const <name> =
 * undefined;` for each of them (fallbacks(block) returns the names).
 */
export function removeOwnerBlocks(
  source: string,
  remove: (block: OwnerBlock) => boolean,
  fallbacks: (block: OwnerBlock) => readonly string[] = () => [],
): string {
  const lines = source.split('\n');
  const blocks = parseOwnerBlocks(source).filter(remove);
  for (const block of [...blocks].reverse()) {
    const replacement = fallbacks(block).map((name) => `${block.indent}const ${name} = undefined;`);
    let removeTo = block.endLine;
    // A removed block takes the blank line after it along, so the blocks
    // around it stay one blank line apart.
    if (replacement.length === 0 && (lines[removeTo + 1] ?? '').trim() === '') removeTo += 1;
    lines.splice(block.startLine, removeTo - block.startLine + 1, ...replacement);
  }
  return lines.join('\n');
}

/** The identifiers a piece of code uses, without its strings and comments. */
export function identifiersIn(code: string): Set<string> {
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    // A spread is no property access: ...name reads name.
    .replace(/\.\.\./g, ' ');
  return new Set(stripped.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? []);
}
