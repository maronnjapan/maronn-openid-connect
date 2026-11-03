/**
 * One revision of the code read as frames: the tree of every function of the
 * catalog and of every endpoint body, with what their calls reach.
 *
 * The working tree is one revision; the base of a pull request is another,
 * laid over the working tree (its changed files from git), so the trees
 * before and after a change are read the same way.
 */
import { join } from 'node:path';
import type { FlowEndpoint, MemberDoc, StepMark, TreeNode } from './model.js';
import { moduleOf, overlayConfigs, overlayOf, pathOf, type AnalysisRoot } from './roots.js';
import { Compiler, SyntaxKind, type Node, type Overlay, type SourceFile } from './ts.js';
import { any, endLine, is, isFunctionLike, lineAt, nameOf, startLine, stringOf, unwrap, walk } from './ast.js';
import { Resolver, readContextKeys, type ContextKeys } from './resolve.js';
import { buildTree, place, signatureOf, type BuiltTree, type FrameInput } from './tree.js';
import { shorten } from './words.js';

/** The marker of a step, anywhere in a file: `// [id] ...`. */
const MARKERS = /^[ \t]*\/\/ \[([a-z0-9-]+)\](?: \(feature: [a-z0-9-]+\))? /gm;

/** The HTTP methods a Hono route is registered with. */
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options']);

/** The endpoints whose bodies a revision reads, by the source they are generated from. */
export interface EndpointSource {
  /** The root of the catalog the source is (hono, nextjs). */
  source: string;
  /** The directory under the root the endpoints' modules are relative to (oidc-provider, app). */
  directory: string;
  layout: 'hono' | 'nextjs';
  frameworks: string[];
  endpoints: Array<Omit<FlowEndpoint, 'root'>>;
}

export interface RevisionInput {
  repository: string;
  roots: readonly AnalysisRoot[];
  /** The files to read frames from, by root: their modules. */
  files: ReadonlyMap<string, readonly string[]>;
  endpoints: readonly EndpointSource[];
  /** What a function's JSDoc says (its summary), by id. */
  summaryOf(id: string): string | undefined;
  /** The step a function is, by id (Hono). */
  stepOf(id: string): StepMark | undefined;
  joinLines(lines: readonly string[]): string;
  joinLinesFlat(lines: readonly string[]): string;
  /** The files that differ from the working tree (a base revision). */
  overlay?: Overlay;
}

/** A frame found in a file. */
export interface FrameInfo {
  id: string;
  kind: 'function' | 'body';
  root: string;
  module: string;
  name: string;
  /** The line of the declaration (of the first signature of an overload set). */
  line: number;
  /** The lines of the frame, its JSDoc included. */
  start: number;
  end: number;
  /** The first line of the declaration (after the JSDoc). */
  declaration: number;
  /** For an endpoint body: the endpoint and the source. */
  endpoint?: string;
  source?: string;
  synthetic?: boolean;
}

export interface Revision {
  frames: Map<string, FrameInfo>;
  trees: Map<string, BuiltTree>;
  members: Map<string, MemberDoc>;
  /** `${source}:${endpoint}` → the frame its trace starts from. */
  endpointRoots: Map<string, string>;
  /** root:module → the text of the file. */
  texts: Map<string, string>;
}

/** The top-level function declarations of a file as the catalog reads them (packages/cli functions.ts): `function` or `export function` at the start of a line. */
export function catalogDeclarations(file: SourceFile): Map<string, Node[]> {
  const found = new Map<string, Node[]>();
  for (const statement of file.statements as readonly Node[]) {
    if (!is(statement, SyntaxKind.FunctionDeclaration)) continue;
    const name = nameOf(statement['name']);
    if (name === undefined) continue;
    const start = statement.getStart(file);
    const column = start - file.getPositionOfLineAndCharacter(lineAt(file, start) - 1, 0);
    if (column !== 0) continue;
    const modifiers = ((statement['modifiers'] as Node[] | undefined) ?? []).map((modifier) => modifier.kind);
    if (modifiers.includes(SyntaxKind.DefaultKeyword) || modifiers.includes(SyntaxKind.DeclareKeyword)) continue;
    const list = found.get(name) ?? [];
    list.push(statement);
    found.set(name, list);
  }
  return found;
}

/** The first line of a declaration with its JSDoc. */
function docLine(file: SourceFile, declaration: Node): number {
  return lineAt(file, declaration.getStart(file, true));
}

/** The registration a handler is passed to: `<app>.post('/sub', handler)` → POST and /sub. */
interface Registration {
  method: string;
  path: string;
  /** The statement that registers it. */
  statement: Node;
  handler: Node;
}

/** The route registrations of a Hono file: `x.get('/', (c) => ...)`, `x.post('/', handler)` at the top level. */
function registrations(file: SourceFile): Registration[] {
  const found: Registration[] = [];
  const locals = new Map<string, Node>();
  for (const statement of file.statements as readonly Node[]) {
    if (is(statement, SyntaxKind.VariableStatement)) {
      for (const declaration of any(statement['declarationList'])['declarations'] as Node[]) {
        const initializer = any(declaration)['initializer'] as Node | undefined;
        const name = nameOf(any(declaration)['name']);
        if (name !== undefined && initializer !== undefined && isFunctionLike(unwrap(initializer))) locals.set(name, unwrap(initializer));
      }
    } else if (is(statement, SyntaxKind.FunctionDeclaration)) {
      const name = nameOf(statement['name']);
      if (name !== undefined) locals.set(name, statement);
    }
  }
  for (const statement of file.statements as readonly Node[]) {
    if (!is(statement, SyntaxKind.ExpressionStatement)) continue;
    const call = unwrap(statement['expression'] as Node);
    if (!is(call, SyntaxKind.CallExpression)) continue;
    const callee = unwrap(call['expression'] as Node);
    if (!is(callee, SyntaxKind.PropertyAccessExpression)) continue;
    const method = nameOf(callee['name']);
    if (method === undefined || !ROUTE_METHODS.has(method)) continue;
    const args = call['arguments'] as Node[];
    const path = stringOf(args[0]);
    const last = args[args.length - 1];
    if (path === undefined || last === undefined) continue;
    const value = unwrap(last);
    const handler = isFunctionLike(value) ? value : is(value, SyntaxKind.Identifier) ? locals.get(value['text'] as string) : undefined;
    if (handler !== undefined) found.push({ method: method.toUpperCase(), path, statement, handler });
  }
  return found;
}

/** A part of an endpoint body: a function of the catalog, or an inline handler. */
interface Part {
  declaration: Node;
  /** The id of the function of the catalog it is. */
  function?: string;
  /** `POST /token`. */
  label: string;
  registration?: Registration;
}

/** The innermost function-like node of a file that holds an offset. */
function ownerAt(file: SourceFile, offset: number): Node | undefined {
  let owner: Node | undefined;
  walk(file, (node) => {
    if (node.pos > offset || node.end < offset) return false;
    if (isFunctionLike(node) && node.getStart(file) <= offset && any(node)['body'] !== undefined) owner = node;
    return true;
  });
  return owner;
}

/** The full path of a route under its endpoint: `/token` and `/` → `/token`, `/device` and `/login` → `/device/login`. */
function routePath(endpoint: string, sub: string): string {
  return sub === '/' || sub === '' ? endpoint : `${endpoint.replace(/\/$/, '')}${sub.startsWith('/') ? sub : `/${sub}`}`;
}

/** Read a revision (see the module comment). */
export function readRevision(input: RevisionInput): Revision {
  const { repository, roots } = input;
  const configs = overlayConfigs(repository, roots, input.files);
  const compiler = new Compiler(repository, configs, input.overlay);
  try {
    const revision: Revision = { frames: new Map(), trees: new Map(), members: new Map(), endpointRoots: new Map(), texts: new Map() };
    const sourceFiles = new Map<string, SourceFile>();
    const fileOf = (root: string, module: string): SourceFile | undefined => {
      const key = `${root}:${module}`;
      const known = sourceFiles.get(key);
      if (known !== undefined) return known;
      const entry = roots.find((candidate) => candidate.name === root);
      if (entry === undefined) return undefined;
      const project = compiler.project(overlayOf(repository, entry));
      const file = project.program.getSourceFile(join(repository, pathOf(roots, root, module)));
      if (file !== undefined) {
        sourceFiles.set(key, file);
        revision.texts.set(key, file.text);
      }
      return file;
    };
    const paragraph = (text: string) => input.joinLinesFlat((text.split(/\n\s*\n/)[0] ?? '').split('\n'));
    const resolvers = new Map<string, Resolver>();
    const contextKeys = new Map<string, ContextKeys>();
    const resolverOf = (root: AnalysisRoot): Resolver => {
      const known = resolvers.get(root.project);
      if (known !== undefined) return known;
      const project = compiler.project(overlayOf(repository, root));
      if (!contextKeys.has(root.project)) {
        // The context of Hono: every file of the roots compiled with this project.
        const files = [...input.files.entries()]
          .filter(([name]) => roots.find((candidate) => candidate.name === name)?.project === root.project && roots.find((candidate) => candidate.name === name)?.library === undefined)
          .flatMap(([name, modules]) => modules.map((module) => fileOf(name, module)).filter((file): file is SourceFile => file !== undefined));
        contextKeys.set(root.project, files.length === 0 ? new Map() : readContextKeys(project, files));
      }
      const resolver = new Resolver(project, { repository, roots, isFunction: () => true, paragraph }, contextKeys.get(root.project));
      resolvers.set(root.project, resolver);
      return resolver;
    };
    const summaryOf = (target: TreeNode['target']): string | undefined => {
      if (target === undefined || target.kind === 'untraceable') return undefined;
      if (target.kind === 'function') return input.summaryOf(target.id);
      for (const resolver of resolvers.values()) {
        const member = resolver.members.get(target.id);
        if (member !== undefined) return member.summary;
      }
      return undefined;
    };

    // The endpoint bodies of each file, found first so their files are read with the functions.
    const bodiesOf = new Map<string, Array<{ endpoint: Omit<FlowEndpoint, 'root'>; source: EndpointSource }>>();
    for (const source of input.endpoints) {
      for (const endpoint of source.endpoints) {
        if (endpoint.module === undefined) continue;
        const module = `${source.directory}/${endpoint.module}`;
        const key = `${source.source}:${module}`;
        const list = bodiesOf.get(key) ?? [];
        list.push({ endpoint, source });
        bodiesOf.set(key, list);
      }
    }
    const modulesByRoot = new Map<string, Set<string>>();
    for (const [root, modules] of input.files) modulesByRoot.set(root, new Set(modules));
    for (const key of bodiesOf.keys()) {
      const [root, module] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const set = modulesByRoot.get(root) ?? new Set<string>();
      set.add(module);
      modulesByRoot.set(root, set);
    }

    for (const [rootName, modules] of modulesByRoot) {
      const root = roots.find((candidate) => candidate.name === rootName);
      if (root === undefined) continue;
      for (const module of [...modules].sort()) {
        const file = fileOf(rootName, module);
        if (file === undefined) continue;
        const resolver = resolverOf(root);
        const fileId = `${rootName}:${module}`;
        const frames: Array<{ info: FrameInfo; input: FrameInput; parts?: Part[] }> = [];
        // The functions of the catalog.
        for (const [name, declarations] of catalogDeclarations(file)) {
          const implementation = [...declarations].reverse().find((declaration) => any(declaration)['body'] !== undefined) ?? declarations[declarations.length - 1];
          const first = declarations[0] as Node;
          if (implementation === undefined) continue;
          const id = `${rootName}:${module}#${name}`;
          const info: FrameInfo = {
            id,
            kind: 'function',
            root: rootName,
            module,
            name,
            line: startLine(file, first),
            start: docLine(file, first),
            end: endLine(file, implementation),
            declaration: startLine(file, first),
          };
          frames.push({ info, input: { id, name, signature: signatureOf(file, name, implementation), file: fileId, declaration: implementation, firstLine: info.start } });
        }
        // The endpoint bodies that are not functions of the catalog.
        for (const { endpoint, source } of bodiesOf.get(`${rootName}:${module}`) ?? []) {
          const owners = new Map<Node, true>();
          for (const match of file.text.matchAll(MARKERS)) {
            const owner = ownerAt(file, (match.index ?? 0) + (match[0].length - match[0].trimStart().length));
            if (owner !== undefined) owners.set(owner, true);
          }
          let handlers: Array<{ node: Node; registration?: Registration }> = [...owners.keys()].map((node) => ({ node }));
          const routes = source.layout === 'hono' ? registrations(file) : [];
          if (handlers.length === 0) {
            if (source.layout === 'hono') handlers = routes.map((registration) => ({ node: registration.handler, registration }));
            else {
              const declared = catalogDeclarations(file);
              handlers = endpoint.methods.flatMap((method) => (declared.get(method) ?? []).filter((node) => any(node)['body'] !== undefined).map((node) => ({ node })));
            }
          } else {
            handlers = handlers.map((handler) => {
              const registration = routes.find((route) => route.handler === handler.node);
              return registration === undefined ? handler : { ...handler, registration };
            });
          }
          // The parts of the body: a function of the catalog, or an inline handler.
          const parts: Part[] = handlers.map((handler) => {
            const declaration = handler.node;
            const name = is(declaration, SyntaxKind.FunctionDeclaration) && is(declaration.parent, SyntaxKind.SourceFile) ? nameOf(declaration['name']) : undefined;
            const routesOfHandler = routes.filter((route) => route.handler === declaration);
            const label = routesOfHandler.length > 0
              ? `${[...new Set(routesOfHandler.map((route) => route.method))].join(' | ')} ${routePath(endpoint.path, routesOfHandler[0]?.path ?? '/')}`
              : `${endpoint.methods.join(' | ')} ${endpoint.path}`;
            const registration = handler.registration ?? routesOfHandler[0];
            return { declaration, label, ...(name === undefined ? {} : { function: `${rootName}:${module}#${name}` }), ...(registration === undefined ? {} : { registration }) };
          });
          const bodyId = source.source === 'hono' ? `endpoint:${endpoint.id}` : `endpoint:${source.source}:${endpoint.id}`;
          const rootKey = `${source.source}:${endpoint.id}`;
          if (parts.length === 1 && parts[0]?.function !== undefined) {
            revision.endpointRoots.set(rootKey, parts[0].function);
            continue;
          }
          if (parts.length === 0) continue;
          revision.endpointRoots.set(rootKey, bodyId);
          if (parts.length === 1) {
            const part = parts[0] as (typeof parts)[number];
            const statement = part.registration?.statement ?? part.declaration;
            const info: FrameInfo = {
              id: bodyId,
              kind: 'body',
              root: rootName,
              module,
              name: part.label,
              line: startLine(file, statement),
              start: startLine(file, statement),
              end: endLine(file, statement),
              declaration: startLine(file, statement),
              endpoint: endpoint.id,
              source: source.source,
            };
            frames.push({ info, input: { id: bodyId, name: part.label, signature: shorten(`${part.label}`, 80), file: fileId, declaration: part.declaration, firstLine: info.start, lastLine: info.end } });
            continue;
          }
          // Several handlers: one tree that chooses between them.
          const lines = parts.map((part) => part.registration?.statement ?? part.declaration);
          const first = Math.min(...lines.map((node) => startLine(file, node)));
          const last = Math.max(...lines.map((node) => endLine(file, node)));
          const name = `${endpoint.methods.join(' | ')} ${endpoint.path}`;
          frames.push({
            info: {
              id: bodyId,
              kind: 'body',
              root: rootName,
              module,
              name,
              line: first,
              start: first,
              end: last,
              declaration: first,
              endpoint: endpoint.id,
              source: source.source,
              ...(parts.every((part) => part.function !== undefined) ? { synthetic: true } : {}),
            },
            input: { id: bodyId, name, signature: name, file: fileId, declaration: file, firstLine: first, lastLine: last },
            parts,
          });
        }
        if (frames.length === 0) continue;
        const bodies = frames.flatMap((frame) => (frame.parts === undefined ? [frame.input.declaration] : frame.parts.map((part) => part.declaration)));
        const resolution = resolver.resolve(bodies);
        const context = { file, resolution, summaryOf, stepOf: input.stepOf, joinLines: input.joinLines };
        for (const frame of frames) {
          revision.frames.set(frame.info.id, frame.info);
          revision.trees.set(frame.info.id, frame.parts === undefined ? buildTree(context, frame.input) : buildDispatch(context, frame.info, frame.input.file, frame.parts));
        }
      }
    }
    for (const resolver of resolvers.values()) for (const [id, member] of resolver.members) revision.members.set(id, member);
    return revision;
  } finally {
    compiler.close();
  }
}

/** The tree of an endpoint with several handlers: a choice of the handler, each side its body (or the call of its function). */
function buildDispatch(context: Parameters<typeof buildTree>[0], info: FrameInfo, file: string, parts: readonly Part[]): BuiltTree {
  const uses: BuiltTree['uses'] = new Map();
  const own: BuiltTree['own'] = new Map();
  const branches = parts.map((part, index) => {
    if (part.function !== undefined) {
      const summary = context.summaryOf({ kind: 'function', id: part.function });
      const call: TreeNode = {
        id: '',
        kind: 'call',
        lines: [startLine(context.file, part.declaration), endLine(context.file, part.declaration)],
        code: `${part.function.slice(part.function.indexOf('#') + 1)}(…)`,
        target: { kind: 'function', id: part.function },
        ...(summary === undefined ? {} : { text: summary, from: 'doc' as const }),
      };
      own.set(call, call.code);
      return { key: `c${index}`, label: part.label, nodes: [call] };
    }
    const built = buildTree(context, { id: info.id, name: part.label, signature: part.label, file, declaration: part.declaration, firstLine: startLine(context.file, part.declaration) });
    for (const [block, list] of built.uses) uses.set(block, list);
    for (const [node, text] of built.own) own.set(node, text);
    const statement = part.registration?.statement;
    const nodes = built.tree.nodes;
    if (statement !== undefined && nodes[0] !== undefined) nodes[0].lines = [Math.min(nodes[0].lines[0], startLine(context.file, statement)), nodes[0].lines[1]];
    return { key: `c${index}`, label: part.label, nodes };
  });
  const root: TreeNode = {
    id: '',
    kind: 'switch',
    lines: [info.start, info.end],
    code: 'どのリクエストか',
    subject: 'リクエスト',
    text: 'メソッドとパスで、受ける処理を分ける',
    from: 'code',
    branches,
  };
  own.set(root, 'dispatch');
  const nodes = [root];
  // The bodies were placed under trees of their own; their ids follow the choice now.
  place(nodes, 's');
  return {
    tree: {
      id: info.id,
      name: info.name,
      signature: info.name,
      file,
      lines: [info.start, info.end],
      head: [info.start, info.start],
      nodes,
      ...(info.synthetic === true ? { synthetic: true } : {}),
    },
    uses,
    own,
  };
}

/** The modules of the roots the catalog reads, for a revision of the working tree: from the cards' modules. */
export function catalogModules(cards: Iterable<{ package: string; module: string }>): Map<string, string[]> {
  const modules = new Map<string, Set<string>>();
  for (const card of cards) {
    const set = modules.get(card.package) ?? new Set<string>();
    set.add(card.module);
    modules.set(card.package, set);
  }
  return new Map([...modules].map(([root, set]) => [root, [...set].sort()]));
}

export { moduleOf };
