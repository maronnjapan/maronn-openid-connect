/**
 * What the calls of a file reach, by the types: the function of the catalog
 * a name refers to (through imports, re-exports and aliases), the member of
 * an interface of the roots a method call reaches (through the declared type
 * of its receiver), and, for a value read from the request context of Hono by
 * a string key (`c.get('transactionStore')`), the type the provider put under
 * that key (`c.set('transactionStore', stores.transactionStore)`).
 *
 * Nothing is guessed from a name. A call on a value read by a key no
 * `c.set()` types is untraceable, and the map says so.
 */
import { relative } from 'node:path';
import type { CallTarget, MemberDoc } from './model.js';
import { moduleOf, type AnalysisRoot } from './roots.js';
import { SyntaxKind, isAlias, type Checker, type Node, type Project, type SourceFile, type TsSymbol, type TsType } from './ts.js';
import { any, is, isFunctionLike, lineAt, nameOf, stringOf, unwrap, walk } from './ast.js';

/** The types the request context holds by key (`transactionStore` → TransactionStorage), read from the `c.set()` of a project. */
export type ContextKeys = ReadonlyMap<string, TsType[]>;

/** What resolve() found in one file. */
export interface FileResolution {
  /** A call expression → what it calls (a call outside the catalog and the members has none). */
  targets: Map<Node, CallTarget>;
  /** A property access of an enum member (`TokenErrorCode.InvalidClient`) → its value (`invalid_client`). */
  constants: Map<Node, string>;
  /** A property of an object literal → the member of an interface it implements. */
  implementations: Map<Node, string>;
  /** A call of a function the frame defines itself (`const encode = (value) => ...`) → that function. */
  locals: Map<Node, Node>;
  /** Callable values wired by reference, rather than called at their declaration site. */
  references: Map<Node, { target?: CallTarget; definition?: Node }>;
  /** Calls of standard collection iteration APIs, whose callback invocation is known. */
  iterations: Set<Node>;
}

export interface ResolverOptions {
  repository: string;
  roots: readonly AnalysisRoot[];
  /** Whether an id is a function of the catalog. */
  isFunction(id: string): boolean;
  /** The first paragraph of a JSDoc text, on one line. */
  paragraph(text: string): string;
}

/** The kinds of a declaration that is a member of an interface, a type literal or a class. */
const MEMBER_KINDS = new Set<number>([SyntaxKind.MethodSignature, SyntaxKind.PropertySignature, SyntaxKind.MethodDeclaration, SyntaxKind.PropertyDeclaration]);

/** Resolves the calls of the files of one project, keeping what it learnt about the members of the roots. */
export class Resolver {
  readonly members = new Map<string, MemberDoc>();
  private readonly aliases = new Map<number, TsSymbol>();
  private readonly memberIds = new Map<number, string | null>();

  constructor(
    private readonly project: Project,
    private readonly options: ResolverOptions,
    private readonly contextKeys: ContextKeys = new Map(),
  ) {}

  private get checker(): Checker {
    return this.project.checker;
  }

  /** The symbol an alias (an import, a re-export) refers to in the end. */
  private target(symbol: TsSymbol): TsSymbol {
    if (!isAlias(symbol)) return symbol;
    const known = this.aliases.get(symbol.id);
    if (known !== undefined) return known;
    const resolved = this.checker.getAliasedSymbol(symbol);
    const target = this.checker.isUnknownSymbol(resolved) ? symbol : resolved;
    this.aliases.set(symbol.id, target);
    return target;
  }

  /** The root and module of an absolute path, or undefined outside the roots. */
  private moduleOfPath(path: string): { root: string; module: string } | undefined {
    return moduleOf(this.options.roots, relative(this.options.repository, path).split('\\').join('/'));
  }

  /** The id of the function of the catalog a symbol is, or undefined. */
  private functionOf(symbol: TsSymbol): string | undefined {
    const declaration = symbol.declarations.find((candidate) => candidate.kind === SyntaxKind.FunctionDeclaration);
    if (declaration === undefined) return undefined;
    const place = this.moduleOfPath(declaration.path);
    if (place === undefined) return undefined;
    let name = symbol.name;
    if (name === 'default') {
      const node = declaration.resolve(this.project);
      name = nameOf(node === undefined ? undefined : any(node)['name']) ?? name;
    }
    const id = `${place.root}:${place.module}#${name}`;
    return this.options.isFunction(id) ? id : undefined;
  }

  /** The name of the interface or type alias that declares a member. */
  private ownerOf(symbol: TsSymbol, declaration: Node | undefined): string | undefined {
    const parent = symbol.getParent();
    if (parent !== undefined && !parent.name.startsWith('__')) return parent.name;
    for (let node = declaration?.parent; node !== undefined; node = node.parent) {
      if (is(node, SyntaxKind.TypeAliasDeclaration) || is(node, SyntaxKind.InterfaceDeclaration) || is(node, SyntaxKind.ClassDeclaration)) return nameOf(any(node)['name']);
      if (node.kind === SyntaxKind.SourceFile) break;
    }
    return undefined;
  }

  /** The id of the member of an interface of the roots a symbol is (`core:consent.ts#ConsentResolver.recordConsent`), or undefined. */
  memberOf(symbol: TsSymbol | undefined): string | undefined {
    if (symbol === undefined) return undefined;
    const known = this.memberIds.get(symbol.id);
    if (known !== undefined) return known ?? undefined;
    let id: string | undefined;
    for (const declaration of symbol.declarations) {
      if (!MEMBER_KINDS.has(declaration.kind)) continue;
      const place = this.moduleOfPath(declaration.path);
      if (place === undefined) continue;
      const node = declaration.resolve(this.project);
      const owner = this.ownerOf(symbol, node);
      if (owner === undefined) continue;
      // A method of an object literal or a class of the code is not a member of an interface a caller may swap.
      if (node !== undefined && is(node.parent, SyntaxKind.ObjectLiteralExpression)) continue;
      id = `${place.root}:${place.module}#${owner}.${symbol.name}`;
      if (!this.members.has(id)) {
        const file = node?.getSourceFile();
        this.members.set(id, {
          id,
          type: owner,
          member: symbol.name,
          summary: this.options.paragraph(symbol.getDocumentationComment(this.checker)),
          package: place.root,
          module: place.module,
          line: file === undefined || node === undefined ? 1 : lineAt(file, node.getStart(file)),
        });
      }
      break;
    }
    this.memberIds.set(symbol.id, id ?? null);
    return id;
  }

  /**
   * The key a receiver was read from the request context by, and the
   * properties read off it since: `c.get('stores').authCodeStore` →
   * stores, [authCodeStore]; a name bound to such a read the same way.
   */
  private contextRead(receiver: Node, depth = 0): { key: string; path: string[] } | undefined {
    if (depth > 4) return undefined;
    const node = unwrap(receiver);
    if (is(node, SyntaxKind.CallExpression)) {
      const callee = unwrap(node['expression'] as Node);
      if (is(callee, SyntaxKind.PropertyAccessExpression) && nameOf(callee['name']) === 'get') {
        const key = stringOf((node['arguments'] as Node[])[0]);
        if (key !== undefined) return { key, path: [] };
      }
      return undefined;
    }
    if (is(node, SyntaxKind.PropertyAccessExpression)) {
      const inner = this.contextRead(node['expression'] as Node, depth + 1);
      const name = nameOf(node['name']);
      return inner === undefined || name === undefined ? undefined : { key: inner.key, path: [...inner.path, name] };
    }
    if (is(node, SyntaxKind.Identifier)) {
      const symbol = this.checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration?.resolve(this.project);
      if (declaration === undefined) return undefined;
      if (is(declaration, SyntaxKind.VariableDeclaration) && declaration['initializer'] !== undefined && is(declaration['name'], SyntaxKind.Identifier)) {
        return this.contextRead(declaration['initializer'] as Node, depth + 1);
      }
      if (is(declaration, SyntaxKind.BindingElement)) {
        const pattern = declaration.parent;
        const owner = pattern?.parent;
        const property = nameOf(declaration['propertyName']) ?? nameOf(declaration['name']);
        if (is(pattern, SyntaxKind.ObjectBindingPattern) && is(owner, SyntaxKind.VariableDeclaration) && owner['initializer'] !== undefined && property !== undefined) {
          const inner = this.contextRead(owner['initializer'] as Node, depth + 1);
          return inner === undefined ? undefined : { key: inner.key, path: [...inner.path, property] };
        }
      }
    }
    return undefined;
  }

  /** The member a method call on a value read from the request context reaches, or why it cannot be told. */
  private contextMember(receiver: Node, method: string): CallTarget | undefined {
    const read = this.contextRead(receiver);
    if (read === undefined) return undefined;
    const types = this.contextKeys.get(read.key);
    if (types === undefined || types.length === 0) return { kind: 'untraceable', why: `c.get('${read.key}') の型が分からない`, method };
    for (let type of types) {
      let found = true;
      for (const property of read.path) {
        const symbol = this.checker.getPropertyOfType(type, property);
        const next = symbol === undefined ? undefined : this.checker.getTypeOfSymbol(symbol);
        if (next === undefined) {
          found = false;
          break;
        }
        type = this.checker.getNonNullableType(next) ?? next;
      }
      if (!found) continue;
      const member = this.memberOf(this.checker.getPropertyOfType(type, method));
      if (member !== undefined) return { kind: 'member', id: member };
    }
    return { kind: 'untraceable', why: `c.get('${read.key}') の ${[...read.path, method].join('.')} がどの型のメンバーか分からない`, method };
  }

  /** The function a name defined in the same file refers to, when it is not a function of the catalog: a `const f = () => ...`, a nested function. */
  private localFunction(symbol: TsSymbol, call: Node): Node | undefined {
    const declaration = symbol.valueDeclaration?.resolve(this.project);
    if (declaration === undefined || declaration.getSourceFile() !== call.getSourceFile()) return undefined;
    if (is(declaration, SyntaxKind.VariableDeclaration) && declaration['initializer'] !== undefined) {
      const value = unwrap(declaration['initializer'] as Node);
      return is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression) ? value : undefined;
    }
    if (is(declaration, SyntaxKind.FunctionDeclaration) && !is(declaration.parent, SyntaxKind.SourceFile)) return declaration;
    return undefined;
  }

  /** Resolve the identity of a callable reference without claiming it executes where it is passed. */
  reference(node: Node, seen: Set<number> = new Set()): CallTarget | undefined {
    const value = unwrap(node);
    const symbol = is(value.parent, SyntaxKind.ShorthandPropertyAssignment)
      ? this.checker.getShorthandAssignmentValueSymbol(value.parent)
      : this.checker.getSymbolAtLocation(is(value, SyntaxKind.PropertyAccessExpression) ? value['name'] as Node : value);
    if (symbol === undefined) return undefined;
    const target = this.target(symbol);
    if (seen.has(target.id)) return undefined;
    seen.add(target.id);
    const fn = this.functionOf(target);
    if (fn !== undefined) return { kind: 'function', id: fn };
    const member = this.memberOf(target);
    if (member !== undefined) return { kind: 'member', id: member };
    const declaration = target.valueDeclaration?.resolve(this.project);
    if (is(declaration, SyntaxKind.VariableDeclaration) && declaration['initializer'] !== undefined) {
      const initializer = unwrap(declaration['initializer'] as Node);
      if (is(initializer, SyntaxKind.Identifier) || is(initializer, SyntaxKind.PropertyAccessExpression)) return this.reference(initializer, seen);
    }
    return undefined;
  }

  /**
   * Whether a declaration or its type describes a callback. Follow symbols and
   * type aliases instead of serializing arbitrary value types: TypeScript 7's
   * synchronous API cannot serialize some inferred tuple references.
   */
  callable(node: Node, seen: Set<number> = new Set()): boolean {
    const value = unwrap(node);
    if (isFunctionLike(value) || is(value, SyntaxKind.FunctionType) || is(value, SyntaxKind.CallSignature)) return true;
    if (is(value, SyntaxKind.UnionType) || is(value, SyntaxKind.IntersectionType)) return (value['types'] as Node[]).some((type) => this.callable(type, seen));
    if (is(value, SyntaxKind.TypeLiteral) || is(value, SyntaxKind.InterfaceDeclaration)) return (value['members'] as Node[]).some((member) => is(member, SyntaxKind.CallSignature));
    const name = is(value, SyntaxKind.TypeReference) ? value['typeName'] as Node : is(value, SyntaxKind.PropertyAccessExpression) ? value['name'] as Node : value;
    if (!is(name, SyntaxKind.Identifier) && !is(name, SyntaxKind.QualifiedName)) return false;
    const symbol = is(value.parent, SyntaxKind.ShorthandPropertyAssignment) ? this.checker.getShorthandAssignmentValueSymbol(value.parent) : this.checker.getSymbolAtLocation(name);
    if (symbol === undefined) return false;
    const target = this.target(symbol);
    if (seen.has(target.id)) return false;
    seen.add(target.id);
    for (const declaration of target.declarations) {
      const declared = declaration.resolve(this.project);
      if (declared === undefined) continue;
      if (isFunctionLike(declared) || is(declared, SyntaxKind.MethodSignature) || is(declared, SyntaxKind.CallSignature)) return true;
      const type = any(declared)['type'] as Node | undefined;
      if (type !== undefined && this.callable(type, seen)) return true;
      const initializer = any(declared)['initializer'] as Node | undefined;
      if (initializer !== undefined && this.callable(initializer, seen)) return true;
      if (is(declared, SyntaxKind.InterfaceDeclaration) && this.callable(declared, seen)) return true;
    }
    return false;
  }

  /** Whether a callback belongs to a standard collection operation rather than an arbitrary registration method with the same name. */
  iterates(call: Node): boolean {
    const callee = unwrap(any(call)['expression'] as Node);
    if (!is(callee, SyntaxKind.PropertyAccessExpression)) return false;
    const method = nameOf(callee['name']);
    if (!['map', 'forEach', 'filter', 'flatMap', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'reduce', 'reduceRight', 'sort', 'toSorted'].includes(method ?? '')) return false;
    const symbol = this.checker.getSymbolAtLocation(callee['name'] as Node);
    return symbol?.declarations.some((declaration) => {
      if (!/(?:^|\/)lib\.[^/]+\.d\.ts$/.test(declaration.path)) return false;
      const owner = declaration.resolve(this.project)?.parent;
      if (!is(owner, SyntaxKind.InterfaceDeclaration)) return false;
      const name = nameOf(owner['name']);
      return ['Array', 'ReadonlyArray'].includes(name ?? '') || (method === 'forEach' && ['Map', 'ReadonlyMap', 'Set', 'ReadonlySet'].includes(name ?? ''));
    }) ?? false;
  }

  /** A callable parameter can retain the signature of an indexed interface property through aliases such as NonNullable<Options['load']>. */
  private signatureTarget(call: Node): CallTarget | undefined {
    const signature = this.checker.getResolvedSignature(call);
    let declaration = signature?.declaration?.resolve(this.project);
    while (declaration !== undefined && !is(declaration, SyntaxKind.SourceFile)) {
      if (is(declaration, SyntaxKind.PropertySignature) || is(declaration, SyntaxKind.MethodSignature)) {
        const symbol = this.checker.getSymbolAtLocation(declaration['name'] as Node);
        const member = this.memberOf(symbol);
        if (member !== undefined) return { kind: 'member', id: member };
      }
      if (is(declaration, SyntaxKind.FunctionDeclaration) || is(declaration, SyntaxKind.Parameter)) break;
      declaration = declaration.parent;
    }
    return undefined;
  }

  /** A nested spread/conditional object inherits the callable contract of the receiving outer object. */
  private contextualMember(literal: Node, name: string): string | undefined {
    for (let current: Node | undefined = literal; current !== undefined; current = current.parent) {
      if (current !== literal && isFunctionLike(current)) break;
      // Only a spread forwards the outer object's contract. A nested property
      // or a call argument is a different value, even when its method has the
      // same name as an outer member.
      if (current !== literal && (is(current, SyntaxKind.PropertyAssignment) || is(current, SyntaxKind.CallExpression) || is(current, SyntaxKind.VariableDeclaration) || is(current, SyntaxKind.ReturnStatement))) break;
      if (!is(current, SyntaxKind.ObjectLiteralExpression)) continue;
      const type = this.checker.getContextualType(current as Parameters<Checker['getContextualType']>[0]);
      if (type === undefined) continue;
      const member = this.memberOf(this.checker.getPropertyOfType(this.checker.getNonNullableType(type) ?? type, name));
      if (member !== undefined) return member;
    }
    return undefined;
  }

  /** Why a callable in the analyzed sources has no traceable contract; external library operations are ordinary actions. */
  private missingTarget(node: Node): CallTarget | undefined {
    const value = unwrap(node);
    const read = this.contextRead(value);
    if (read !== undefined) return { kind: 'untraceable', why: `c.get('${read.key}') から取り出した関数の実装を特定できない` };
    const name = is(value, SyntaxKind.PropertyAccessExpression) ? value['name'] as Node : value;
    const symbol = this.checker.getSymbolAtLocation(name);
    const target = symbol === undefined ? undefined : this.target(symbol);
    if (target?.declarations.some((declaration) => this.moduleOfPath(declaration.path) !== undefined) !== true) return undefined;
    const declaration = target.valueDeclaration?.resolve(this.project);
    if (is(declaration, SyntaxKind.Parameter)) return { kind: 'untraceable', why: '関数引数の実装は呼び出し側から渡されるため特定できない' };
    if (this.callable(value)) return { kind: 'untraceable', why: '呼び出す関数値に、カタログの関数か名前のある型のメンバーへの接続がない', ...(is(value, SyntaxKind.PropertyAccessExpression) ? { method: nameOf(value['name']) } : {}) };
    return undefined;
  }

  /** Resolve the calls, the enum constants of the errors thrown and the implementations of members inside some bodies of a file. */
  resolve(bodies: readonly Node[]): FileResolution {
    const result: FileResolution = { targets: new Map(), constants: new Map(), implementations: new Map(), locals: new Map(), references: new Map(), iterations: new Set() };
    const calls: Array<{ call: Node; name: Node | undefined; receiver: Node | undefined; method: string | undefined }> = [];
    const literals: Node[] = [];
    const thrown: Node[] = [];
    for (const body of bodies) {
      walk(body, (node) => {
        if (is(node, SyntaxKind.CallExpression)) {
          const callee = unwrap(node['expression'] as Node);
          if (is(callee, SyntaxKind.Identifier)) calls.push({ call: node, name: callee, receiver: undefined, method: undefined });
          else if (is(callee, SyntaxKind.PropertyAccessExpression)) calls.push({ call: node, name: callee['name'] as Node, receiver: callee['expression'] as Node, method: nameOf(callee['name']) });
          else if (is(callee, SyntaxKind.ElementAccessExpression)) calls.push({ call: node, name: undefined, receiver: callee['expression'] as Node, method: undefined });
          else calls.push({ call: node, name: undefined, receiver: undefined, method: undefined });
        } else if (is(node, SyntaxKind.ObjectLiteralExpression)) {
          literals.push(node);
        } else if (is(node, SyntaxKind.ThrowStatement)) {
          const expression = unwrap(node['expression'] as Node);
          if (is(expression, SyntaxKind.NewExpression)) {
            const first = (expression['arguments'] as Node[] | undefined)?.[0];
            if (first !== undefined && is(first, SyntaxKind.PropertyAccessExpression)) thrown.push(first);
          }
        }
        return true;
      });
    }
    const named = calls.filter((entry) => entry.name !== undefined);
    const symbols = named.length === 0 ? [] : this.checker.getSymbolAtLocation(named.map((entry) => entry.name as Node));
    named.forEach((entry, index) => {
      const symbol = symbols[index];
      const target = symbol === undefined ? undefined : this.target(symbol);
      if (target !== undefined) {
        const fn = this.functionOf(target);
        if (fn !== undefined) {
          result.targets.set(entry.call, { kind: 'function', id: fn });
          return;
        }
        const member = this.memberOf(target);
        if (member !== undefined) {
          result.targets.set(entry.call, { kind: 'member', id: member });
          return;
        }
        if (entry.receiver === undefined) {
          const local = this.localFunction(target, entry.call);
          if (local !== undefined) {
            result.locals.set(entry.call, local);
            return;
          }
        }
      }
      // A method of a value the types do not know (any): one read from the request context by a key.
      if (entry.receiver !== undefined && entry.method !== undefined && (symbol === undefined || target === undefined)) {
        const member = this.contextMember(entry.receiver, entry.method);
        if (member !== undefined) result.targets.set(entry.call, member);
      }
      if (!result.targets.has(entry.call)) {
        const callee = unwrap(any(entry.call)['expression'] as Node);
        const reference = this.reference(callee);
        const missing = reference ?? this.signatureTarget(entry.call) ?? this.missingTarget(callee);
        if (missing !== undefined) result.targets.set(entry.call, missing);
      }
    });
    for (const entry of calls) {
      if (entry.name !== undefined) continue;
      const callee = unwrap(any(entry.call)['expression'] as Node);
      const read = this.contextRead(callee) ?? (entry.receiver === undefined ? undefined : this.contextRead(entry.receiver));
      if (read !== undefined) result.targets.set(entry.call, { kind: 'untraceable', why: `c.get('${read.key}') から取り出した関数の実装を特定できない` });
      else if (this.callable(callee)) result.targets.set(entry.call, { kind: 'untraceable', why: '式から得た関数値の実装を特定できない' });
    }

    // Passing a named function is a registration, not an invocation. Keep its identity separately.
    for (const { call } of calls) {
      if (this.iterates(call)) result.iterations.add(call);
      for (const argument of any(call)['arguments'] as Node[]) {
        const value = unwrap(argument);
        if (isFunctionLike(value) || !this.callable(value)) continue;
        const reference = this.reference(value);
        const symbol = this.checker.getSymbolAtLocation(is(value, SyntaxKind.PropertyAccessExpression) ? value['name'] as Node : value);
        const definition = symbol === undefined ? undefined : this.localFunction(this.target(symbol), call);
        result.references.set(value, { ...(reference === undefined ? {} : { target: reference }), ...(definition === undefined ? {} : { definition }) });
      }
    }
    // The code of an error: an enum member, or a property of a `const` object whose type is a literal.
    const types = thrown.length === 0 ? [] : this.checker.getTypeAtLocation(thrown);
    thrown.forEach((node, index) => {
      const type = types[index];
      if (type !== undefined && (type.isStringLiteralType() || type.isNumberLiteralType())) {
        result.constants.set(node, String(type.value));
        return;
      }
      const value = this.checker.getConstantValue(node);
      if (typeof value === 'string' || typeof value === 'number') result.constants.set(node, String(value));
    });
    for (const literal of literals) {
      const properties = (any(literal)['properties'] as Node[]).filter((property) => {
        if (property.kind === SyntaxKind.MethodDeclaration) return true;
        if (is(property, SyntaxKind.ShorthandPropertyAssignment)) return this.callable(property['name'] as Node);
        if (property.kind !== SyntaxKind.PropertyAssignment) return false;
        const value = unwrap(any(property)['initializer'] as Node);
        return isFunctionLike(value) || this.callable(value);
      });
      if (properties.length === 0) continue;
      for (const property of properties) {
        const name = nameOf(any(property)['name']);
        if (name === undefined) continue;
        const member = this.contextualMember(literal, name);
        if (member !== undefined) {
          result.implementations.set(property, member);
          if (is(property, SyntaxKind.PropertyAssignment) || is(property, SyntaxKind.ShorthandPropertyAssignment)) {
            const value = unwrap((property['initializer'] ?? property['name']) as Node);
            if (!isFunctionLike(value)) {
              const reference = this.reference(value);
              const symbol = this.checker.getSymbolAtLocation(value);
              const definition = symbol === undefined ? undefined : this.localFunction(this.target(symbol), value);
              result.references.set(value, { ...(reference === undefined ? {} : { target: reference }), ...(definition === undefined ? {} : { definition }) });
            }
          }
        }
      }
    }
    return result;
  }
}

/**
 * The types the request context holds by key: every `c.set('<key>', value)`
 * of the files, on a receiver the types do not know (the context of Hono is
 * `any` in the provider), with the type of the value.
 */
export function readContextKeys(project: Project, files: readonly SourceFile[]): Map<string, TsType[]> {
  const sets: Array<{ key: string; value: Node; receiver: Node }> = [];
  for (const file of files) {
    walk(file, (node) => {
      if (!is(node, SyntaxKind.CallExpression)) return true;
      const callee = unwrap(node['expression'] as Node);
      const args = node['arguments'] as Node[];
      if (!is(callee, SyntaxKind.PropertyAccessExpression) || nameOf(callee['name']) !== 'set' || args.length !== 2) return true;
      const key = stringOf(args[0]);
      if (key !== undefined && args[1] !== undefined) sets.push({ key, value: args[1], receiver: callee['expression'] as Node });
      return true;
    });
  }
  const keys = new Map<string, TsType[]>();
  if (sets.length === 0) return keys;
  const receivers = project.checker.getTypeAtLocation(sets.map((set) => set.receiver));
  const values = project.checker.getTypeAtLocation(sets.map((set) => set.value));
  sets.forEach((set, index) => {
    const receiver = receivers[index];
    const value = values[index];
    if (value === undefined || receiver === undefined) return;
    // A Map or a Headers has a type; the context of Hono here is any.
    if (!receiver.isIntrinsicType() || (receiver as { intrinsicName?: string }).intrinsicName !== 'any') return;
    if (value.isIntrinsicType()) return;
    const list = keys.get(set.key) ?? [];
    list.push(value);
    keys.set(set.key, list);
  });
  return keys;
}

/** Whether a node is inside a function-like node below `top` (its code does not run where it is written). */
export function insideDefinition(node: Node, top: Node): boolean {
  for (let current = node.parent; current !== undefined && current !== top; current = current.parent) {
    if (isFunctionLike(current)) return true;
  }
  return false;
}
