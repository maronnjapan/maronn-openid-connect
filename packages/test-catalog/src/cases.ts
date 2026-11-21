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
 * - The conditions of a case are the sides its choice names, in words, in
 *   the order a walk along it meets them (into the frames a failure comes up
 *   through): what a request must do to take it, whether a request did or
 *   not.
 * - With the requests of a measured run (examples.ts), a case gets the
 *   requests that took it as its examples.
 *
 * These are rules, not guesses: a case with no test under them is shown as
 * having none, and nothing is inferred from the title of a test.
 */
import { createHash } from 'node:crypto';
import { FAILS, failureSelections, frameSelections, stepsOf, walkFlow, type Failure, type FlowTree, type MapData, type Selection, type TreeNode } from '@maronn-openid-connect/map-analysis';
import { attachExamples, conditionOf, type CaseSources, type CaseWay, type ExampleCounts, type SentRequest } from './examples.js';
import { errorCodeOf, type Joined } from './join.js';
import type { CaseCondition, EndpointCase, EndpointCases, FailureTests, TestCase } from './model.js';

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
 * The sides a choice names, in words, in the order a walk along it meets
 * them: the walk goes into the frames the choice opens (a failure from
 * below), and a decision of such a frame is in the step of the call of the
 * root that opened it. A call the choice makes fail says 失敗する; the plain
 * run of a `try` (no exception) is what every other way does too, and is
 * left out.
 */
export function conditionsOf(tree: FlowTree, selection: Pick<Selection, 'decisions' | 'frames'>, treeOf: (id: string) => FlowTree | undefined = () => undefined): CaseCondition[] {
  const open = new Set(selection.frames ?? []);
  const walked = walkFlow(tree, selection.decisions, { enter: (key, call) => (open.has(key) && call.target?.kind === 'function' ? treeOf(call.target.id) : undefined) });
  const conditions: CaseCondition[] = [];
  const met = new Set<string>();
  let step: string | undefined;
  for (const stop of walked.stops) {
    if (stop.depth === 0) step = stop.step;
    const key = stop.frame === '' ? stop.node.id : `${stop.frame}.${stop.node.id}`;
    const chosen = selection.decisions[key];
    if (chosen === undefined || met.has(key)) continue;
    met.add(key);
    if (chosen === FAILS) conditions.push(conditionOf(stop.node, '失敗する', step));
    else if (stop.side !== undefined && stop.side.key === chosen && !(stop.node.kind === 'try' && chosen === 'try')) conditions.push(conditionOf(stop.node, stop.side.label, step));
  }
  return conditions;
}

/**
 * The cases of an endpoint from the choices of its root frame, each with
 * the choice and the walk it is made from: walked for its steps and its
 * end; a failure with the step it comes up in and the tests that expect it
 * (`testsOf` gives the tests of a frame); its conditions read into the
 * frames `treeOf` gives.
 */
export function waysOf(tree: FlowTree, selections: readonly Selection[], ofEndpoint: readonly TestCase[], testsOf: (frame: string) => readonly TestCase[], treeOf?: (id: string) => FlowTree | undefined): CaseWay[] {
  const ways: CaseWay[] = [];
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
    made.conditions = conditionsOf(tree, selection, treeOf);
    ways.push({ made, selection, walked });
  }
  return ways;
}

/** The cases of an endpoint from the choices of its root frame (see waysOf). */
export function casesOf(tree: FlowTree, selections: readonly Selection[], ofEndpoint: readonly TestCase[], testsOf: (frame: string) => readonly TestCase[], treeOf?: (id: string) => FlowTree | undefined): EndpointCase[] {
  return waysOf(tree, selections, ofEndpoint, testsOf, treeOf).map((way) => way.made);
}

/** Whether a node or one below it carries a step mark: a tree with none has no step to tell a case by. */
function hasSteps(nodes: readonly TreeNode[]): boolean {
  return nodes.some((node) => node.step !== undefined || hasSteps(node.pre ?? []) || (node.branches ?? []).some((branch) => hasSteps(branch.nodes)));
}

/** The requests of a measured run, for the examples of the cases (examples.ts). */
export interface CaseRequests {
  /** The requests sent to each endpoint, by `<source>:<endpoint>` (requestsByEndpoint). */
  byEndpoint: ReadonlyMap<string, readonly SentRequest[]>;
  /** The lines of a file of the repository, by its path. */
  linesOf(path: string): readonly string[] | undefined;
  /** The frame a line of a file is in (run.ts FrameLocator). */
  frameAt(path: string, line: number): string | undefined;
}

/**
 * The cases of every endpoint of hono and Next.js whose root frame has a
 * tree with steps, by `<source>:<endpoint>`. `trees` are the trees of the
 * working tree (with the value uses the step choices read), `failures` the
 * failures that leave each frame; with `requests`, the cases get the
 * requests of the measured run that took them, and `counts` adds up what
 * that join saw.
 */
export function endpointCases(data: MapData, trees: ReadonlyMap<string, CaseTree>, failures: ReadonlyMap<string, readonly Failure[]>, joined: Joined, requests?: CaseRequests, counts: ExampleCounts = { read: 0, took: 0, unpinned: 0 }): Map<string, EndpointCases> {
  const plain = new Map([...trees].map(([id, built]) => [id, built.tree]));
  const treeOf = (id: string) => plain.get(id);
  const nameOf = (id: string) => data.functions[id]?.name ?? plain.get(id)?.name ?? id;
  const sources: CaseSources | undefined =
    requests === undefined ? undefined : { treeOf, pathOf: (file) => data.sources[file]?.path, linesOf: (path) => requests.linesOf(path), frameAt: (path, line) => requests.frameAt(path, line) };
  const found = new Map<string, EndpointCases>();
  for (const source of ['hono', 'nextjs'] as const) {
    for (const endpoint of data.flows[source]?.endpoints ?? []) {
      const built = trees.get(endpoint.root);
      if (built === undefined || !hasSteps(built.tree.nodes)) continue;
      const key = `${source}:${endpoint.id}`;
      const selections = [...frameSelections(built.tree, built.uses), ...failureSelections(endpoint.root, plain, failures, nameOf)];
      const ways = waysOf(built.tree, selections, joined.endpoints.get(key)?.tests ?? [], (frame) => joined.frames.get(frame)?.tests ?? [], treeOf);
      const sent = requests?.byEndpoint.get(key) ?? [];
      if (sources !== undefined && sent.length > 0) {
        const stepFunctions = new Map(endpoint.steps.flatMap((step) => (step.functionId === undefined ? [] : [[step.id, step.functionId] as const])));
        const own = (test: TestCase) => test.subjects.some((subject) => subject.kind === 'endpoint' && subject.id === endpoint.id && subject.source === source && subject.how !== 'coverage');
        const seen = attachExamples(ways, sent, { tree: built.tree, stepFunctions, callsOf: (frame) => data.functions[frame]?.calls ?? data.bodies[frame]?.calls ?? [], own }, sources);
        counts.read += seen.read;
        counts.took += seen.took;
        counts.unpinned += seen.unpinned;
      }
      if (ways.length > 0) found.set(key, { version: 1, key, cases: ways.map((way) => way.made) });
    }
  }
  return found;
}
