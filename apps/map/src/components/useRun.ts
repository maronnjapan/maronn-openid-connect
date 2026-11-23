import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowWalk } from '@maronn-openid-connect/map-analysis/walk';
import type { SandboxRequest, SandboxRun } from '@maronn-openid-connect/map-sandbox';
import type { Decisions, FlowTree, MapData, SourceDocument } from '../types';
import { walkTrace } from '../lib/playback';
import { failingCalls, filesOf, observedChoice, openTrees, runSourcesOf, sandboxRequestOf, type RequestDraft } from '../lib/run';
import type { TraceState } from '../lib/trace';
import type { SandboxAnswer, SandboxAsk } from '../sandbox-worker';

// ---------------------------------------------------------------------------
// The worker

/** The worker the OP of the map runs in: made when the first request is run, kept for the page. */
let worker: Worker | undefined;
/** The requests sent to the worker and not answered yet, by id. */
const waiting = new Map<number, { resolve: (run: SandboxRun) => void; reject: (error: Error) => void }>();
let lastId = 0;

/** The worker, made on first use; a worker that failed to load is dropped, its requests failed, so the next request makes another. */
function sandboxWorker(): Worker {
  if (worker !== undefined) return worker;
  const made = new Worker(new URL('../sandbox-worker.ts', import.meta.url), { type: 'module', name: 'map-sandbox' });
  made.addEventListener('message', (event: MessageEvent<SandboxAnswer>) => {
    const answer = event.data;
    const pending = waiting.get(answer.id);
    waiting.delete(answer.id);
    if ('run' in answer) pending?.resolve(answer.run);
    else pending?.reject(new Error(answer.error));
  });
  made.addEventListener('error', (event) => {
    for (const pending of waiting.values()) pending.reject(new Error(event.message || '地図の OP を読み込めませんでした'));
    waiting.clear();
    made.terminate();
    if (worker === made) worker = undefined;
  });
  worker = made;
  return made;
}

/** Run a request on the OP of the map, in its worker. */
export function runInSandbox(request: SandboxRequest): Promise<SandboxRun> {
  return new Promise((resolve, reject) => {
    lastId += 1;
    const ask: SandboxAsk = { id: lastId, request };
    waiting.set(ask.id, { resolve, reject });
    sandboxWorker().postMessage(ask);
  });
}

// ---------------------------------------------------------------------------
// The lines of the sources

/** The lines of the source files fetched so far, by url (a file never changes for its url). */
const lineCache = new Map<string, Promise<string[]>>();

/** Fetch the lines of a source file once. */
function fetchLines(url: string): Promise<string[]> {
  let pending = lineCache.get(url);
  if (pending === undefined) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const document = (await response.json()) as SourceDocument;
      return document.code.split('\n');
    });
    pending.catch(() => lineCache.delete(url));
    lineCache.set(url, pending);
  }
  return pending;
}

/** The lines of some source files (repository path and url), once all of them are read; undefined until then, and for one that could not be read. */
function useLines(files: ReadonlyArray<{ path: string; url: string }>): ReadonlyMap<string, readonly string[]> | undefined {
  const key = files.map((file) => `${file.path}\t${file.url}`).join('\n');
  const [loaded, setLoaded] = useState<{ key: string; lines: Map<string, string[]> } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const wanted = key === '' ? [] : key.split('\n').map((line) => line.split('\t') as [string, string]);
    Promise.all(wanted.map(async ([path, url]) => [path, await fetchLines(url)] as const))
      .then((entries) => {
        if (live) setLoaded({ key, lines: new Map(entries) });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key]);
  return loaded?.key === key ? loaded.lines : undefined;
}

// ---------------------------------------------------------------------------
// The run of the flow view

/** A request the reader ran in the flow view: running, what it gave (and whether the playback follows the way it took), or why it could not be run. */
export type RequestRunState =
  | { status: 'running'; id: number; request: SandboxRequest }
  | { status: 'done'; id: number; request: SandboxRequest; run: SandboxRun; follow: boolean }
  | { status: 'failed'; id: number; request?: SandboxRequest; message: string };

/** What the run of the flow view reads besides the request (see useRequestRun). */
export interface RequestRunInput {
  data: MapData;
  rootId: string;
  root: FlowTree | undefined;
  /** The trees of the frames loaded so far, by id. */
  trees: ReadonlyMap<string, FlowTree>;
  state: TraceState;
  onState: (next: TraceState) => void;
  enabled: ReadonlySet<string>;
  hasFrame: (id: string) => boolean;
}

/** The run of the flow view and what the reader does with it (see useRequestRun). */
export interface RequestRun {
  state: RequestRunState | undefined;
  /** Run a request the reader wrote. */
  run: (draft: RequestDraft) => void;
  /** Follow the way the request took again, after the reader took other sides. */
  follow: () => void;
  /** Forget the request run: another way was picked. */
  forget: () => void;
  /** The walk of the way it took, once the frames it is read in are loaded and read. */
  walked: FlowWalk | undefined;
}

/** Whether two choices choose the same sides. */
function sameChoice(a: Decisions | undefined, b: Decisions | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * The request the reader runs in the flow view and the way it took: the
 * request runs on the OP of the map in its worker, and while the playback
 * follows it, the sides the run was seen to take in the frames the trace has
 * open are the trace's choice (lib/run.ts observedChoice). A call the run
 * failed at opens its frame, down to the throw that started the failure,
 * each frame once (one the reader closes stays closed). Taking another side
 * or another way leaves the way of the run; `follow` takes it again.
 */
export function useRequestRun({ data, rootId, root, trees, state, onState, enabled, hasFrame }: RequestRunInput): RequestRun {
  const [runState, setRunState] = useState<RequestRunState | undefined>(undefined);
  // The choice the run last gave the trace, and the frames it opened, for the run it was given for.
  const applied = useRef<{ id: number; choice: Decisions | undefined; opened: Set<string> }>({ id: 0, choice: undefined, opened: new Set() });
  const done = runState?.status === 'done' ? runState : undefined;
  const following = done !== undefined && done.follow;
  const frames = useMemo(() => (following ? openTrees(rootId, state.open, trees) : []), [following, rootId, state.open, trees]);
  const files = useMemo(() => filesOf(data, frames), [data, frames]);
  const lines = useLines(files);
  const choice = useMemo(() => (done === undefined || !following || lines === undefined ? undefined : observedChoice(done.run.ran, frames, runSourcesOf(data, trees, lines))), [done, following, lines, frames, data, trees]);
  const walked = useMemo(() => (choice === undefined || root === undefined ? undefined : walkTrace(root, choice, { open: state.open, trees, enabled })), [choice, root, state.open, trees, enabled]);

  useEffect(() => {
    if (done === undefined || !done.follow || choice === undefined || walked === undefined) return;
    const last = applied.current;
    if (last.id === done.id && last.choice !== undefined && !sameChoice(state.choices[0], last.choice)) {
      // The reader took other sides (or another way): the playback no longer follows the run.
      setRunState({ ...done, follow: false });
      return;
    }
    if (last.id !== done.id) applied.current = { id: done.id, choice: undefined, opened: new Set() };
    const opened = applied.current.opened;
    const open = failingCalls(walked, hasFrame, state.open).filter((key) => !opened.has(key));
    if (sameChoice(state.choices[0], choice) && open.length === 0) {
      applied.current.choice = choice;
      return;
    }
    for (const key of open) opened.add(key);
    applied.current.choice = choice;
    onState({ ...state, choices: [choice], open: [...state.open, ...open] });
  }, [done, choice, walked, state, onState, hasFrame]);

  return {
    state: runState,
    walked: following ? walked : undefined,
    run: (draft) => {
      const request = sandboxRequestOf(draft);
      const id = (runState?.id ?? 0) + 1;
      setRunState({ status: 'running', id, request });
      runInSandbox(request).then(
        (run) => setRunState((current) => (current?.id === id ? { status: 'done', id, request, run, follow: true } : current)),
        (error: unknown) => setRunState((current) => (current?.id === id ? { status: 'failed', id, request, message: error instanceof Error ? error.message : String(error) } : current)),
      );
    },
    follow: () => {
      if (done === undefined) return;
      applied.current = { id: done.id, choice: undefined, opened: applied.current.opened };
      setRunState({ ...done, follow: true });
    },
    forget: () => setRunState(undefined),
  };
}
