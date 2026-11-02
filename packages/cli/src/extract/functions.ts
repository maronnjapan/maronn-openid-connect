/**
 * The functions of the provider and its libraries, read from the source text:
 * the function catalog.
 *
 * A card describes one function declaration (`function name(...) {...}`,
 * exported or not) of a root: a library package (core, experimental,
 * google-login) or an extracted app source (hono, nextjs). The card carries
 * what its JSDoc says — the summary (its first paragraph), the specification
 * sections (`@spec`, or the references the text names), what it throws — and
 * what its body calls: the functions of the catalog it calls by name, in the
 * order of their first call, resolved through the imports of the file.
 *
 * `maronn-oidc explain` walks the cards from a step of the generated code down
 * to the functions of core, and back up from a function to the steps,
 * endpoints and features that use it. Like the step meta (meta.ts), the cards
 * are read without a compiler and without importing the modules: the
 * repository rules keep a function's JSDoc right above its declaration and
 * declare functions with `function`, not as arrow constants, so the text is
 * enough.
 *
 * A call the text does not show — a method of a resolver or a store the
 * request context holds, a hook a feature registers — is not in a card. The
 * step meta lists those in its `calls`.
 */
import { posix } from 'node:path';
import { codeOf, type StepKind } from './meta.js';

/** The responsibility of a function: the step kinds, or `other` for one the name does not tell. */
export type FunctionKind = StepKind | 'other';

/** One function of a root. */
export interface FunctionCard {
  /** `<root>:<module>#<name>`, unique in the catalog. */
  id: string;
  name: string;
  /** The root the function is in: a library (core, experimental, google-login) or an app source (hono, nextjs). */
  package: string;
  /** The file, relative to the root. */
  module: string;
  /** The line of the declaration (1-based). */
  line: number;
  exported: boolean;
  kind: FunctionKind;
  /** The first paragraph of the JSDoc; empty without one. */
  summary: string;
  /** The rest of the JSDoc text, tags left out. */
  description?: string;
  /** The specification sections (`@spec` tags, or the references the JSDoc names). */
  spec?: string[];
  /** What the function throws (`@throws` tags, and the errors its body constructs). */
  throws?: string[];
  /** The functions of the catalog the body calls, by id, in order of the first call. */
  calls: string[];
  /** The functions of the catalog whose body calls this one, by id. */
  calledBy: string[];
}

export interface FunctionCatalog {
  version: 1;
  /** Every card, by id. */
  functions: Record<string, FunctionCard>;
}

/** A root the catalog reads: the files of a library package or of an app source. */
export interface FunctionRoot {
  /** The name of the root, the first part of every id (core, hono, ...). */
  name: string;
  /** The package specifier other roots import the root by; absent for an app source. */
  specifier?: string;
  /** The files of the root (path relative to the root → text), tests left out. */
  files: ReadonlyMap<string, string>;
}

export interface FunctionProject {
  catalog: FunctionCatalog;
  /**
   * The functions of the catalog the code of a file calls between two offsets,
   * by id, in order of the first call (a block of a Route Handler, for one).
   */
  callsIn(root: string, path: string, start: number, end: number): string[];
  /** The top-level function declaration of a file whose body holds an offset, with the body's range. */
  enclosingBody(root: string, path: string, offset: number): { start: number; end: number } | undefined;
}

/** The keywords and operators a `name(` may be, which are not calls. */
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'yield', 'void', 'delete',
  'throw', 'else', 'do', 'in', 'of', 'instanceof', 'import', 'super', 'this', 'new', 'async', 'case', 'with',
]);

/** A function's verb decides its kind; `@kind` in the JSDoc overrides. The first match wins. */
const KIND_OF_VERB: ReadonlyArray<readonly [RegExp, FunctionKind]> = [
  [/^(respond|render|redirect|reply|answer)(?=[A-Z]|$)/, 'respond'],
  [/^(parse|extract|read)(?=[A-Z]|$)/, 'parse'],
  [/^(resolve|find|lookup|load|fetch|select|get|pick|locate)(?=[A-Z]|$)/, 'resolve'],
  [/^(validate|verify|require|reject|assert|check|ensure|match|confirm|authenticate)(?=[A-Z]|$)/, 'validate'],
  [/^(decide|should|is|has|can|requires|apply|determine|needs|accepts|allows|supports|evaluate|matches|returns)(?=[A-Z]|$)/, 'decide'],
  [/^(dispatch|redeem|exchange|handle|route|process|run|submit|prepare|approve|deny|continue)(?=[A-Z]|$)/, 'dispatch'],
  [/^(issue|generate|create|mint|sign|establish|start|open)(?=[A-Z]|$)/, 'issue'],
  [/^(persist|record|store|save|consume|revoke|delete|remove|complete|mark|register|clear|rotate|update|set|put|bind)(?=[A-Z]|$)/, 'persist'],
  [/^(build|compute|encode|decode|format|normalize|to|filter|derive|hash|describe|merge|map|convert|serialize|strip|split|join|compare|list|sort|wrap|with|without|restore|sanitize|copy|import|export|define)(?=[A-Z]|$)/, 'transform'],
];

const FUNCTION_KINDS: ReadonlySet<string> = new Set<string>([
  'parse', 'resolve', 'validate', 'decide', 'dispatch', 'issue', 'persist', 'transform', 'respond', 'other',
]);

/**
 * A reference to a specification section in prose: the document, then the
 * sections (`§3.1.3.6 / §12.1`, `Section 2.3`). Used when a JSDoc has no
 * `@spec` tag.
 */
const SPEC_REFERENCE =
  /(?:OIDC (?:Core|Discovery|Session|Registration|Front-Channel Logout|Back-Channel Logout) 1\.0|OpenID Connect [A-Za-z -]+? 1\.0|RP-Initiated Logout 1\.0|CIBA Core 1\.0|OAuth 2\.[01](?: (?:Multiple Response Type Encoding Practices|Form Post Response Mode|Token Exchange|Device Authorization Grant|Security BCP))?|RFC ?\d{4}|JARM|ID-JAG draft|FAPI [\d.]+)(?:\s*(?:§|Section\s+|Sec\.\s*)\s*\d+(?:\.\d+)*(?:\s*\/\s*(?:§\s*|Section\s+)?\d+(?:\.\d+)*)*)?/g;

/** A function kind the name tells, or `other`. */
export function inferFunctionKind(name: string): FunctionKind {
  for (const [verb, kind] of KIND_OF_VERB) {
    if (verb.test(name)) return kind;
  }
  return 'other';
}

/** `Section 2.3` → `§2.3`, so the same section reads the same way wherever it was written. */
function normalizeSpec(text: string): string {
  return text
    .replace(/\bSection\s+/g, '§')
    .replace(/\bSec\.\s*/g, '§')
    .replace(/§\s+/g, '§')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The specification references a text names, each once, in order. */
export function specReferencesOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(SPEC_REFERENCE)) {
    const reference = normalizeSpec(match[0]);
    if (!found.includes(reference)) found.push(reference);
  }
  return found;
}

/** What a JSDoc block says: the paragraphs of its text and its tags. */
export interface JsDoc {
  summary: string;
  description: string;
  /** Tag name → the texts of that tag, in order. */
  tags: Map<string, string[]>;
}

/** Read a `/** ... *\/` block. */
export function parseJsDoc(comment: string): JsDoc {
  const body = comment.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  const lines = body.split('\n').map((line) => line.replace(/^\s*\*\s?/, '').trimEnd());
  // Lines before the first tag are the text; a tag runs to the next tag.
  const textLines: string[] = [];
  const tags = new Map<string, string[]>();
  let current: { name: string; lines: string[] } | undefined;
  for (const line of lines) {
    const tag = /^@([a-zA-Z]+)\s?(.*)$/.exec(line);
    if (tag) {
      if (current) pushTag(tags, current);
      current = { name: tag[1] as string, lines: [tag[2] ?? ''] };
    } else if (current) {
      current.lines.push(line);
    } else {
      textLines.push(line);
    }
  }
  if (current) pushTag(tags, current);
  // Paragraphs are separated by blank lines; the first is the summary.
  const paragraphs: string[][] = [[]];
  for (const line of textLines) {
    if (line.trim() === '') {
      if ((paragraphs[paragraphs.length - 1] as string[]).length > 0) paragraphs.push([]);
      continue;
    }
    (paragraphs[paragraphs.length - 1] as string[]).push(line.trim());
  }
  const joined = paragraphs.filter((lines) => lines.length > 0).map((lines) => lines.join(' '));
  return {
    summary: joined[0] ?? '',
    description: joined.slice(1).join('\n\n'),
    tags,
  };
}

function pushTag(tags: Map<string, string[]>, tag: { name: string; lines: string[] }): void {
  const text = tag.lines.map((line) => line.trim()).filter((line) => line.length > 0).join(' ');
  const list = tags.get(tag.name) ?? [];
  list.push(text);
  tags.set(tag.name, list);
}

/** A top-level function declaration of a file. */
interface Declaration {
  name: string;
  exported: boolean;
  /** The offset of the declaration (its `export`, or its `function`). */
  index: number;
  /** The JSDoc right above it, if any. */
  jsdoc?: string;
  /** The range of the body, braces included; undefined for a declaration without one (an overload). */
  body?: { start: number; end: number };
}

interface ImportBinding {
  /** The name the file uses. */
  local: string;
  /** The name the module exports (differs with `as`). */
  imported: string;
  specifier: string;
}

/** One file of a root, parsed. */
interface ParsedFile {
  root: string;
  path: string;
  source: string;
  /** 1 where the character is code (not a string, not a comment). */
  code: Uint8Array;
  imports: Map<string, ImportBinding>;
  declarations: Declaration[];
  /** The file re-exports from other modules (`export { x } from`, `export * from`). */
  barrel: boolean;
}

function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  for (const { index } of codeOf(source, 0)) mask[index] = 1;
  return mask;
}

/** The named imports of a file: `import { a, type b, c as d } from '...'`. */
function parseImports(source: string): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  const pattern = /import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2] as string;
    for (const part of (match[1] as string).split(',')) {
      const entry = part.replace(/\btype\b/, '').trim();
      if (entry === '') continue;
      const [imported, local] = entry.split(/\s+as\s+/).map((name) => name.trim()) as [string, string?];
      imports.set(local ?? imported, { local: local ?? imported, imported, specifier });
    }
  }
  return imports;
}

/** The end (exclusive) of the balanced group that opens at `open` (a `(`, `<` or `{`), or -1. */
function closeOf(file: ParsedFile, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let index = open; index < file.source.length; index += 1) {
    if (file.code[index] !== 1) continue;
    const char = file.source[index];
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** The next offset at or after `from` whose character is code and not whitespace. */
function nextCode(file: ParsedFile, from: number): number {
  for (let index = from; index < file.source.length; index += 1) {
    if (file.code[index] === 1 && !/\s/.test(file.source[index] as string)) return index;
  }
  return -1;
}

/**
 * The body of a function declaration whose name ends at `afterName`: skip the
 * type parameters and the parameter list, then the return type. A brace
 * group of the return type is followed by `{`, `|`, `&`, `[` or `)`; the body
 * is the first brace group that is not, outside any `<...>`.
 */
function bodyOf(file: ParsedFile, afterName: number): { start: number; end: number } | undefined {
  let index = nextCode(file, afterName);
  if (index === -1) return undefined;
  if (file.source[index] === '<') {
    index = closeOf(file, index, '<', '>');
    if (index === -1) return undefined;
    index = nextCode(file, index);
  }
  if (index === -1 || file.source[index] !== '(') return undefined;
  index = closeOf(file, index, '(', ')');
  if (index === -1) return undefined;
  let angle = 0;
  for (; index < file.source.length; index += 1) {
    if (file.code[index] !== 1) continue;
    const char = file.source[index];
    if (char === ';') return undefined;
    if (char === '<') angle += 1;
    else if (char === '>' && file.source[index - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (char === '{') {
      const end = closeOf(file, index, '{', '}');
      if (end === -1) return undefined;
      const next = nextCode(file, end);
      const nextChar = next === -1 ? '' : (file.source[next] as string);
      if (angle === 0 && (nextChar === '' || !'{|&[)'.includes(nextChar))) return { start: index, end };
      index = end - 1;
    }
  }
  return undefined;
}

/** The JSDoc block whose end is right above `index` (only whitespace between), if any. */
function jsDocAbove(source: string, index: number): string | undefined {
  let end = index;
  while (end > 0 && /\s/.test(source[end - 1] as string)) end -= 1;
  if (!source.endsWith('*/', end)) return undefined;
  const start = source.lastIndexOf('/**', end - 2);
  if (start === -1) return undefined;
  // The block must be the one that ends here, not an earlier one.
  if (source.indexOf('*/', start + 3) !== end - 2) return undefined;
  return source.slice(start, end);
}

function parseFile(root: string, path: string, source: string): ParsedFile {
  const file: ParsedFile = {
    root,
    path,
    source,
    code: codeMask(source),
    imports: parseImports(source),
    declarations: [],
    barrel: /^export\s+(?:\*|\{[^}]*\})\s*from\s/m.test(source),
  };
  const pattern = /^(export\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(pattern)) {
    const index = match.index as number;
    if (file.code[index] !== 1) continue;
    const name = match[3] as string;
    const declaration: Declaration = { name, exported: match[1] !== undefined, index };
    const jsdoc = jsDocAbove(source, index);
    if (jsdoc !== undefined) declaration.jsdoc = jsdoc;
    const body = bodyOf(file, index + match[0].length);
    if (body !== undefined) declaration.body = body;
    file.declarations.push(declaration);
  }
  return file;
}

/** The module a relative specifier names, among the files of a root; undefined when there is none. */
function resolveRelative(files: ReadonlyMap<string, ParsedFile>, from: string, specifier: string): ParsedFile | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.(js|ts|tsx)$/, '');
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    const file = files.get(candidate);
    if (file) return file;
  }
  return undefined;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** An error a body constructs: `new TokenError(TokenErrorCode.InvalidClient, ...)` → `TokenError(InvalidClient)`. */
function constructedErrors(file: ParsedFile, start: number, end: number): string[] {
  const found: string[] = [];
  const text = file.source.slice(start, end);
  const pattern = /\bnew\s+([A-Z][\w$]*Error)\s*\(\s*(?:([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)|'([a-z_]+)')?/g;
  for (const match of text.matchAll(pattern)) {
    if (file.code[start + (match.index as number)] !== 1) continue;
    const code = match[3] ?? match[4];
    const label = code === undefined ? (match[1] as string) : `${match[1]}(${code})`;
    if (!found.includes(label)) found.push(label);
  }
  return found;
}

/** The project: every root parsed, every card built, every call resolved. */
class Project implements FunctionProject {
  readonly catalog: FunctionCatalog;
  private readonly files = new Map<string, Map<string, ParsedFile>>();
  private readonly bySpecifier = new Map<string, string>();
  /** root → exported function name → ids. */
  private readonly exportedByName = new Map<string, Map<string, string[]>>();

  constructor(roots: readonly FunctionRoot[]) {
    for (const root of roots) {
      const parsed = new Map<string, ParsedFile>();
      for (const [path, source] of [...root.files].sort(([a], [b]) => compare(a, b))) {
        if (!/\.tsx?$/.test(path)) continue;
        parsed.set(path, parseFile(root.name, path, source));
      }
      this.files.set(root.name, parsed);
      if (root.specifier !== undefined) this.bySpecifier.set(root.specifier, root.name);
      const names = new Map<string, string[]>();
      for (const file of parsed.values()) {
        for (const declaration of file.declarations) {
          if (!declaration.exported) continue;
          const list = names.get(declaration.name) ?? [];
          list.push(idOf(root.name, file.path, declaration.name));
          names.set(declaration.name, list);
        }
      }
      this.exportedByName.set(root.name, names);
    }
    this.catalog = { version: 1, functions: {} };
    for (const [rootName, parsed] of this.files) {
      for (const file of parsed.values()) {
        for (const declaration of file.declarations) {
          const card = this.cardOf(rootName, file, declaration);
          this.catalog.functions[card.id] = card;
        }
      }
    }
    for (const card of Object.values(this.catalog.functions)) {
      for (const callee of card.calls) {
        const target = this.catalog.functions[callee];
        if (target && !target.calledBy.includes(card.id)) target.calledBy.push(card.id);
      }
    }
    for (const card of Object.values(this.catalog.functions)) card.calledBy.sort();
    this.catalog.functions = Object.fromEntries(Object.entries(this.catalog.functions).sort(([a], [b]) => compare(a, b)));
  }

  callsIn(root: string, path: string, start: number, end: number): string[] {
    const file = this.files.get(root)?.get(path);
    if (!file) throw new Error(`No file "${path}" in root "${root}"`);
    return this.resolveCalls(file, start, end, undefined);
  }

  enclosingBody(root: string, path: string, offset: number): { start: number; end: number } | undefined {
    const file = this.files.get(root)?.get(path);
    if (!file) return undefined;
    for (const declaration of file.declarations) {
      if (declaration.body && declaration.body.start <= offset && offset < declaration.body.end) return declaration.body;
    }
    return undefined;
  }

  private cardOf(root: string, file: ParsedFile, declaration: Declaration): FunctionCard {
    const doc = declaration.jsdoc === undefined ? undefined : parseJsDoc(declaration.jsdoc);
    const kindTag = doc?.tags.get('kind')?.[0]?.trim();
    const kind: FunctionKind =
      kindTag !== undefined && FUNCTION_KINDS.has(kindTag) ? (kindTag as FunctionKind) : inferFunctionKind(declaration.name);
    const specTags = doc?.tags.get('spec')?.map(normalizeSpec).filter((text) => text.length > 0) ?? [];
    const spec =
      specTags.length > 0
        ? specTags
        : doc === undefined
          ? []
          : specReferencesOf(`${doc.summary}\n${doc.description}`);
    const throwsTags = doc?.tags.get('throws') ?? [];
    const constructed = declaration.body ? constructedErrors(file, declaration.body.start, declaration.body.end) : [];
    const throws = [...throwsTags, ...constructed.filter((label) => !throwsTags.some((tag) => tag.includes(label)))];
    const calls = declaration.body
      ? this.resolveCalls(file, declaration.body.start, declaration.body.end, declaration.name)
      : [];
    const card: FunctionCard = {
      id: idOf(root, file.path, declaration.name),
      name: declaration.name,
      package: root,
      module: file.path,
      line: lineOf(file.source, declaration.index),
      exported: declaration.exported,
      kind,
      summary: doc?.summary ?? '',
      calls,
      calledBy: [],
    };
    if (doc !== undefined && doc.description.length > 0) card.description = doc.description;
    if (spec.length > 0) card.spec = spec;
    if (throws.length > 0) card.throws = throws;
    return card;
  }

  /** The ids of the functions the code of a file calls between two offsets, in order of the first call. */
  private resolveCalls(file: ParsedFile, start: number, end: number, self: string | undefined): string[] {
    const calls: string[] = [];
    const seen = new Set<string>();
    const text = file.source.slice(start, end);
    const pattern = /([A-Za-z_$][\w$]*)\s*\(/g;
    for (const match of text.matchAll(pattern)) {
      const offset = start + (match.index as number);
      if (file.code[offset] !== 1) continue;
      const name = match[1] as string;
      if (NOT_A_CALL.has(name) || name === self || seen.has(name)) continue;
      // `.name(` is a method of something, `new Name(` a constructor, `function name(` a declaration.
      const before = previousCodeToken(file, offset);
      if (before === '.' || before === 'new' || before === 'function' || before === '*') continue;
      seen.add(name);
      const target = this.resolveName(file, name);
      if (target !== undefined && !calls.includes(target)) calls.push(target);
    }
    return calls;
  }

  /** The id of the function a name refers to in a file: a declaration of the file, or an import. */
  private resolveName(file: ParsedFile, name: string): string | undefined {
    if (file.declarations.some((declaration) => declaration.name === name)) return idOf(file.root, file.path, name);
    const binding = file.imports.get(name);
    if (binding === undefined) return undefined;
    const library = this.bySpecifier.get(binding.specifier);
    if (library !== undefined) return this.exportedUnique(library, binding.imported);
    if (!binding.specifier.startsWith('.')) return undefined;
    const files = this.files.get(file.root) as Map<string, ParsedFile>;
    const target = resolveRelative(files, file.path, binding.specifier);
    if (target === undefined) return undefined;
    if (target.declarations.some((declaration) => declaration.name === binding.imported && declaration.exported)) {
      return idOf(target.root, target.path, binding.imported);
    }
    // A barrel (an index.ts) re-exports it from a module of the same root.
    return target.barrel ? this.exportedUnique(file.root, binding.imported) : undefined;
  }

  private exportedUnique(root: string, name: string): string | undefined {
    const ids = this.exportedByName.get(root)?.get(name);
    return ids !== undefined && ids.length === 1 ? ids[0] : undefined;
  }
}

/**
 * The code token right before an offset: a word (an identifier or a keyword)
 * or a single character, with whitespace, strings and comments skipped.
 */
function previousCodeToken(file: ParsedFile, offset: number): string {
  let index = offset - 1;
  while (index >= 0 && (file.code[index] !== 1 || /\s/.test(file.source[index] as string))) index -= 1;
  if (index < 0) return '';
  if (!/[\w$]/.test(file.source[index] as string)) return file.source[index] as string;
  let start = index;
  while (start > 0 && file.code[start - 1] === 1 && /[\w$]/.test(file.source[start - 1] as string)) start -= 1;
  return file.source.slice(start, index + 1);
}

/** Code-unit order, the same on every platform and locale (unlike localeCompare). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The id of a function: `<root>:<module>#<name>`. */
export function idOf(root: string, module: string, name: string): string {
  return `${root}:${module}#${name}`;
}

/** Parse the roots and resolve their calls. */
export function analyzeFunctions(roots: readonly FunctionRoot[]): FunctionProject {
  return new Project(roots);
}

/** The function catalog of the roots (see the module comment). */
export function buildFunctionCatalog(roots: readonly FunctionRoot[]): FunctionCatalog {
  return analyzeFunctions(roots).catalog;
}

/** The cards named `name` (a bare name, `root:name`, or an id). */
export function findFunctions(catalog: FunctionCatalog, name: string): FunctionCard[] {
  const exact = catalog.functions[name];
  if (exact) return [exact];
  const [root, bare] = name.includes(':') ? (name.split(':', 2) as [string, string]) : [undefined, name];
  return Object.values(catalog.functions).filter(
    (card) => card.name === bare && (root === undefined || card.package === root),
  );
}
