import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { uncoveredLines } from '../check.js';
import { escapingFailures } from '../failures.js';
import { CallGraph, reachOf, type EndpointRoot } from '../impact.js';
import type { FlowTree, TreeNode } from '../model.js';
import { readRepository, type Repository } from '../repository.js';
import { frameSelections } from '../selections.js';
import { nodesOf } from '../tree.js';

/**
 * The trees of the repository itself, read the way the build of the map reads
 * them (it needs the built CLI: `pnpm --filter @maronn-openid-connect/cli build`).
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
let repository: Repository;
beforeAll(async () => {
  repository = await readRepository(repositoryRoot);
});

/** The functions a tree calls, as the catalog counts them: the call nodes and the calls of the definitions in it. */
function treeCalls(id: string): Set<string> {
  const built = repository.head.trees.get(id);
  const calls = new Set<string>();
  for (const node of nodesOf(built?.tree.nodes ?? [])) if (node.kind === 'call' && node.target?.kind === 'function') calls.add(node.target.id);
  for (const deferred of built?.tree.deferred ?? []) if (repository.cli.catalog[deferred] !== undefined) calls.add(deferred);
  calls.delete(id);
  return calls;
}

/** The text of a module of a root. */
function textOf(root: string, module: string): string {
  const entry = repository.roots.find((candidate) => candidate.name === root);
  return readFileSync(join(repositoryRoot, entry?.directory ?? '', module), 'utf8');
}

describe('the trees of the repository', () => {
  it('should give every function of the catalog a tree, under the id the catalog gives it', () => {
    const catalog = Object.keys(repository.cli.catalog).sort();
    const functions = [...repository.head.frames.values()].filter((frame) => frame.kind === 'function').map((frame) => frame.id).sort();
    expect(functions).toEqual(catalog);
  });

  it('should call every function the catalog says a function calls, and name a reason for every call the catalog misses', () => {
    const missing: string[] = [];
    const unexplained: string[] = [];
    for (const card of Object.values(repository.cli.catalog)) {
      const calls = treeCalls(card.id);
      for (const callee of card.calls) if (!calls.has(callee)) missing.push(`${card.id} → ${callee}`);
      const text = textOf(card.package, card.module);
      for (const callee of calls) {
        if (card.calls.includes(callee)) continue;
        const name = callee.slice(callee.indexOf('#') + 1);
        const imported = new RegExp(`import[^;]*\\b${name}\\b[^;]*from\\s*['"]([^'"]+)['"]`).exec(text)?.[1];
        // The catalog resolves a name through the package of a library and a module that declares it; the types also follow a
        // subpath of a library (`@maronn-openid-connect/experimental/ciba`), a module that re-exports it, and a spread call
        // (`...name(`, which the catalog reads as the method `.name(`).
        const reason =
          imported?.startsWith('@maronn-openid-connect/') === true && imported.split('/').length > 2
            ? 'subpath'
            : imported?.startsWith('.') === true && !textOf(callee.slice(0, callee.indexOf(':')), callee.slice(callee.indexOf(':') + 1, callee.indexOf('#'))).includes(`from '${imported}'`)
              ? 're-export'
              : new RegExp(`\\.\\.\\.\\s*(await\\s+)?${name}\\(`).test(text)
                ? 'spread'
                : imported !== undefined
                  ? 're-export'
                  : undefined;
        if (reason === undefined) unexplained.push(`${card.id} → ${callee}`);
      }
    }
    expect(missing).toEqual([]);
    expect(unexplained).toEqual([]);
  });

  it('should be called by every function the catalog says calls it', () => {
    const calledBy = new Map<string, Set<string>>();
    for (const card of Object.values(repository.cli.catalog)) for (const callee of treeCalls(card.id)) calledBy.set(callee, (calledBy.get(callee) ?? new Set()).add(card.id));
    const missing = Object.values(repository.cli.catalog).flatMap((card) => card.calledBy.filter((caller) => !calledBy.get(card.id)?.has(caller)).map((caller) => `${caller} → ${card.id}`));
    expect(missing).toEqual([]);
  });

  it('should cover every line of the body of every frame with its nodes', () => {
    const uncovered: string[] = [];
    for (const [id, built] of repository.head.trees) {
      const frame = repository.head.frames.get(id);
      const text = frame === undefined ? undefined : repository.head.texts.get(`${frame.root}:${frame.module}`);
      const lines = uncoveredLines(built.tree, text);
      if (lines.length > 0) uncovered.push(`${id}: ${lines.join(', ')}`);
    }
    expect(uncovered).toEqual([]);
  });

  it('should start the trace of every endpoint of every framework from a frame it read', () => {
    const missing = repository.endpoints.flatMap((source) => source.endpoints.filter((endpoint) => !repository.head.trees.has(repository.head.endpointRoots.get(`${source.source}:${endpoint.id}`) ?? '')).map((endpoint) => `${source.source}:${endpoint.id}`));
    expect(missing).toEqual([]);
  });

  it('should offer named choices for refresh_token and authorization_code at /token with every feature on, and no nameless one', () => {
    for (const source of ['hono', 'nextjs']) {
      const root = repository.head.endpointRoots.get(`${source}:token`) as string;
      const built = repository.head.trees.get(root);
      const selections = built === undefined ? [] : frameSelections(built.tree, built.uses);
      const names = selections.map((selection) => selection.name);
      expect(names.some((name) => name.includes('refresh_token')), source).toBe(true);
      expect(names.some((name) => name.includes('authorization_code')), source).toBe(true);
      expect(new Set(names).size).toBe(names.length);
      expect(names.every((name) => name.trim() !== '')).toBe(true);
      const refresh = selections.find((selection) => selection.name.includes('refresh_token'));
      const code = selections.find((selection) => selection.name.includes('authorization_code'));
      // The two choose the two sides of `refreshTokenRequest ?? validateAuthorizationCodeGrant(…)`.
      const sides = (selection: typeof refresh) => Object.values(selection?.decisions ?? {});
      expect(sides(refresh)).toContain('defined');
      expect(sides(code)).toContain('nullish');
    }
  });

  it('should take the words of an if from the JSDoc of a predicate only when its condition is that one call', () => {
    const worded: string[] = [];
    for (const [id, built] of repository.head.trees) {
      for (const node of nodesOf(built.tree.nodes)) {
        if (node.kind !== 'if' || node.from !== 'doc') continue;
        const condition = (built.own.get(node) ?? '').replace(/^if \((.*)\)$/, '$1');
        if (!/^(!\s*)*\(?\s*(await\s+)?[\w$.?]+\(.*\)\s*\)?$/.test(condition) || /&&|\|\||[!=]==?|[<>]=?/.test(condition.replace(/\(.*\)/, '()'))) worded.push(`${id} ${node.id}: ${condition}`);
      }
    }
    expect(worded).toEqual([]);
  });

  it('should reach every call of a member of a store of hono through the resolvers that read it, under the endpoints of hono only', () => {
    const trees = new Map<string, FlowTree>([...repository.head.trees].map(([id, built]) => [id, built.tree]));
    const roots: EndpointRoot[] = repository.endpoints.flatMap((source) => source.endpoints.map((endpoint) => ({ source: source.source, frameworks: source.frameworks, endpoint: { id: endpoint.id }, root: repository.head.endpointRoots.get(`${source.source}:${endpoint.id}`) ?? '' })));
    const graph = new CallGraph(trees, roots);
    const endpointsOf = (member: string) => [...new Set(reachOf(graph, { member, root: 'hono' }).map((way) => `${way.source}:${way.endpoint}`))].sort();
    expect(endpointsOf('hono:oidc-provider/store.ts#AccessTokenStorage.get')).toEqual(expect.arrayContaining(['hono:introspection', 'hono:revocation', 'hono:userinfo']));
    expect(endpointsOf('hono:oidc-provider/store.ts#AuthorizationCodeStorage.consume')).toEqual(['hono:token']);
    // The resolvers of hono implement the members of core; the endpoints of Next.js run their own.
    expect(endpointsOf('core:token-request.ts#AuthorizationCodeResolver.revokeAuthorizationCode')).toEqual(['hono:token']);
  });

  it('should find the failures that leave a function from its trees, through the functions it calls', () => {
    const trees = new Map([...repository.head.trees].map(([id, built]) => [id, built.tree]));
    const failures = escapingFailures(trees);
    const verify = failures.get('core:client-auth.ts#verifyClientSecret')?.map((failure) => failure.error) ?? [];
    expect(verify).toContain('TokenError(invalid_client)');
    // The handler of /token catches every failure of its steps.
    expect(failures.get('endpoint:token') ?? []).toEqual([]);
  });
});

describe('the trees against the flat flows the lexical reader read', () => {
  /**
   * legacy-flows.json is what packages/cli/src/extract/function-flow.ts read
   * from every function when it was removed. A function whose text is the same
   * now is compared with it: the same calls in the same order (once each, the
   * calls only the types find left out), as many returns and throws, and no
   * more `if`s than the reader read conditions (it made one of every `&&` of
   * an `if` and of every logical operator of a value; a tree keeps the first
   * in the code of its `if` and makes a node of the second only when it calls
   * something).
   * The calls and the throws of a local function run where it is called in a
   * tree, so a function that calls one is compared by its calls alone.
   */
  const legacy = JSON.parse(readFileSync(new URL('../__fixtures__/legacy-flows.json', import.meta.url), 'utf8')) as { ids: string[]; functions: Array<[number, string, number[], number, number]> };

  it('should agree with the flows of the functions that did not change since', () => {
    const disagree: string[] = [];
    let compared = 0;
    for (const [index, hash, callIndexes, exits, conditions] of legacy.functions) {
      const id = legacy.ids[index] as string;
      const frame = repository.head.frames.get(id);
      const built = repository.head.trees.get(id);
      if (frame === undefined || built === undefined) continue;
      const text = (repository.head.texts.get(`${frame.root}:${frame.module}`) ?? '').split('\n').slice(frame.declaration - 1, frame.end).join('\n');
      if (createHash('sha256').update(text).digest('hex').slice(0, 12) !== hash) continue;
      compared += 1;
      const calls = callIndexes.map((call) => legacy.ids[call] as string);
      const order = evaluationOrder(built.tree.nodes);
      const inTree = new Set(order);
      const inLegacy = new Set(calls);
      const once = (list: readonly string[]) => [...new Set(list)];
      const inlined = [...nodesOf(built.tree.nodes)].some((node) => node.kind === 'loop' && node.text?.endsWith('の中で') === true);
      if (!inlined && JSON.stringify(once(calls.filter((call) => inTree.has(call)))) !== JSON.stringify(once(order.filter((call) => inLegacy.has(call))))) disagree.push(`${id}: calls ${calls.join(', ')} / ${order.join(', ')}`);
      if (inlined && [...inLegacy].some((call) => !inTree.has(call) && !(built.tree.deferred ?? []).includes(call))) disagree.push(`${id}: a call is missing`);
      const treeExits = [...nodesOf(built.tree.nodes)].filter((node: TreeNode) => (node.kind === 'return' && node.local !== true) || node.kind === 'throw').length;
      if (!inlined && treeExits !== exits) disagree.push(`${id}: ${treeExits} exits, the reader read ${exits}`);
      // Every `if` was at least one condition of the reader (more when its test joins tests with && or ||). The reader
      // split the value of a statement at its outermost operator only, so the cond-exprs of the tree (a ternary inside an
      // argument too) have no counterpart to count.
      const ifs = statementDecisions(built.tree.nodes).filter((node) => node.kind === 'if' && !insideCallback(built.tree.nodes, node.id)).length;
      if (ifs > conditions) disagree.push(`${id}: ${ifs} ifs, the reader read ${conditions} conditions`);
    }
    expect(compared).toBeGreaterThan(0);
    expect(disagree).toEqual([]);
  });
});

/** The ifs of a list and the cond-exprs that are statements (not evaluated inside another node), below too. */
function statementDecisions(nodes: readonly TreeNode[]): TreeNode[] {
  const found: TreeNode[] = [];
  const visit = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (node.kind === 'if' || (node.kind === 'cond-expr' && node.operator !== undefined && !node.operator.endsWith('='))) found.push(node);
      for (const branch of node.branches ?? []) visit(branch.nodes);
    }
  };
  visit(nodes);
  return found;
}

/** The functions the call nodes of a list call, in the order they run (what a node evaluates first before it). */
function evaluationOrder(nodes: readonly TreeNode[]): string[] {
  const order: string[] = [];
  const visit = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (node.pre !== undefined) visit(node.pre);
      if (node.kind === 'call' && node.target?.kind === 'function') order.push(node.target.id);
      for (const branch of node.branches ?? []) visit(branch.nodes);
    }
  };
  visit(nodes);
  return order;
}

/** Whether a node is inside a callback or a local function of a tree (whose conditions the lexical reader did not read). */
function insideCallback(nodes: readonly TreeNode[], id: string): boolean {
  const visit = (list: readonly TreeNode[], inside: boolean): boolean | undefined => {
    for (const node of list) {
      if (node.id === id) return inside;
      if (!id.startsWith(node.id)) continue;
      const callback = node.kind === 'loop' && node.text !== undefined && (node.text === '各要素で' || node.text === 'コールバックで' || node.text.endsWith('の中で'));
      for (const child of [node.pre ?? [], ...(node.branches ?? []).map((branch) => branch.nodes)]) {
        const found = visit(child, inside || callback);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(nodes, false) ?? false;
}
