/**
 * How each frame fails, read from the trees instead of the `@throws` of the
 * JSDoc: the throws outside a `try` that catches them, and the failures of
 * the functions it calls outside such a `try`, gathered over the whole
 * catalog until nothing changes.
 *
 * A throw inside a `catch` that throws what it caught (`throw error`) passes
 * on what that `try` caught. The members of interfaces have no tree, so a
 * call of one adds nothing.
 */
import type { Failure, FlowTree, TreeNode } from './model.js';

/** What a tree contributes before the callees are known. */
interface Own {
  throws: Failure[];
  calls: string[];
  /** For each rethrow: what the `try` it is the catch of caught (its throws and its calls). */
  rethrows: Array<{ throws: Failure[]; calls: string[] }>;
}

/** The throws and calls of a list that a `try` around them would catch, the ones further inside a catching try left out. */
function gather(nodes: readonly TreeNode[], frame: string, own: Own, caught: { throws: Failure[]; calls: string[] }[]): void {
  const target = caught[caught.length - 1];
  for (const node of nodes) {
    if (node.pre !== undefined) gather(node.pre, frame, own, caught);
    if (node.kind === 'throw') {
      if (node.rethrow === true) {
        // Handled by the try whose catch this is (see visitTry).
      } else if (target !== undefined) target.throws.push({ error: node.error ?? 'Error', from: frame });
      else own.throws.push({ error: node.error ?? 'Error', from: frame });
    }
    if (node.kind === 'call' && node.target?.kind === 'function') {
      if (target !== undefined) target.calls.push(node.target.id);
      else own.calls.push(node.target.id);
    }
    if (node.kind === 'try') {
      visitTry(node, frame, own, caught);
      continue;
    }
    for (const branch of node.branches ?? []) gather(branch.nodes, frame, own, caught);
  }
}

function visitTry(node: TreeNode, frame: string, own: Own, caught: { throws: Failure[]; calls: string[] }[]): void {
  const branches = node.branches ?? [];
  const attempt = branches.find((branch) => branch.key === 'try');
  const handler = branches.find((branch) => branch.key === 'catch');
  const final = branches.find((branch) => branch.key === 'finally');
  if (handler === undefined) {
    gather(attempt?.nodes ?? [], frame, own, caught);
  } else {
    const inside = { throws: [] as Failure[], calls: [] as string[] };
    gather(attempt?.nodes ?? [], frame, own, [...caught, inside]);
    const rethrows = [...walkAll(handler.nodes)].filter((child) => child.kind === 'throw' && child.rethrow === true).length;
    if (rethrows > 0) {
      const outer = caught[caught.length - 1];
      if (outer !== undefined) {
        outer.throws.push(...inside.throws);
        outer.calls.push(...inside.calls);
      } else own.rethrows.push(inside);
    }
    gather(handler.nodes, frame, own, caught);
  }
  if (final !== undefined) gather(final.nodes, frame, own, caught);
}

/** Where a failure can leave a list: a throw (not a rethrow) or a call of a function, whether a `try` of the frame catches it, and the tries whose attempt it is in. */
export interface Outlet {
  node: TreeNode;
  caught: boolean;
  tries: string[];
}

/** The outlets of a list (see Outlet), in the order of the code. A `try` whose catch throws what it caught does not catch. */
export function* outlets(nodes: readonly TreeNode[], caught = false, tries: readonly string[] = []): Generator<Outlet> {
  for (const node of nodes) {
    if (node.pre !== undefined) yield* outlets(node.pre, caught, tries);
    if ((node.kind === 'throw' && node.rethrow !== true) || (node.kind === 'call' && node.target?.kind === 'function')) yield { node, caught, tries: [...tries] };
    if (node.kind === 'try') {
      const handler = node.branches?.find((branch) => branch.key === 'catch');
      const rethrows = handler !== undefined && [...walkAll(handler.nodes)].some((child) => child.kind === 'throw' && child.rethrow === true);
      for (const branch of node.branches ?? []) {
        if (branch.key === 'try') yield* outlets(branch.nodes, caught || (handler !== undefined && !rethrows), handler === undefined ? tries : [...tries, node.id]);
        else yield* outlets(branch.nodes, caught, tries);
      }
      continue;
    }
    for (const branch of node.branches ?? []) yield* outlets(branch.nodes, caught, tries);
  }
}

function* walkAll(nodes: readonly TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    yield node;
    if (node.pre !== undefined) yield* walkAll(node.pre);
    for (const branch of node.branches ?? []) yield* walkAll(branch.nodes);
  }
}

/** The failures that leave each frame (see the module comment), by frame id, each list sorted. */
export function escapingFailures(trees: ReadonlyMap<string, FlowTree>): Map<string, Failure[]> {
  const owns = new Map<string, Own>();
  for (const [id, tree] of trees) {
    const own: Own = { throws: [], calls: [], rethrows: [] };
    gather(tree.nodes, id, own, []);
    owns.set(id, own);
  }
  const result = new Map<string, Map<string, Failure>>();
  const key = (failure: Failure) => `${failure.error}\u0000${failure.from}`;
  for (const [id, own] of owns) result.set(id, new Map(own.throws.map((failure) => [key(failure), failure])));
  const callers = new Map<string, Set<string>>();
  for (const [id, own] of owns) {
    for (const callee of [...own.calls, ...own.rethrows.flatMap((entry) => entry.calls)]) {
      const set = callers.get(callee) ?? new Set<string>();
      set.add(id);
      callers.set(callee, set);
    }
  }
  const pending = [...owns.keys()];
  const queued = new Set(pending);
  while (pending.length > 0) {
    const id = pending.pop() as string;
    queued.delete(id);
    const own = owns.get(id) as Own;
    const failures = result.get(id) as Map<string, Failure>;
    const before = failures.size;
    const add = (list: Iterable<Failure>) => {
      for (const failure of list) if (!failures.has(key(failure))) failures.set(key(failure), failure);
    };
    for (const callee of own.calls) add(result.get(callee)?.values() ?? []);
    for (const entry of own.rethrows) {
      add(entry.throws);
      for (const callee of entry.calls) add(result.get(callee)?.values() ?? []);
    }
    if (failures.size === before) continue;
    for (const caller of callers.get(id) ?? []) {
      if (queued.has(caller)) continue;
      queued.add(caller);
      pending.push(caller);
    }
  }
  const sorted = new Map<string, Failure[]>();
  for (const [id, failures] of result) {
    sorted.set(id, [...failures.values()].sort((a, b) => (a.error < b.error ? -1 : a.error > b.error ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : 0)));
  }
  return sorted;
}
