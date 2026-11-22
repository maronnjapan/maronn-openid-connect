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
import { SyntaxKind, isAlias, type Checker, type Node, type Project, type SourceFile, type TsSymbol, type TsType } from './ts.js';
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
 * Where a declaration's name is, and its text as written there: an
 * identifier, a quoted or computed name with its quotes or brackets, the
 * `default` of an anonymous default export (`export default function () {}`,
 * `export default { … }`), the property an assignment adds to a function
 * (`f.extra = 1`, `f['extra'] = 1`).
 */
function anchorOf(node: Node, source: SourceFile): { at: number; text: string } {
  if (is(node, SyntaxKind.BinaryExpression)) return anchorOf(node['left'] as Node, source);
  const name = (is(node, SyntaxKind.ElementAccessExpression) ? node['argumentExpression'] : any(node)['name']) as Node | undefined;
  if (name !== undefined) {
    const at = name.getStart(source);
    const plain = name.kind === SyntaxKind.Identifier || name.kind === SyntaxKind.PrivateIdentifier ? nameOf(name) : undefined;
    return { at, text: plain ?? (source.text.slice(at, name.end).split('\n')[0] as string) };
  }
  const start = node.getStart(source);
  const head = source.text.slice(start, Math.min(node.end, start + 40));
  const offset = head.search(/\bdefault\b/);
  if (offset >= 0) return { at: start + offset, text: 'default' };
  return { at: start, text: /^[^\s(){}[\];,]+/.exec(head)?.[0] ?? '' };
}

/**
 * The property a name stands for where the checker names only the name
 * itself: a shorthand of a destructuring (`const { params } = context`, the
 * property of the destructured type), a property or method of an object
 * literal checked against a type (`extract({ authorizationHeader: … })`, the
 * property of the type the call expects), an attribute of JSX
 * (`<Layout title="…">`, the prop of the component). An editor goes to that
 * property; so does the map, when the property is declared in the roots.
 */
function propertyOf(checker: Checker, name: Node, types: Map<Node, TsType | undefined>): TsSymbol | undefined {
  const parent = name.parent;
  let owner: Node | undefined;
  let read: 'type' | 'contextual' = 'contextual';
  if (is(parent, SyntaxKind.BindingElement) && parent['name'] === name && parent['propertyName'] === undefined && is(parent.parent, SyntaxKind.ObjectBindingPattern)) {
    owner = parent.parent;
    read = 'type';
  } else if ((is(parent, SyntaxKind.PropertyAssignment) || is(parent, SyntaxKind.MethodDeclaration)) && parent['name'] === name && is(parent.parent, SyntaxKind.ObjectLiteralExpression)) owner = parent.parent;
  else if (is(parent, SyntaxKind.JsxAttribute) && parent['name'] === name) owner = parent.parent;
  const text = nameOf(name);
  if (owner === undefined || text === undefined) return undefined;
  if (!types.has(owner)) types.set(owner, read === 'type' ? checker.getTypeAtLocation(owner) : checker.getContextualType(owner as never));
  const type = types.get(owner);
  return type === undefined ? undefined : checker.getPropertyOfType(type, text);
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
    // A module is its file: an augmentation of it (`declare module 'hono' { … }`) is not where an import of it goes.
    const handles = symbol.declarations.some((handle) => handle.kind === SyntaxKind.SourceFile) ? symbol.declarations.filter((handle) => handle.kind === SyntaxKind.SourceFile) : symbol.declarations;
    for (const handle of handles) {
      const place = moduleOf(input.roots, relative(input.repository, handle.path).split('\\').join('/'));
      if (place === undefined) continue;
      const node = handle.resolve(project);
      if (node === undefined) continue;
      const fileId = `${place.root}:${place.module}`;
      const kind = KINDS.get(node.kind) ?? 'other';
      const source = node.kind === SyntaxKind.SourceFile ? (node as SourceFile) : node.getSourceFile();
      const anchor = node.kind === SyntaxKind.SourceFile ? { at: 0, text: place.module } : anchorOf(node, source);
      const position = source.getLineAndCharacterOfPosition(anchor.at);
      const key = node.kind === SyntaxKind.SourceFile ? `${fileId}:module` : `${fileId}:${position.line + 1}:${position.character}`;
      const existing = targetIndex.get(key);
      if (existing !== undefined) {
        found = existing;
        break;
      }
      const target: LinkTarget = { file: fileId, line: position.line + 1, column: position.character, name: anchor.text, kind };
      if (node.kind === SyntaxKind.FunctionDeclaration && is(node.parent, SyntaxKind.SourceFile)) {
        const id = `${place.root}:${place.module}#${anchor.text}`;
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

  const types = new Map<Node, TsType | undefined>();
  names.forEach((name, index) => {
    let symbol = symbols[index];
    if (name.kind === SyntaxKind.Identifier && is(name.parent, SyntaxKind.ShorthandPropertyAssignment)) {
      // `{ client }` names the property and the variable at once: go to the variable, as an editor does.
      symbol = checker.getShorthandAssignmentValueSymbol(name.parent) ?? symbol;
    } else {
      const property = propertyOf(checker, name, types);
      if (property !== undefined && indexOf(targetOf(checker, property, aliases)) !== null) symbol = property;
      // An attribute of an element of HTML, or of a component whose props the roots do not declare, goes nowhere in the map.
      else if (is(name.parent, SyntaxKind.JsxAttribute)) return;
    }
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
