/**
 * A request the reader writes in the flow view and runs on the OP of the map
 * (packages/map-sandbox), and the way it took. The page sends the request to
 * the OP in a worker; what comes back, the response and the Istanbul counters
 * of what ran, is read against the trees of the frames the trace has open
 * with the rules the test catalog reads a measured test's request with
 * (map-analysis observe.ts), and the sides seen there are the choice the
 * playback follows. A decision the rules cannot tell is left to the walk,
 * which takes it on an assumed side (仮) as for any way. Nothing here touches
 * the DOM or fetches.
 */
import { FrameLocator, RequestRun, seenDecisions, throughTries, type RanInFile, type RunSources } from '@maronn-openid-connect/map-analysis/observe';
import type { FlowWalk } from '@maronn-openid-connect/map-analysis/walk';
import type { SandboxRequest } from '@maronn-openid-connect/map-sandbox';
import type { Decisions, FlowTree, MapData, Selection, WayRequest } from '../types';
import { decisionKey, frameIds } from './trace';

/** Where a parameter is sent: the query of the URL, a field of a form body, a member of a JSON body. */
export type ParamPlace = WayRequest['params'][number]['in'];

/** The body a request sends: a form (`application/x-www-form-urlencoded`), a JSON object, or none. */
export type BodyKind = 'form' | 'json' | 'none';

/** A request as the reader writes it: the method and the path of the endpoint, the parameters of its query and its body, its headers. */
export interface RequestDraft {
  method: string;
  /** The path, without the query: the query is the parameters `in: 'query'`. */
  path: string;
  body: BodyKind;
  params: Array<{ name: string; value: string; in: ParamPlace }>;
  headers: Array<[string, string]>;
}

/** The content type of a body kind. */
const CONTENT_TYPES: Record<Exclude<BodyKind, 'none'>, string> = { form: 'application/x-www-form-urlencoded', json: 'application/json' };

/** The value of a header (its name in any case), the first one; undefined without it. */
export function headerValue(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  return headers.find(([candidate]) => candidate.trim().toLowerCase() === name)?.[1];
}

/** Whether a method sends no body (GET and HEAD cannot). */
export function bodiless(method: string): boolean {
  return ['GET', 'HEAD'].includes(method.toUpperCase());
}

/** The body kind a request has: that of its body's parameters, else of its content type, else a form for a method that sends a body. */
function bodyKindOf(method: string, params: RequestDraft['params'], headers: ReadonlyArray<readonly [string, string]>): BodyKind {
  if (params.some((param) => param.in === 'json')) return 'json';
  if (params.some((param) => param.in === 'form')) return 'form';
  const type = (headerValue(headers, 'content-type') ?? '').toLowerCase();
  if (type.startsWith('application/json') || type.endsWith('+json')) return 'json';
  if (type.startsWith(CONTENT_TYPES.form)) return 'form';
  return bodiless(method) ? 'none' : 'form';
}

/** A request a test sent, to write on: its method, path, parameters and headers. */
export function draftOf(example: Pick<WayRequest, 'method' | 'path' | 'params' | 'headers'>): RequestDraft {
  const params = example.params.map((param) => ({ ...param }));
  const headers = example.headers.map(([name, value]): [string, string] => [name, value]);
  return { method: example.method, path: example.path, body: bodyKindOf(example.method, params, headers), params, headers };
}

/** A request to an endpoint with no parameters yet: a form body for a method that sends one, with its content type. */
export function blankDraft(method: string, path: string): RequestDraft {
  return bodiless(method) ? { method, path, body: 'none', params: [], headers: [] } : { method, path, body: 'form', params: [], headers: [['content-type', CONTENT_TYPES.form]] };
}

/** A member of a JSON body from its text: what the text reads as when it is JSON of no string (a number, true, an array), else the text. */
export function jsonValueOf(text: string): unknown {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'string' ? text : value;
  } catch {
    return text;
  }
}

/** What keeps a request from being sent, in words; undefined when it can be. */
export function draftProblem(draft: RequestDraft): string | undefined {
  if (bodiless(draft.method) && draft.params.some((param) => param.in !== 'query')) return `${draft.method} のリクエストにはボディを付けられません。`;
  const header = draft.headers.find(([name]) => name.trim() !== '' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name.trim()));
  if (header !== undefined) return `ヘッダーの名前「${header[0]}」に使えない文字があります。`;
  return undefined;
}

/**
 * The request the OP of the map runs: the query of the parameters `in:
 * 'query'` on the path, the body of the others (the fields of a form, or the
 * members of a JSON object), and the headers written, but the empty ones and
 * those the runtime sets itself (Host, Content-Length), with the content
 * type of the body when none is written.
 */
export function sandboxRequestOf(draft: RequestDraft): SandboxRequest {
  const named = draft.params.filter((param) => param.name !== '');
  const query = new URLSearchParams(named.filter((param) => param.in === 'query').map((param) => [param.name, param.value])).toString();
  const fields = named.filter((param) => param.in !== 'query');
  const headers = draft.headers.map(([name, value]): [string, string] => [name.trim(), value]).filter(([name]) => name !== '' && !['host', 'content-length'].includes(name.toLowerCase()));
  let body: string | undefined;
  if (draft.body === 'form' && !bodiless(draft.method)) body = new URLSearchParams(fields.map((param) => [param.name, param.value])).toString();
  if (draft.body === 'json' && !bodiless(draft.method)) body = JSON.stringify(Object.fromEntries(fields.map((param) => [param.name, jsonValueOf(param.value)])));
  if (body !== undefined && draft.body !== 'none' && headerValue(headers, 'content-type') === undefined) headers.push(['content-type', CONTENT_TYPES[draft.body]]);
  return { method: draft.method.toUpperCase(), path: `${draft.path}${query === '' ? '' : `?${query}`}`, headers, ...(body === undefined ? {} : { body }) };
}

// ---------------------------------------------------------------------------
// The way it took

/** What the rules read a run with on the page: the trees loaded, the map's places, the lines of the files fetched (by repository path). */
export function runSourcesOf(data: Pick<MapData, 'functions' | 'bodies' | 'sources'>, trees: ReadonlyMap<string, FlowTree>, lines: ReadonlyMap<string, readonly string[]>): RunSources {
  const frames = new FrameLocator(data);
  return {
    treeOf: (id) => trees.get(id),
    pathOf: (file) => data.sources[file]?.path,
    linesOf: (path) => lines.get(path),
    frameAt: (path, line) => frames.frameAt(path, line),
  };
}

/** The frames the trace has open whose trees are loaded, the root first: the key of each and its tree. */
export function openTrees(rootId: string, open: readonly string[], trees: ReadonlyMap<string, FlowTree>): Array<{ key: string; tree: FlowTree }> {
  return [...frameIds(rootId, open, trees)].flatMap(([key, id]) => {
    const tree = trees.get(id);
    return tree === undefined ? [] : [{ key, tree }];
  });
}

/** The files the rules read for some frames: the repository path and the url of the source of each, once. */
export function filesOf(data: Pick<MapData, 'sources'>, trees: ReadonlyArray<{ tree: FlowTree }>): Array<{ path: string; url: string }> {
  const files = new Map<string, string>();
  for (const { tree } of trees) {
    const source = data.sources[tree.file];
    if (source !== undefined) files.set(source.path, source.url);
  }
  return [...files].map(([path, url]) => ({ path, url }));
}

/**
 * The choice a run makes of the frames it is read in: the sides seen at the
 * decisions and calls of each (seenDecisions), keyed by its frame, through
 * the tries whose body has a call that failed (throughTries).
 */
export function observedChoice(ran: Record<string, RanInFile>, frames: ReadonlyArray<{ key: string; tree: FlowTree }>, sources: RunSources): Decisions {
  const run = new RequestRun({ ran }, sources);
  let decisions: Decisions = {};
  for (const { key, tree } of frames) decisions = { ...decisions, ...throughTries(tree, seenDecisions(tree, run, key), key) };
  return decisions;
}

/**
 * The calls a walk fails at without going into them, whose functions have a
 * frame not open yet: the frames to open to follow the failure down to the
 * throw that started it.
 */
export function failingCalls(walked: Pick<FlowWalk, 'stops'>, hasFrame: (id: string) => boolean, open: readonly string[]): string[] {
  const keys: string[] = [];
  for (const stop of walked.stops) {
    const target = stop.node.target;
    if (stop.event !== 'fails' || stop.node.kind !== 'call' || target?.kind !== 'function' || !hasFrame(target.id) || target.id === stop.tree) continue;
    const key = decisionKey(stop.frame, stop.node.id);
    if (!open.includes(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The ready-made way a walk ended by: for a failure, the way of that
 * failure (its target is the throw the walk reached); else the way of the
 * end of the root frame it reached (its return), or for an end no way
 * names, the way into the step it is in (a step that answers itself).
 * Undefined for none.
 */
export function endingWay(selections: readonly Selection[], walked: Pick<FlowWalk, 'stops'>): Selection | undefined {
  const thrown = walked.stops.find((stop) => stop.event === 'throws');
  if (thrown !== undefined) {
    const key = decisionKey(thrown.frame, thrown.node.id);
    return selections.find((selection) => selection.kind === 'failure' && selection.target === key);
  }
  const end = [...walked.stops].reverse().find((stop) => stop.depth === 0 && (stop.event === 'returns' || stop.event === 'ends'));
  if (end === undefined) return undefined;
  const exit = selections.find((selection) => selection.kind === 'exit' && selection.target === end.node.id);
  if (exit !== undefined) return exit;
  // An end no exit names (a step that answers itself): the way into the innermost step it is in.
  const within = (target: string) => end.node.id === target || (end.node.id.startsWith(target) && !/^\d/.test(end.node.id.slice(target.length)));
  const steps = selections.filter((selection) => selection.kind === 'step' && !selection.target.includes('.') && within(selection.target));
  return steps.sort((a, b) => b.target.length - a.target.length)[0];
}

/** A ready-made way in words, as the list of the ways names it: a failure by its error (and the function that throws it below the root), an end by its name. */
export function wayName(selection: Pick<Selection, 'kind' | 'name' | 'frames' | 'failure'>): string {
  const name = selection.name.replace(/`/g, '');
  if (selection.kind === 'failure' && selection.failure !== undefined) return `失敗: ${selection.failure.error}${(selection.frames ?? []).length > 0 ? `（${selection.failure.name} から）` : ''}`;
  return selection.kind === 'exit' ? `終わり方: ${name}` : name;
}

/** The OAuth error a response names: the `error` of its JSON body, or of the query or the fragment of the URL it redirects to. */
export function oauthErrorOf(response: { headers: ReadonlyArray<readonly [string, string]>; body?: string }): string | undefined {
  try {
    const body = JSON.parse(response.body ?? '') as { error?: unknown };
    if (typeof body?.error === 'string') return body.error;
  } catch {
    // Not JSON: the error may be in the URL it redirects to.
  }
  const location = headerValue(response.headers, 'location');
  if (location === undefined) return undefined;
  try {
    const url = new URL(location, 'https://op.invalid');
    return url.searchParams.get('error') ?? new URLSearchParams(url.hash.slice(1)).get('error') ?? undefined;
  } catch {
    return undefined;
  }
}
