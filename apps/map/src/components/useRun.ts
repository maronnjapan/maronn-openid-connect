import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveExchange, LiveRequest, ProbeTable } from '@maronn-openid-connect/live-op/api';
import { followTrace, FrameCatalog, RequestTrace, type WalkMismatch } from '@maronn-openid-connect/map-analysis/traced';
import type { FlowWalk } from '@maronn-openid-connect/map-analysis/walk';
import type { Decisions, FlowTree, MapData, SourceDocument } from '../types';
import { draftOfRequest, filesOf, framesToOpen, liveRequestOf, requestOfExchange, runSourcesOf, type RequestDraft } from '../lib/run';
import type { TraceState, TraceUpdate } from '../lib/trace';
import { liveClient, liveProblem, notifyLiveChanged, probeTableOf, unreachable } from './useLive';

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

/** The lines of some source files (repository path and url), once all of them are read or failed; undefined until then. A file that could not be read is left out: its decisions are not read, and the walk takes them on an assumed side. */
function useLines(files: ReadonlyArray<{ path: string; url: string }>): ReadonlyMap<string, readonly string[]> | undefined {
  const key = files.map((file) => `${file.path}\t${file.url}`).join('\n');
  const [loaded, setLoaded] = useState<{ key: string; lines: Map<string, string[]> } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const wanted = key === '' ? [] : key.split('\n').map((line) => line.split('\t') as [string, string]);
    void Promise.allSettled(wanted.map(async ([path, url]) => [path, await fetchLines(url)] as const)).then((settled) => {
      const entries = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      if (live) setLoaded({ key, lines: new Map(entries) });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return loaded?.key === key ? loaded.lines : undefined;
}

// ---------------------------------------------------------------------------
// The run of the flow view

/**
 * A request of the flow view: being sent (or, with `opening`, an exchange
 * recorded being read), the exchange it was recorded as (whether the reader
 * opened it from the list instead of sending it, and whether the playback
 * follows the way it took), or why it could not be sent or read.
 */
export type RequestRunState =
  | { status: 'running'; id: number; request?: LiveRequest; opening?: string }
  | { status: 'done'; id: number; exchange: LiveExchange; opened: boolean; follow: boolean }
  | { status: 'failed'; id: number; message: string; unreachable: boolean };

/** How the replay of an exchange reads, once read: whether the request ran the root, where the walk disagrees with what ran (none expected), the walk down to the throw, or why it could not be read. */
export interface Replay {
  rootRan: boolean;
  mismatches: readonly WalkMismatch[];
  walk: FlowWalk | undefined;
  problem?: string;
}

/** What the run of the flow view reads besides the request (see useRequestRun). */
export interface RequestRunInput {
  data: MapData;
  root: FlowTree | undefined;
  /** The trees of the frames loaded so far, by id. */
  trees: ReadonlyMap<string, FlowTree>;
  state: TraceState;
  onState: TraceUpdate;
  enabled: ReadonlySet<string>;
  hasFrame: (id: string) => boolean;
}

/** The run of the flow view and what the reader does with it (see useRequestRun). */
export interface RequestRun {
  state: RequestRunState | undefined;
  /** Send a request the reader wrote to the live OP. */
  run: (draft: RequestDraft) => void;
  /** Open an exchange the workspace recorded (by its id), without sending anything: its request to write on, the way it took to replay; `then` changes the trace besides (the flow view shown). */
  open: (exchange: string, then?: Partial<TraceState>) => void;
  /** Follow the way the request took again, after the reader took other sides. */
  follow: () => void;
  /** Forget the request run and the exchange opened: another way or case was picked. */
  forget: () => void;
  /** The request of the exchange the reader opened, to write on: kept until the run is forgotten. */
  origin: { key: string; draft: RequestDraft } | undefined;
  /** The replay of the exchange while the playback follows it, once read. */
  replay: Replay | undefined;
}

/** Whether two choices choose the same sides. */
function sameChoice(a: Decisions | undefined, b: Decisions | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * The request the reader runs in the flow view on the live OP, or an
 * exchange of the workspace the reader opens, and the way it took: the OP
 * records the order of what the request ran, and while the playback
 * follows it, the reading of that order through the trees (map-analysis
 * traced.ts followTrace) is the trace's choice. The handler a root of
 * handlers ran opens, and so do the frames of the calls that failed, down
 * to the throw; the frames the reader opened are read too. A frame the
 * replay opened and the reader closed stays closed. Taking another side or
 * another way leaves the way of the request; `follow` takes it again. The
 * exchange followed is kept in the trace (TraceState.exchange), and one the
 * trace names that is not the one shown (a link, a reload) is opened.
 */
export function useRequestRun({ data, root, trees, state, onState, enabled, hasFrame }: RequestRunInput): RequestRun {
  const [runState, setRunState] = useState<RequestRunState | undefined>(undefined);
  const [origin, setOrigin] = useState<RequestRun['origin']>(undefined);
  // The id of the last run: never given again, so a run after one forgotten is not taken for it.
  const lastRun = useRef(0);
  // The choice the run last gave the trace, and the frames it opened, for the run it was given for.
  const applied = useRef<{ id: number; choice: Decisions | undefined; opened: Set<string> }>({ id: 0, choice: undefined, opened: new Set() });
  const latest = useRef({ state, onState });
  latest.current = { state, onState };
  const done = runState?.status === 'done' ? runState : undefined;
  const following = done !== undefined && done.follow;

  // The probe table the trace of the exchange indexes, fetched once per hash.
  const hash = done?.exchange.trace.probes;
  const [table, setTable] = useState<{ hash: string; table?: ProbeTable; problem?: string } | undefined>(undefined);
  useEffect(() => {
    if (hash === undefined) return undefined;
    let live = true;
    probeTableOf(hash).then(
      (loaded) => {
        if (live) setTable({ hash, table: loaded });
      },
      (error: unknown) => {
        if (live) setTable({ hash, problem: liveProblem(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [hash]);
  const catalog = useMemo(() => new FrameCatalog(data), [data]);
  const exchange = done?.exchange;
  const probes = table?.hash === hash ? table?.table : undefined;
  const trace = useMemo(() => (exchange === undefined || probes === undefined ? undefined : new RequestTrace(exchange.trace, probes, catalog)), [exchange, probes, catalog]);
  const files = useMemo(() => (following ? filesOf(data, trees.values()) : []), [following, data, trees]);
  const lines = useLines(files);
  const sources = useMemo(() => (lines === undefined ? undefined : runSourcesOf(data, trees, lines)), [data, trees, lines]);
  const followed = useMemo(
    () => (!following || trace === undefined || root === undefined || sources === undefined ? undefined : followTrace(trace, root, sources, { open: state.open, enabled })),
    [following, trace, root, sources, state.open, enabled],
  );

  useEffect(() => {
    if (done === undefined || !done.follow || followed === undefined) return;
    const id = done.exchange.id;
    if (!followed.rootRan) {
      // Nothing of the root ran: there is no way to replay, only the exchange to name.
      if (state.exchange !== id) onState({ ...state, exchange: id }, state);
      return;
    }
    const last = applied.current;
    if (last.id === done.id && last.choice !== undefined && !sameChoice(state.choices[0], last.choice)) {
      // The reader took other sides (or another way): the playback no longer follows the request.
      setRunState((current) => (current === done ? { ...done, follow: false } : current));
      return;
    }
    if (last.id !== done.id) applied.current = { id: done.id, choice: undefined, opened: new Set() };
    const opened = applied.current.opened;
    const open = framesToOpen(followed, state.open, hasFrame, opened);
    if (sameChoice(state.choices[0], followed.decisions) && open.length === 0 && state.exchange === id) {
      applied.current.choice = followed.decisions;
      return;
    }
    if (onState({ ...state, choices: [followed.decisions], open: [...state.open, ...open], exchange: id }, state)) {
      for (const key of open) opened.add(key);
      applied.current.choice = followed.decisions;
    }
  }, [done, followed, state, onState, hasFrame]);

  /** Start a run or an opening: a new id, and the frames the last replay opened closed again, so each replay opens its own; `then` changes the trace besides. */
  const begin = (then?: Partial<TraceState>): number => {
    lastRun.current += 1;
    const opened = applied.current.opened;
    applied.current = { id: 0, choice: undefined, opened: new Set() };
    const { state: current, onState: update } = latest.current;
    const closing = opened.size > 0 && current.open.some((key) => opened.has(key));
    if (closing || then !== undefined) update({ ...current, ...then, open: closing ? current.open.filter((key) => !opened.has(key)) : current.open }, current);
    return lastRun.current;
  };
  /** The run of an id failed: why, and whether it is that the OP cannot be reached. */
  const failed = (id: number, error: unknown) => setRunState((current) => (current?.id === id ? { status: 'failed', id, message: liveProblem(error), unreachable: unreachable(error) } : current));
  const open = (exchangeId: string, then?: Partial<TraceState>) => {
    const id = begin(then);
    setRunState({ status: 'running', id, opening: exchangeId });
    liveClient()
      .exchange(exchangeId)
      .then((recorded) => {
        if (lastRun.current !== id) return;
        setOrigin({ key: `x:${recorded.id}`, draft: draftOfRequest(requestOfExchange(recorded)) });
        setRunState({ status: 'done', id, exchange: recorded, opened: true, follow: true });
      }, (error: unknown) => failed(id, error));
  };

  // An exchange the trace names (a link, a reload, back and forward) that is not the one shown is opened, once.
  const named = useRef<string | undefined>(undefined);
  useEffect(() => {
    const wanted = state.exchange;
    if (wanted === undefined) named.current = undefined;
    if (wanted === undefined || wanted === named.current) return;
    named.current = wanted;
    if (runState?.status === 'running' || (runState?.status === 'done' && runState.exchange.id === wanted)) return;
    open(wanted);
  });

  const replay: Replay | undefined =
    !following ? undefined
    : table?.hash === hash && table?.problem !== undefined ? { rootRan: true, mismatches: [], walk: undefined, problem: table.problem }
    : followed === undefined ? undefined
    : { rootRan: followed.rootRan, mismatches: followed.mismatches, walk: followed.walk };

  return {
    state: runState,
    origin,
    replay,
    run: (draft) => {
      const request = liveRequestOf(draft);
      const id = begin();
      setRunState({ status: 'running', id, request });
      liveClient()
        .run(request)
        .then((recorded) => {
          setRunState((current) => (current?.id === id ? { status: 'done', id, exchange: recorded, opened: false, follow: true } : current));
          notifyLiveChanged();
        }, (error: unknown) => failed(id, error));
    },
    open,
    follow: () => {
      if (done === undefined) return;
      applied.current = { id: done.id, choice: undefined, opened: applied.current.opened };
      setRunState({ ...done, follow: true });
    },
    forget: () => {
      lastRun.current += 1;
      setRunState(undefined);
      setOrigin(undefined);
    },
  };
}
