/**
 * The requests measured API tests sent, joined to the cases of their
 * endpoint (cases.ts): what ran while a request was answered (the Istanbul
 * counters packages/test-reach records with it, RawExchange.ran) tells the
 * side each decision of the trees of the map took, so the cases the request
 * took; a case keeps the best of those requests as its examples, each with
 * the steps it ran and the response.
 *
 * The side a decision took and whether a node ran are read by the rules of
 * map-analysis (observe.ts), which the page of the map shares. A decision
 * seen both ways contradicts no side, and what the rules cannot tell is left
 * unseen. A request takes a case when no
 * decision of the case's choice is contradicted, at least one is seen (none
 * for a choice of no decision), the decisions the case hangs on are seen
 * (every side off the way a walk assumes, so never `responseMode ??= …`,
 * which Istanbul does not count; for the way into a step, the sides past
 * the way to its block; for a failure from below, the call of the
 * endpoint's frame it fails at), and the end of the case ran: the node its
 * way leads to, or for a failure the throw of its error in the function
 * that throws it, with an error status (or, for a case answered by a catch,
 * that catch) and no other OAuth error code in the response; a failure from
 * below is not taken when a `try` of a frame on its way up was seen catching
 * and no rethrow of that catch ran (it threw another error, or none). These are
 * rules, not guesses: what they cannot tell is left unseen, and a case no
 * request took has no example.
 *
 * Only a request a line of its test's own code sent is read (sent.ts
 * sentLine): an example says that line and its code, so the reader finds
 * the request in the code of the test it names. A request no line of its
 * test sent (a hook, a framework that forwarded it) is left out, as are the
 * requests overlapped by another and those without a response.
 */
import { Buffer } from 'node:buffer';
import {
  assumedSide,
  BOTH,
  FAILS,
  GOES,
  locate,
  nodeRan,
  nodesOf,
  placesOf,
  RequestRun,
  seenDecisions,
  seenSide,
  stepsOf,
  throughTries,
  walkFlow,
  wayTo,
  type Decisions,
  type FlowTree,
  type FlowWalk,
  type Located,
  type RunSources,
  type Selection,
  type TreeNode,
} from '@maronn-openid-connect/map-analysis';
import type { CaseCondition, CaseExample, EndpointCase, ExampleStep, RawExchange, TestCase } from './model.js';
import { lineCode, sentLine } from './sent.js';

// The reading of a request against the trees is map-analysis's (observe.ts), which the page of the map shares; the catalog names it as before.
export { BOTH, GOES, locate, nodeRan, RequestRun, seenSide, type Located };

/** What the rules read besides a request: the trees, the files and the frames of the map (map-analysis RunSources). */
export type CaseSources = RunSources;

/** How many examples a case keeps. */
export const EXAMPLES = 3;

/** A case with the choice it is made from and its walk (cases.ts). */
export interface CaseWay {
  made: EndpointCase;
  selection: Selection;
  walked: FlowWalk;
}

/** A request a measured test sent, with the test. */
export interface SentRequest {
  test: TestCase;
  exchange: RawExchange;
  /** The line of the test's own code that sent it, and the code of that line (sent.ts); absent when no line of the test sent it, which keeps it from being an example. */
  sent?: { line: number; code: string };
}

/** The `try` nodes of a tree whose body holds a node, from the innermost out. */
function triesAround(tree: FlowTree, id: string): TreeNode[] {
  const places = placesOf(tree);
  const tries: TreeNode[] = [];
  let at = places.get(id);
  while (at?.owner !== undefined) {
    const { owner } = at;
    if (owner.kind === 'try' && !at.pre && owner.branches?.find((branch) => branch.key === 'try')?.nodes === at.list) tries.push(owner);
    at = places.get(owner.id);
  }
  return tries;
}

/**
 * Whether a failure from below got up through the frames between the
 * endpoint's and the one that throws it: no `try` of those frames whose body
 * holds the way on (the next call, or the throw) was seen catching without a
 * rethrow of its catch running. The map leaves those tries undecided (their
 * catch can throw what it caught), but one that caught the error and threw
 * another, or none, ended the failure there.
 */
function getsUp(way: CaseWay, tree: FlowTree, run: RequestRun, sources: CaseSources): boolean {
  const frames = way.selection.frames ?? [];
  const keys = [...frames, way.selection.target];
  return frames.every((frame, index) => {
    const call = locate(frame, tree, sources.treeOf)?.place.node;
    const callee = call?.target?.kind === 'function' ? sources.treeOf(call.target.id) : undefined;
    const next = keys[index + 1]?.slice(frame.length + 1).split('.')[0];
    if (callee === undefined || next === undefined) return true;
    return triesAround(callee, next).every((attempt) => {
      const located = locate(`${frame}.${attempt.id}`, tree, sources.treeOf);
      if (located === undefined || seenSide(located, run) !== 'catch') return true;
      const handler = attempt.branches?.find((branch) => branch.key === 'catch')?.nodes ?? [];
      return [...nodesOf(handler)].some((node) => {
        if (node.kind !== 'throw' || node.rethrow !== true) return false;
        const thrown = locate(`${frame}.${node.id}`, tree, sources.treeOf);
        return thrown !== undefined && nodeRan(thrown, run);
      });
    });
  });
}

/** Whether the catch the walk of a case runs at the endpoint's own frame ran. */
function caught(way: CaseWay, tree: FlowTree, run: RequestRun, sources: CaseSources): boolean {
  const stop = way.walked.stops.find((candidate) => candidate.depth === 0 && candidate.event === 'catches');
  const located = stop === undefined ? undefined : locate(stop.node.id, tree, sources.treeOf);
  return located !== undefined && seenSide(located, run) === 'catch';
}

/** Whether a side of a decision is the one a walk takes where a choice names none (a guard passed, no exception, a loop run): a way that takes another has to be seen taking it. */
function isAssumed(node: TreeNode, side: string): boolean {
  return assumedSide(node, (node.branches ?? []).filter((branch) => branch.always !== true))?.key === side;
}

/**
 * The OAuth error code a response names: the `error` of its JSON body, or
 * of the query or the fragment of the URL it redirects to; undefined when it
 * names none.
 */
export function responseError(response: NonNullable<RawExchange['response']>): string | undefined {
  try {
    const body = JSON.parse(response.body ?? '') as unknown;
    if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') return (body as { error: string }).error;
  } catch {
    // Not JSON: the error may be in the URL it redirects to.
  }
  const location = response.headers.find(([name]) => name === 'location')?.[1];
  if (location === undefined) return undefined;
  try {
    const url = new URL(location, 'https://op.invalid');
    return url.searchParams.get('error') ?? new URLSearchParams(url.hash.slice(1)).get('error') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a request took a case (see the module comment): no decision of
 * its choice contradicted, at least one seen, and seen where the evidence
 * hangs on it: every side the choice takes off the way a walk assumes (a
 * call that fails aside: the throw says it), for the way into a step every
 * side it takes past the way to its block (the use of the step's value
 * that tells the step apart), and for a failure from below the call of the
 * endpoint's frame it fails at; and the end of the case ran. For a failure
 * from below, no frame on its way up caught it without rethrowing it
 * (getsUp); for a failure with an OAuth code, the response names that code
 * when it names one.
 */
export function takes(way: CaseWay, tree: FlowTree, run: RequestRun, response: NonNullable<RawExchange['response']>, sources: CaseSources): boolean {
  const toBlock = way.made.kind === 'step' ? (wayTo(tree.nodes, way.selection.target)?.decisions ?? {}) : undefined;
  const failingCall = way.made.kind === 'failure' && way.selection.target.includes('.') ? way.selection.target.split('.')[0] : undefined;
  let seen = 0;
  for (const [key, side] of Object.entries(way.selection.decisions)) {
    const located = locate(key, tree, sources.treeOf);
    const found = located === undefined ? undefined : seenSide(located, run);
    if (found === undefined || found === BOTH) {
      // Not seen where the case hangs on it: the evidence for this case is not there.
      const offAssumed = side !== FAILS && (located === undefined || !isAssumed(located.place.node, side));
      const pastBlock = toBlock !== undefined && toBlock[key] !== side;
      if (offAssumed || pastBlock || key === failingCall) return false;
      continue;
    }
    if (found !== side) return false;
    seen += 1;
  }
  // A choice of no decision (the one way of a pipeline without a branch) has nothing to see: its end running is the evidence.
  if (seen === 0 && Object.keys(way.selection.decisions).length > 0) return false;
  const target = locate(way.selection.target, tree, sources.treeOf);
  if (target === undefined) return false;
  const failure = way.made.failure;
  if (way.made.kind !== 'failure' || failure === undefined) return nodeRan(target, run);
  const thrown = target.place.node;
  if (target.tree.id !== failure.from || thrown.kind !== 'throw' || (thrown.error ?? 'Error') !== failure.error || !nodeRan(target, run)) return false;
  if (!getsUp(way, tree, run, sources)) return false;
  const named = responseError(response);
  if (failure.code !== undefined && named !== undefined && named !== failure.code) return false;
  return response.status >= 400 || (way.made.end === 'error-response' && caught(way, tree, run, sources));
}

/** The first sentence of words (to the first `。`), on one line. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  const end = flat.indexOf('。');
  return end === -1 ? flat : flat.slice(0, end + 1);
}

/** A decision and a side in words: the words of its node when it has some (their first sentence), else its code. */
export function conditionOf(node: TreeNode, side: string, step: string | undefined): CaseCondition {
  const words = node.text === undefined || node.text.trim() === '' ? undefined : firstSentence(node.text);
  return { ...(step === undefined ? {} : { step }), text: words ?? node.code.replace(/\s+/g, ' ').trim(), code: words === undefined, side };
}

/** What an endpoint gives the examples of its cases besides the requests. */
export interface EndpointExamples {
  /** The tree of its root frame. */
  tree: FlowTree;
  /** The function of each step that has one (FlowStep.functionId), by step id. */
  stepFunctions: ReadonlyMap<string, string>;
  /** The functions of the catalog a frame calls (MapData.functions[id].calls). */
  callsOf(frame: string): readonly string[];
  /** Whether a test is one of the endpoint's own: its code requests the endpoint. */
  own(test: TestCase): boolean;
}

/** Whether a walk reaches the end of a case: the throw or the failing call of a failure, the node of any other. */
function reaches(walked: FlowWalk, way: CaseWay): boolean {
  const target = way.selection.target;
  if (way.made.kind === 'failure') {
    const first = target.split('.')[0];
    return walked.stops.some((stop) => stop.depth === 0 && stop.node.id === first && (stop.event === 'fails' || stop.event === 'throws'));
  }
  return walked.stops.some((stop) => stop.depth === 0 && stop.node.id === target);
}

/** The request of an example: the path and the query of its URL, and its host. */
export function requestOf(exchange: Pick<RawExchange, 'request'>): CaseExample['request'] | undefined {
  let url: URL;
  try {
    url = new URL(exchange.request.url);
  } catch {
    return undefined;
  }
  const { method, headers, body, truncated } = exchange.request;
  return { method, path: `${url.pathname}${url.search}`, host: url.host, headers, ...(body === undefined ? {} : { body }), ...(truncated === true ? { truncated } : {}) };
}

/**
 * The example a request makes of a case it took: its endpoint's tree walked
 * along the sides seen at every decision of the root frame and the case's
 * own where none was seen (a `try` seen to catch whose body has the call
 * that failed runs its body up to it), each step with how it went, the
 * decisions seen in it and the functions whose calls in it ran (RequestRun.callRan). Undefined when
 * that walk does not reach the end of the case. `taken` are all the cases
 * the request took: a failure of one names the error of a step that failed.
 */
export function exampleOf(way: CaseWay, taken: readonly CaseWay[], sent: SentRequest, run: RequestRun, endpoint: EndpointExamples): CaseExample | undefined {
  const { tree } = endpoint;
  const response = sent.exchange.response;
  const request = requestOf(sent.exchange);
  if (response === undefined || request === undefined || sent.sent === undefined) return undefined;
  const ofCase: Decisions = {};
  for (const [key, side] of Object.entries(way.selection.decisions)) if (!key.includes('.')) ofCase[key] = side;
  const seen = seenDecisions(tree, run);
  const walked = walkFlow(tree, throughTries(tree, { ...ofCase, ...seen }));
  if (!reaches(walked, way)) return undefined;
  const errorAt = (step: string): string | undefined => {
    if (way.made.failure?.step === step) return way.made.failure.error;
    const errors = new Set(taken.flatMap((other) => (other.made.kind === 'failure' && other.made.failure?.step === step ? [other.made.failure.error] : [])));
    return errors.size === 1 ? [...errors][0] : undefined;
  };
  const steps: ExampleStep[] = stepsOf(walked).map((id) => ({ id, how: 'ran' }));
  const byId = new Map(steps.map((step) => [step.id, step]));
  let catching = false;
  for (const stop of walked.stops) {
    // A return answers from the step of the last stepped call it returns the result of (`return respond(c, await process(c))` outside the steps, a step's `return issueAuthorizationCodeResponse(…)`), else from its own step.
    const answering = stop.event === 'returns' ? [...nodesOf(stop.node.pre ?? [])].reverse().find((node) => node.step !== undefined && byId.has(node.step.id))?.step?.id : undefined;
    const step = byId.get(answering ?? stop.step ?? '');
    if (stop.event === 'catches') {
      if (step === undefined) catching = true;
      else step.how = 'caught';
      continue;
    }
    if (step === undefined) continue;
    if (catching) {
      step.how = 'caught';
      catching = false;
    }
    if (stop.event === 'fails' || stop.event === 'throws') {
      step.how = 'failed';
      const error = stop.error ?? errorAt(step.id);
      if (error !== undefined) step.error = error;
    } else if (stop.event === 'returns' && step.how === 'ran') step.how = 'answered';
    if (stop.side !== undefined && seen[stop.node.id] === stop.side.key && stop.node.kind !== 'call') {
      step.decisions = [...(step.decisions ?? []), conditionOf(stop.node, stop.side.label, step.id)];
    }
  }
  for (const step of steps) {
    if (step.how !== 'failed') delete step.error;
    const fn = endpoint.stepFunctions.get(step.id);
    const catalog = fn === undefined ? undefined : new Set(endpoint.callsOf(fn));
    const ran =
      fn !== undefined
        ? run.calledBy(fn).filter((frame) => catalog?.has(frame) === true)
        : walked.stops.flatMap((stop) => (stop.depth === 0 && stop.step === step.id && stop.node.kind === 'call' && stop.node.target?.kind === 'function' && run.callRan(tree, stop.node) ? [stop.node.target.id] : []));
    const calls = [...new Set(ran)];
    if (calls.length > 0) step.calls = calls;
  }
  const { status, statusText, headers, body, truncated } = response;
  return {
    test: sent.test.id,
    line: sent.sent.line,
    code: sent.sent.code,
    request,
    response: { status, ...(statusText === undefined || statusText === '' ? {} : { statusText }), headers, ...(body === undefined ? {} : { body }), ...(truncated === true ? { truncated } : {}) },
    steps,
  };
}

/** How big a request is to read: the bytes of its headers and its body. */
function sizeOf(exchange: RawExchange): number {
  const headers = exchange.request.headers.reduce((sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value), 0);
  return headers + Buffer.byteLength(exchange.request.body ?? '');
}

/** What joining the requests of an endpoint to its cases saw. */
export interface ExampleCounts {
  /** The requests read: those overlapped by another, without a response, or sent by no line of their test left out. */
  read: number;
  /** Of those, the ones that took a case. */
  took: number;
  /** The requests left out because no line of their test sent them (SentRequest.sent). */
  unpinned: number;
  /** The cases that got a sample from the requests run on the OP of the map (samples.ts). */
  sampled?: number;
}

/**
 * Give the cases of an endpoint the requests that took them (see the module
 * comment): each case its examples, the tests of the endpoint's own first,
 * then the smaller requests, one of each method, path, Authorization header
 * and body, at most EXAMPLES, and how many requests took it in all.
 */
export function attachExamples(ways: readonly CaseWay[], requests: readonly SentRequest[], endpoint: EndpointExamples, sources: CaseSources): ExampleCounts {
  const found = new Map<CaseWay, Array<{ sent: SentRequest; example: CaseExample; order: number }>>();
  const counts: ExampleCounts = { read: 0, took: 0, unpinned: 0 };
  requests.forEach((sent, order) => {
    const { response, overlapped, error } = sent.exchange;
    if (response === undefined || overlapped === true || error !== undefined) return;
    if (sent.sent === undefined) {
      counts.unpinned += 1;
      return;
    }
    counts.read += 1;
    const run = new RequestRun(sent.exchange, sources);
    const taken = ways.filter((way) => takes(way, endpoint.tree, run, response, sources));
    let took = false;
    for (const way of taken) {
      const example = exampleOf(way, taken, sent, run, endpoint);
      if (example === undefined) continue;
      found.set(way, [...(found.get(way) ?? []), { sent, example, order }]);
      took = true;
    }
    if (took) counts.took += 1;
  });
  for (const way of ways) {
    const list = found.get(way);
    if (list === undefined) continue;
    const ranked = [...list].sort((a, b) => Number(!endpoint.own(a.sent.test)) - Number(!endpoint.own(b.sent.test)) || sizeOf(a.sent.exchange) - sizeOf(b.sent.exchange) || (a.sent.test.id < b.sent.test.id ? -1 : a.sent.test.id > b.sent.test.id ? 1 : 0) || a.order - b.order);
    const kept = new Set<string>();
    const examples: CaseExample[] = [];
    for (const { example } of ranked) {
      // The Authorization header is input as much as the body (a bearer token, a client's Basic credentials).
      const authorization = example.request.headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
      const key = [example.request.method, example.request.path, authorization, example.request.body ?? ''].join('\u0000');
      if (kept.has(key)) continue;
      kept.add(key);
      examples.push(example);
      if (examples.length === EXAMPLES) break;
    }
    way.made.examples = examples;
    way.made.exampleCount = list.length;
  }
  return counts;
}

/**
 * The requests of the measured tests by endpoint, `<source>:<endpoint>`: a
 * request of a test of hono goes to the endpoint of hono whose path its URL
 * has (`endpointOf`), and so for Next.js; the tests of any other root send
 * none to an endpoint of a source. Each says the line of its test that sent
 * it and that line's code (`linesOf` gives the lines of a test file), when
 * a line of the test did.
 */
export function requestsByEndpoint(
  exchanges: ReadonlyMap<string, readonly RawExchange[]>,
  tests: ReadonlyMap<string, TestCase>,
  endpointOf: (source: 'hono' | 'nextjs', path: string) => string | undefined,
  linesOf: (path: string) => readonly string[] | undefined = () => undefined,
): Map<string, SentRequest[]> {
  const byEndpoint = new Map<string, SentRequest[]>();
  for (const [id, list] of exchanges) {
    const test = tests.get(id);
    const source = test?.root === 'hono' || test?.root === 'nextjs' ? test.root : undefined;
    if (test === undefined || source === undefined) continue;
    for (const exchange of list) {
      let path: string;
      try {
        path = new URL(exchange.request.url).pathname;
      } catch {
        continue;
      }
      const endpoint = endpointOf(source, path);
      if (endpoint === undefined) continue;
      const key = `${source}:${endpoint}`;
      const line = sentLine(test, exchange);
      const sent = line === undefined ? {} : { sent: { line, code: lineCode(linesOf(test.source.file), line) } };
      byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), { test, exchange, ...sent }]);
    }
  }
  return byEndpoint;
}
