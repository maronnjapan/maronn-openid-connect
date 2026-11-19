/**
 * The cases of each endpoint: the ways a request takes through it, as the
 * map offers them ready-made (the choices of the frame its trace starts at:
 * the way into a step, each way it ends, each failure that can come up from
 * below), with what the tests say about each.
 *
 * - The steps a case runs come from walking the endpoint's tree along the
 *   choice (map-analysis walk.ts): the steps the walk reaches, in order, up
 *   to where the case ends. The walk stays in the endpoint's own frame; a
 *   call the choice makes fail fails there.
 * - A failure is joined to the tests by the same words the gaps use: the
 *   OAuth code of the error (`TokenError(invalid_client)` → `invalid_client`),
 *   else its class, among the errors a test expects (TestCase.errors). The
 *   tests of the function that throws it speak for it directly; the other
 *   tests of the endpoint that expect the same error speak for the code
 *   alone, which another cause may give too (FailureTests).
 *
 * These are rules, not guesses: a case with no test under them is shown as
 * having none, and nothing is inferred from the title of a test.
 */
import { createHash } from 'node:crypto';
import { failureSelections, frameSelections, stepsOf, walkFlow, type Failure, type FlowTree, type MapData, type Selection, type TreeNode } from '@maronn-openid-connect/map-analysis';
import { errorCodeOf, type Joined } from './join.js';
import type { EndpointCase, EndpointCases, FailureTests, TestCase } from './model.js';

/** A tree with the uses of the values its steps make, as the analysis builds it (map-analysis BuiltTree). */
export interface CaseTree {
  tree: FlowTree;
  uses?: Parameters<typeof frameSelections>[1];
}

/** The class an error is thrown as: `TokenError(invalid_client)` → `TokenError`; undefined for a plain `Error`, which says nothing. */
export function errorClassOf(failure: string): string | undefined {
  const name = /^[A-Za-z_$][\w$]*/.exec(failure)?.[0];
  return name === undefined || name === 'Error' ? undefined : name;
}

/** Whether a test expects a failure: its OAuth code when it has one, else its class, is among the errors the test expects. */
export function expectsFailure(test: Pick<TestCase, 'errors'>, error: string): boolean {
  const errors = test.errors ?? [];
  const code = errorCodeOf(error);
  if (code !== undefined) return errors.includes(code);
  const name = errorClassOf(error);
  return name !== undefined && errors.includes(name);
}

/** The id of a case: a hash of its kind, its name and the node it leads to. */
export function caseId(selection: Pick<Selection, 'kind' | 'name' | 'target'>): string {
  return createHash('sha256').update([selection.kind, selection.name, selection.target].join('\u0000')).digest('hex').slice(0, 12);
}

/** The tests that speak for a failure (see FailureTests): `ofFunction` are the tests of the function that throws it, `ofEndpoint` those of the endpoint. */
export function failureTests(error: string, ofFunction: readonly TestCase[], ofEndpoint: readonly TestCase[]): FailureTests {
  const direct = ofFunction.filter((test) => expectsFailure(test, error));
  const known = new Set(direct);
  const byCode = ofEndpoint.filter((test) => !known.has(test) && expectsFailure(test, error));
  const nearby = direct.length + byCode.length > 0 ? [] : ofFunction.filter((test) => test.outcome === 'failure' && (test.errors ?? []).length === 0);
  const ids = (tests: readonly TestCase[]) => [...new Set(tests.map((test) => test.id))].sort();
  return { direct: ids(direct), byCode: ids(byCode), nearby: ids(nearby) };
}

/**
 * The cases of an endpoint from the choices of its root frame: each walked
 * for its steps and its end; a failure with the step it comes up in and the
 * tests that expect it (`testsOf` gives the tests of a frame).
 */
export function casesOf(tree: FlowTree, selections: readonly Selection[], ofEndpoint: readonly TestCase[], testsOf: (frame: string) => readonly TestCase[]): EndpointCase[] {
  const cases: EndpointCase[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (selection.kind === 'change') continue;
    const id = caseId(selection);
    if (seen.has(id)) continue;
    seen.add(id);
    const walked = walkFlow(tree, selection.decisions);
    // The stop the failure comes up at in the endpoint's own frame: the call that fails, or the throw.
    const failed = walked.stops.find((stop) => stop.event === 'fails' || stop.event === 'throws');
    // A catch that runs answers for a failure, the one the walk saw or the one the choice only says happened.
    const caught = walked.stops.some((stop) => stop.event === 'catches');
    const end: EndpointCase['end'] = walked.outcome === 'fails' ? 'escapes' : failed !== undefined || caught ? 'error-response' : 'response';
    const made: EndpointCase = { id, kind: selection.kind, name: selection.name, ...(selection.note === undefined || selection.note === '' ? {} : { note: selection.note }), steps: stepsOf(walked), end };
    // A failure is what the map names as one, or a way that ends in a throw of the endpoint's own.
    const error = selection.failure?.error ?? failed?.error;
    if (error !== undefined && (selection.kind === 'failure' || failed !== undefined)) {
      const from = selection.failure?.from ?? tree.id;
      const code = errorCodeOf(error);
      made.failure = { error, ...(code === undefined ? {} : { code }), from, name: selection.failure?.name ?? tree.name, ...(failed?.step === undefined ? {} : { step: failed.step }) };
      made.tests = failureTests(error, from === tree.id ? [] : testsOf(from), ofEndpoint);
    }
    cases.push(made);
  }
  return cases;
}

/** Whether a node or one below it carries a step mark: a tree with none has no step to tell a case by. */
function hasSteps(nodes: readonly TreeNode[]): boolean {
  return nodes.some((node) => node.step !== undefined || hasSteps(node.pre ?? []) || (node.branches ?? []).some((branch) => hasSteps(branch.nodes)));
}

/**
 * The cases of every endpoint of hono and Next.js whose root frame has a
 * tree with steps, by `<source>:<endpoint>`. `trees` are the trees of the
 * working tree (with the value uses the step choices read), `failures` the
 * failures that leave each frame.
 */
export function endpointCases(data: MapData, trees: ReadonlyMap<string, CaseTree>, failures: ReadonlyMap<string, readonly Failure[]>, joined: Joined): Map<string, EndpointCases> {
  const plain = new Map([...trees].map(([id, built]) => [id, built.tree]));
  const nameOf = (id: string) => data.functions[id]?.name ?? plain.get(id)?.name ?? id;
  const found = new Map<string, EndpointCases>();
  for (const source of ['hono', 'nextjs'] as const) {
    for (const endpoint of data.flows[source]?.endpoints ?? []) {
      const built = trees.get(endpoint.root);
      if (built === undefined || !hasSteps(built.tree.nodes)) continue;
      const key = `${source}:${endpoint.id}`;
      const selections = [...frameSelections(built.tree, built.uses), ...failureSelections(endpoint.root, plain, failures, nameOf)];
      const cases = casesOf(built.tree, selections, joined.endpoints.get(key)?.tests ?? [], (frame) => joined.frames.get(frame)?.tests ?? []);
      if (cases.length > 0) found.set(key, { version: 1, key, cases });
    }
  }
  return found;
}
