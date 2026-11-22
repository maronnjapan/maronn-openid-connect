/**
 * Where each name of a file is declared, read with the type checker the
 * trees are read with: the table the code view follows when the reader
 * Ctrl/⌘ + clicks a name (go to its definition), and reads backwards for the
 * places that use a declaration (its references).
 *
 * Only declarations in the roots of the map are kept, because the map can
 * open only their files. A name declared in a library outside them (hono,
 * node) has no place to go to and gets no link. Nothing is guessed from a
 * name: a name the checker does not resolve gets no link either.
 */
import { relative } from 'node:path';
import type { LinkKind, LinkTarget, SourceLinks } from './model.js';
import { moduleOf, type AnalysisRoot } from './roots.js';
import { SyntaxKind, isAlias, type Checker, type Node, type Project, type SourceFile, type TsSymbol } from './ts.js';
import { any, is, nameOf, walk } from './ast.js';

/** The kind of a link by the kind of the declaration it goes to. */
const KINDS = new Map<number, LinkKind>([
  [SyntaxKind.FunctionDeclaration, 'function'],
  [SyntaxKind.MethodSignature, 'method'],
  [SyntaxKind.MethodDeclaration, 'method'],
  [SyntaxKind.GetAccessor, 'method'],
  [SyntaxKind.SetAccessor, 'method'],
  [SyntaxKind.PropertySignature, 'property'],
  [SyntaxKind.PropertyDeclaration, 'property'],
  [SyntaxKind.PropertyAssignment, 'property'],
  [SyntaxKind.ShorthandPropertyAssignment, 'property'],
  [SyntaxKind.InterfaceDeclaration, 'interface'],
  [SyntaxKind.TypeAliasDeclaration, 'type'],
  [SyntaxKind.ClassDeclaration, 'class'],
  [SyntaxKind.EnumDeclaration, 'enum'],
  [SyntaxKind.EnumMember, 'enum-member'],
  [SyntaxKind.VariableDeclaration, 'variable'],
  [SyntaxKind.BindingElement, 'variable'],
  [SyntaxKind.Parameter, 'parameter'],
  [SyntaxKind.TypeParameter, 'type-parameter'],
  [SyntaxKind.SourceFile, 'module'],
]);

/** The kinds of a declaration that is a member of an interface, a type literal or a class (as resolve.ts reads them). */
const MEMBER_KINDS = new Set<number>([SyntaxKind.MethodSignature, SyntaxKind.PropertySignature, SyntaxKind.MethodDeclaration, SyntaxKind.PropertyDeclaration]);

/** What a file needs to be read for its links. */
export interface LinkInput {
  repository: string;
  roots: readonly AnalysisRoot[];
  /** The project the file is compiled in. */
  project: Project;
  file: SourceFile;
  /** The id of the file (`core:client-auth.ts`). */
  fileId: string;
  /** Whether an id is a function of the catalog. */
  isFunction(id: string): boolean;
}

/** The symbols an alias goes to, by the alias's id, shared by every file of a project (an import is resolved once). */
export type AliasCache = Map<number, TsSymbol>;

/** The names of a file to look up: the identifiers, and the module specifiers of its imports and exports. */
function namesOf(file: SourceFile): Node[] {
  const names: Node[] = [];
  walk(file, (node) => {
    if (node.kind === SyntaxKind.Identifier) names.push(node);
    else if (node.kind === SyntaxKind.StringLiteral && (is(node.parent, SyntaxKind.ImportDeclaration) || is(node.parent, SyntaxKind.ExportDeclaration) || is(node.parent, SyntaxKind.ExternalModuleReference))) names.push(node);
    else if (node.kind === SyntaxKind.LiteralType && is(node.parent, SyntaxKind.ImportType)) names.push(any(node)['literal'] as Node);
    return true;
  });
  return names;
}

/** The symbol an alias (an import, a re-export) refers to in the end, or the symbol itself. */
function targetOf(checker: Checker, symbol: TsSymbol, aliases: AliasCache): TsSymbol {
  if (!isAlias(symbol)) return symbol;
  const known = aliases.get(symbol.id);
  if (known !== undefined) return known;
  const resolved = checker.getAliasedSymbol(symbol);
  const target = checker.isUnknownSymbol(resolved) ? symbol : resolved;
  aliases.set(symbol.id, target);
  return target;
}

/** The name of the interface, type alias or class that declares a member, as resolve.ts names it. */
function ownerOf(symbol: TsSymbol, declaration: Node | undefined): string | undefined {
  const parent = symbol.getParent();
  if (parent !== undefined && !parent.name.startsWith('__')) return parent.name;
  for (let node = declaration?.parent; node !== undefined; node = node.parent) {
    if (is(node, SyntaxKind.TypeAliasDeclaration) || is(node, SyntaxKind.InterfaceDeclaration) || is(node, SyntaxKind.ClassDeclaration)) return nameOf(any(node)['name']);
    if (node.kind === SyntaxKind.SourceFile) break;
  }
  return undefined;
}

/**
 * Read the links of a file (see the module comment): each name with the
 * declaration it goes to. A declaration's own name links to the declaration
 * too, so the reader can ask for its references there.
 */
export function readLinks(input: LinkInput, aliases: AliasCache): SourceLinks {
  const { file, project } = input;
  const checker = project.checker;
  const names = namesOf(file);
  const symbols = names.length === 0 ? [] : checker.getSymbolAtLocation(names);
  const targets: LinkTarget[] = [];
  const targetIndex = new Map<string, number>();
  const refs: number[] = [];
  const declared = new Map<number, number | null>();

  /** The index of the target a symbol's declaration in the roots is, or null when it is declared outside them. */
  const indexOf = (symbol: TsSymbol): number | null => {
    const known = declared.get(symbol.id);
    if (known !== undefined) return known;
    let found: number | null = null;
    for (const handle of symbol.declarations) {
      const place = moduleOf(input.roots, relative(input.repository, handle.path).split('\\').join('/'));
      if (place === undefined) continue;
      const node = handle.resolve(project);
      if (node === undefined) continue;
      const source = node.kind === SyntaxKind.SourceFile ? (node as SourceFile) : node.getSourceFile();
      const name = node.kind === SyntaxKind.SourceFile ? undefined : (any(node)['name'] as Node | undefined);
      const at = node.kind === SyntaxKind.SourceFile ? 0 : (name ?? node).getStart(source);
      const position = source.getLineAndCharacterOfPosition(at);
      const fileId = `${place.root}:${place.module}`;
      const key = `${fileId}:${position.line + 1}:${position.character}`;
      const existing = targetIndex.get(key);
      if (existing !== undefined) {
        found = existing;
        break;
      }
      const kind = KINDS.get(node.kind) ?? 'other';
      const target: LinkTarget = { file: fileId, line: position.line + 1, column: position.character, name: kind === 'module' ? place.module : (nameOf(name) ?? symbol.name), kind };
      if (node.kind === SyntaxKind.FunctionDeclaration && is(node.parent, SyntaxKind.SourceFile)) {
        const id = `${place.root}:${place.module}#${nameOf(name) ?? symbol.name}`;
        if (input.isFunction(id)) target.function = id;
      } else if (MEMBER_KINDS.has(node.kind) && !is(node.parent, SyntaxKind.ObjectLiteralExpression)) {
        const owner = ownerOf(symbol, node);
        if (owner !== undefined) target.member = `${place.root}:${place.module}#${owner}.${symbol.name}`;
      }
      found = targets.length;
      targets.push(target);
      targetIndex.set(key, found);
      break;
    }
    declared.set(symbol.id, found);
    return found;
  };

  names.forEach((name, index) => {
    let symbol = symbols[index];
    // `{ client }` names the property and the variable at once: go to the variable, as an editor does.
    if (name.kind === SyntaxKind.Identifier && is(name.parent, SyntaxKind.ShorthandPropertyAssignment)) symbol = checker.getShorthandAssignmentValueSymbol(name.parent) ?? symbol;
    if (symbol === undefined) return;
    const target = indexOf(targetOf(checker, symbol, aliases));
    if (target === null) return;
    const start = name.getStart(file);
    const position = file.getLineAndCharacterOfPosition(start);
    refs.push(position.line + 1, position.character, name.end - start, target);
  });
  return { targets, refs };
}

/**
 * The places that use each declaration of the files, from the links of all
 * of them: for each file, `line:column` of a declaration → the uses
 * (file, line, column), its own name left out. A declaration no other name
 * goes to has none.
 */
export function usesOf(links: ReadonlyMap<string, SourceLinks>): Map<string, Map<string, Array<[string, number, number]>>> {
  const uses = new Map<string, Map<string, Array<[string, number, number]>>>();
  for (const [file, table] of links) {
    for (let index = 0; index < table.refs.length; index += 4) {
      const line = table.refs[index] as number;
      const column = table.refs[index + 1] as number;
      const target = table.targets[table.refs[index + 3] as number];
      if (target === undefined || (target.file === file && target.line === line && target.column === column)) continue;
      const byDeclaration = uses.get(target.file) ?? new Map<string, Array<[string, number, number]>>();
      const key = `${target.line}:${target.column}`;
      const list = byDeclaration.get(key) ?? [];
      list.push([file, line, column]);
      byDeclaration.set(key, list);
      uses.set(target.file, byDeclaration);
    }
  }
  return uses;
}
