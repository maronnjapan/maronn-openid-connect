/**
 * A request the reader writes in the flow view and runs on the live OP
 * (packages/live-op, the map's OP), and the way it took. The page sends the
 * request to the OP (`POST /__live/run`), which records the order of what it
 * ran (an exchange); the replay reads that order against the trees of the
 * frames (map-analysis traced.ts followTrace), opening the handler a root
 * of handlers ran and the frames of the calls that failed, down to the
 * throw. This module writes the request, names the frames to open and the
 * files to read, and says how a request ended; nothing here touches the
 * DOM or fetches.
 */
import { FrameLocator, type RunSources } from '@maronn-openid-connect/map-analysis/observe';
import type { FlowWalk } from '@maronn-openid-connect/map-analysis/walk';
import type { LiveExchange, LiveRequest } from '@maronn-openid-connect/live-op/api';
import type { FlowTree, MapData, RequestParam, Selection } from '../types';
import { decisionKey } from './trace';

/** Where a parameter is sent: the query of the URL, a field of a form body, a member of a JSON body. */
export type ParamPlace = RequestParam['in'];

/** The body a request sends: a form, a JSON object, raw text, or none. */
export type BodyKind = 'form' | 'json' | 'raw' | 'none';

/** A request as the reader writes it: the method and the path of the endpoint, the parameters of its query and its body, its headers. */
export interface RequestDraft {
  method: string;
  /** The path, without the query: the query is the parameters `in: 'query'`. */
  path: string;
  body: BodyKind;
  rawBody?: string;
  params: Array<{ name: string; value: string; in: ParamPlace }>;
  headers: Array<[string, string]>;
}

/** The content type of a body kind. */
const CONTENT_TYPES: Record<'form' | 'json', string> = { form: 'application/x-www-form-urlencoded', json: 'application/json' };

/** The value of a header (its name in any case), the first one; undefined without it. */
export function headerValue(headers: ReadonlyArray<readonly [string, string]>, name: string): string | undefined {
  return headers.find(([candidate]) => candidate.trim().toLowerCase() === name)?.[1];
}

/** Whether a method sends no body (GET and HEAD cannot). */
export function bodiless(method: string): boolean {
  return ['GET', 'HEAD'].includes(method.toUpperCase());
}

/** Read query, form and JSON fields for the editor; preserve any other body as text. */
export function draftOfRequest(request: LiveRequest): RequestDraft {
  const { pathname: path, searchParams } = new URL(request.path, 'https://op.invalid');
  const { method, headers, body } = request;
  const params: RequestDraft['params'] = Array.from(searchParams, ([name, value]) => ({ name, value, in: 'query' }));
  if (body === undefined) return { method, path, body: 'none', params, headers };
  const type = (headerValue(headers, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type === CONTENT_TYPES.form) {
    return { method, path, body: 'form', params: [...params, ...Array.from(new URLSearchParams(body), ([name, value]) => ({ name, value, in: 'form' as const }))], headers };
  }
  if (type === CONTENT_TYPES.json || type?.endsWith('+json')) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const fields = Object.entries(parsed) as [string, unknown][];
        // A string that reads as a JSON number, boolean or object would change type in the field editor.
        if (fields.every(([name, value]) => name !== '' && (typeof value !== 'string' || jsonValueOf(value) === value))) {
          return { method, path, body: 'json', params: [...params, ...fields.map(([name, value]) => ({ name, value: typeof value === 'string' ? value : JSON.stringify(value), in: 'json' as const }))], headers };
        }
      }
    } catch {
      // The case may intentionally send invalid JSON.
    }
  }
  return { method, path, body: 'raw', rawBody: body, params, headers };
}

/** The headers of a request a reader does not write: those the runtime sets itself and those of the connection. */
const RUNTIME_HEADERS: ReadonlySet<string> = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding']);

/**
 * The request an exchange recorded, as a reader would write it to send it
 * again: its method, the path and the query of its URL, its headers (every
 * cookie it carried among them) but those the runtime sets, and its body.
 */
export function requestOfExchange(exchange: Pick<LiveExchange, 'request'>): LiveRequest {
  const { method, url, headers, body } = exchange.request;
  const { pathname, search } = new URL(url, 'https://op.invalid');
  return { method, path: `${pathname}${search}`, headers: headers.filter(([name]) => !RUNTIME_HEADERS.has(name.toLowerCase())).map(([name, value]): [string, string] => [name, value]), ...(body === undefined || bodiless(method) ? {} : { body }) };
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
  if (bodiless(draft.method) && (draft.rawBody !== undefined || draft.params.some((param) => param.in !== 'query'))) return `${draft.method} のリクエストにはボディを付けられません。`;
  const header = draft.headers.find(([name]) => name.trim() !== '' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name.trim()));
  if (header !== undefined) return `ヘッダーの名前「${header[0]}」に使えない文字があります。`;
  return undefined;
}

/**
 * The request the live OP runs: the query of the parameters `in: 'query'`
 * on the path, the body of the others (the fields of a form, or the members
 * of a JSON object), and the headers written, but the empty ones and those
 * the runtime sets itself (Host, Content-Length), with the content type of
 * the body when none is written.
 */
export function liveRequestOf(draft: RequestDraft): LiveRequest {
  const named = draft.params.filter((param) => param.name !== '');
  const query = new URLSearchParams(named.filter((param) => param.in === 'query').map((param) => [param.name, param.value])).toString();
  const fields = named.filter((param) => param.in !== 'query');
  const headers = draft.headers.map(([name, value]): [string, string] => [name.trim(), value]).filter(([name]) => name !== '' && !['host', 'content-length'].includes(name.toLowerCase()));
  let body: string | undefined;
  if (draft.body === 'form' && !bodiless(draft.method)) body = new URLSearchParams(fields.map((param) => [param.name, param.value])).toString();
  if (draft.body === 'json' && !bodiless(draft.method)) body = JSON.stringify(Object.fromEntries(fields.map((param) => [param.name, jsonValueOf(param.value)])));
  if (draft.body === 'raw' && !bodiless(draft.method)) body = draft.rawBody;
  if (body !== undefined && (draft.body === 'form' || draft.body === 'json') && headerValue(headers, 'content-type') === undefined) headers.push(['content-type', CONTENT_TYPES[draft.body]]);
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

/** The files the rules read for some trees: the repository path and the url of the source of each, once. */
export function filesOf(data: Pick<MapData, 'sources'>, trees: Iterable<FlowTree>): Array<{ path: string; url: string }> {
  const files = new Map<string, string>();
  for (const tree of trees) {
    const source = data.sources[tree.file];
    if (source !== undefined) files.set(source.path, source.url);
  }
  return [...files].map(([path, url]) => ({ path, url }));
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
 * The frames a replay opens in the trace: those the reading of the trace
 * opened (the handler a root of handlers ran, the calls that failed whose
 * trees are loaded), and the calls its walk fails at whose trees are not
 * loaded yet (opening them loads them, and the reading goes on down); not
 * those open already, nor those the replay opened before that the reader
 * closed (`closed`).
 */
export function framesToOpen(followed: { open: readonly string[]; walk?: Pick<FlowWalk, 'stops'> | undefined }, open: readonly string[], hasFrame: (id: string) => boolean, closed: ReadonlySet<string>): string[] {
  const wanted = [...followed.open, ...(followed.walk === undefined ? [] : failingCalls(followed.walk, hasFrame, followed.open))];
  return [...new Set(wanted)].filter((key) => !open.includes(key) && !closed.has(key));
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
