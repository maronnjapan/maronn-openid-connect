import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveExchange, LiveRequest, ProbeTable } from '@maronn-openid-connect/live-op/api';
import { followTrace, FrameCatalog, RequestTrace, type WalkMismatch } from '@maronn-openid-connect/map-analysis/traced';
import type { FlowWalk } from '@maronn-openid-connect/map-analysis/walk';
import type { Decisions, FlowTree, MapData, SourceDocument } from '../types';
import { editorFollow, requestKey } from '../lib/preview';
import { draftOfRequest, filesOf, framesToOpen, liveRequestOf, requestOfExchange, runSourcesOf, truncationProblem, type RequestDraft } from '../lib/run';
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
 * A request of the flow view whose exchange the playback follows: the
 * exchange (sent, opened from the list, or a preview of the request the
 * editor shows, which the OP ran on a copy of the workspace's state and did
 * not keep), whether the playback follows the way it took, and the key of
 * the request it stands for (lib/preview.ts requestKey). `quiet`: the flow
 * came to it because the editor's request changed (a preview, or a request
 * sent or opened before that the reader came back to), so the playback
 * keeps its place and does not play on its own. `closing`: the frames the
 * replay before it opened, closed when this one's are known, so the
 * playback does not pass through a state with neither.
 */
export interface RequestRunDone {
  status: 'done';
  id: number;
  exchange: LiveExchange;
  opened: boolean;
  follow: boolean;
  key: string;
  preview?: true;
  quiet?: true;
  closing?: readonly string[];
}

/**
 * A request of the flow view: being sent (or, with `opening`, an exchange
 * recorded being read), the exchange it was recorded as (RequestRunDone),
 * or why it could not be sent or read.
 */
export type RequestRunState =
  | { status: 'running'; id: number; request?: LiveRequest; opening?: string; key?: string }
  | RequestRunDone
  | { status: 'failed'; id: number; message: string; unreachable: boolean };

/** Why the preview of the editor's request could not be run, and whether it is that the OP cannot be reached. */
export interface PreviewProblem {
  message: string;
  unreachable: boolean;
}

/** How the replay of an exchange reads, once read: whether the request ran the root, where the walk disagrees with what ran (none expected), the walk down to the throw, or why it could not be read (or, with the walk, why it may stop short: a trace the OP cut). */
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
  /**
   * Make the playback follow the request the editor shows (lib/preview.ts
   * editorFollow): the exchange it was recorded as when it was sent or
   * opened since, else a preview of it, which sends nothing. Only the
   * latest preview asked for is taken; the playback follows the one before
   * until it comes.
   */
  show: (draft: RequestDraft) => void;
  /** A preview of the editor's request is under way. */
  previewing: boolean;
  /** Why the last preview could not be run; undefined when it could. */
  previewProblem: PreviewProblem | undefined;
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
 *
 * The playback also follows the request the editor shows (`show`): a
 * request written on, or the one prepared for a case, is previewed (the OP
 * runs it on a copy of the workspace's state and keeps nothing, so nothing
 * is sent) and its exchange followed in the same way; one sent or opened
 * since the case or the way was picked is followed again as it was
 * recorded. Only the latest preview asked for is taken, and a run or an
 * opening drops any under way.
 */
export function useRequestRun({ data, root, trees, state, onState, enabled, hasFrame }: RequestRunInput): RequestRun {
  const [runState, setRunState] = useState<RequestRunState | undefined>(undefined);
  const [origin, setOrigin] = useState<RequestRun['origin']>(undefined);
  const [previewing, setPreviewing] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<PreviewProblem | undefined>(undefined);
  // The run as last rendered, for the editor's request asked about between renders.
  const shownRun = useRef(runState);
  shownRun.current = runState;
  // The exchanges sent or opened since the run was last forgotten, by the key of their request: the flow follows one again when the editor comes back to its request.
  const recorded = useRef(new Map<string, Omit<RequestRunDone, 'id' | 'follow'>>());
  // How many times the run was forgotten: a request sent before is not recorded for the case or the way picked after.
  const forgotten = useRef(0);
  // The preview under way (its number and the key of its request), the number of the last one asked for, and whether the last failed for want of the OP.
  const pending = useRef<{ seq: number; key: string } | undefined>(undefined);
  const previews = useRef(0);
  const offline = useRef(false);
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
  // The frames open but those the replay before opened, which this one closes as it opens its own.
  const closing = done?.closing;
  const openBase = useMemo(() => (closing === undefined ? state.open : state.open.filter((key) => !closing.includes(key))), [state.open, closing]);
  const followed = useMemo(
    () => (!following || trace === undefined || root === undefined || sources === undefined ? undefined : followTrace(trace, root, sources, { open: openBase, enabled })),
    [following, trace, root, sources, openBase, enabled],
  );

  useEffect(() => {
    if (done === undefined || !done.follow || followed === undefined) return;
    // A preview is not kept by the workspace: the trace names no exchange for it (a link or a reload could not open it).
    const id = done.preview === true ? undefined : done.exchange.id;
    /** The frames of the replay before are closed: this run stands without them. */
    const closed = () => {
      if (done.closing === undefined) return;
      const { closing: _, ...rest } = done;
      setRunState((current) => (current === done ? rest : current));
    };
    if (!followed.rootRan) {
      // Nothing of the root ran: there is no way to replay, only the exchange to name.
      if (state.exchange !== id || done.closing !== undefined) {
        if (onState({ ...state, open: openBase, exchange: id }, state)) closed();
      }
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
    const open = framesToOpen(followed, openBase, hasFrame, opened);
    if (done.closing === undefined && sameChoice(state.choices[0], followed.decisions) && open.length === 0 && state.exchange === id) {
      applied.current.choice = followed.decisions;
      return;
    }
    if (onState({ ...state, choices: [followed.decisions], open: [...openBase, ...open], exchange: id }, state)) {
      for (const key of open) opened.add(key);
      applied.current.choice = followed.decisions;
      closed();
    }
  }, [done, followed, state, onState, hasFrame, openBase]);

  /** Start a run or an opening: a new id, and the frames the last replay opened closed again, so each replay opens its own; `then` changes the trace besides. */
  const begin = (then?: Partial<TraceState>): number => {
    lastRun.current += 1;
    // With the frames of a replay that a shift left to close, should it not have closed them yet.
    const shown = shownRun.current;
    const opened = new Set([...applied.current.opened, ...(shown?.status === 'done' ? (shown.closing ?? []) : [])]);
    applied.current = { id: 0, choice: undefined, opened: new Set() };
    const { state: current, onState: update } = latest.current;
    const closing = opened.size > 0 && current.open.some((key) => opened.has(key));
    if (closing || then !== undefined) update({ ...current, ...then, open: closing ? current.open.filter((key) => !opened.has(key)) : current.open }, current);
    return lastRun.current;
  };
  /**
   * Follow an exchange the editor's request came to, without a run between
   * (a preview, or a request sent or opened before): a new id, quiet (the
   * playback keeps its place), and the frames the replay before opened
   * closed once this one's are known, in the same change of the trace.
   */
  const shift = (next: Omit<RequestRunDone, 'id' | 'follow' | 'quiet' | 'closing' | 'status'>) => {
    lastRun.current += 1;
    const id = lastRun.current;
    const open = latest.current.state.open;
    const closing = [...applied.current.opened].filter((key) => open.includes(key));
    applied.current = { id: 0, choice: undefined, opened: new Set() };
    setRunState({ ...next, status: 'done', id, follow: true, quiet: true, ...(closing.length === 0 ? {} : { closing }) });
  };
  /** Stop waiting for the preview under way: a run, an opening or another request takes its place. */
  const dropPreview = () => {
    previews.current += 1;
    pending.current = undefined;
    setPreviewing(false);
    setPreviewProblem(undefined);
  };
  /** The run of an id failed: why, and whether it is that the OP cannot be reached. */
  const failed = (id: number, error: unknown) => setRunState((current) => (current?.id === id ? { status: 'failed', id, message: liveProblem(error), unreachable: unreachable(error) } : current));
  const open = (exchangeId: string, then?: Partial<TraceState>) => {
    dropPreview();
    const id = begin(then);
    setRunState({ status: 'running', id, opening: exchangeId });
    liveClient()
      .exchange(exchangeId)
      .then((exchange) => {
        if (lastRun.current !== id) return;
        offline.current = false;
        const draft = draftOfRequest(requestOfExchange(exchange));
        const key = requestKey(draft);
        recorded.current.set(key, { status: 'done', exchange, opened: true, key });
        setOrigin({ key: `x:${exchange.id}`, draft });
        setRunState({ status: 'done', id, exchange, opened: true, follow: true, key });
      }, (error: unknown) => failed(id, error));
  };
  /** Follow the exchange the editor's request stands for (see RequestRun.show). */
  const show = (draft: RequestDraft) => {
    if (offline.current) return;
    const key = requestKey(draft);
    const current = shownRun.current;
    const shown = current?.status === 'done' ? { key: current.key, follow: current.follow } : current?.status === 'running' && current.key !== undefined ? { key: current.key, follow: true } : undefined;
    const step = editorFollow(key, { pending: pending.current?.key, shown, recorded: recorded.current });
    if (step === 'wait') return;
    dropPreview();
    if (step === 'stay') return;
    if (step === 'resume') {
      if (current?.status === 'done') {
        applied.current = { id: current.id, choice: undefined, opened: applied.current.opened };
        setRunState({ ...current, follow: true });
      }
      return;
    }
    const again = step === 'recorded' ? recorded.current.get(key) : undefined;
    if (again !== undefined) {
      shift(again);
      return;
    }
    const seq = previews.current;
    pending.current = { seq, key };
    setPreviewing(true);
    liveClient()
      .preview(liveRequestOf(draft))
      .then(
        (exchange) => {
          if (previews.current !== seq) return;
          pending.current = undefined;
          offline.current = false;
          setPreviewing(false);
          shift({ exchange, opened: false, preview: true, key });
        },
        (error: unknown) => {
          if (previews.current !== seq) return;
          pending.current = undefined;
          // An OP the page cannot reach is said once: no preview is asked again until a request reaches it.
          if (unreachable(error)) offline.current = true;
          setPreviewing(false);
          setPreviewProblem({ message: liveProblem(error), unreachable: unreachable(error) });
        },
      );
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

  // A trace the OP cut is read as far as it goes: the replay says it may stop short.
  const cut = exchange === undefined ? undefined : truncationProblem(exchange);
  const replay: Replay | undefined =
    !following ? undefined
    : table?.hash === hash && table?.problem !== undefined ? { rootRan: true, mismatches: [], walk: undefined, problem: table.problem }
    : followed === undefined ? undefined
    : { rootRan: followed.rootRan, mismatches: followed.mismatches, walk: followed.walk, ...(cut === undefined ? {} : { problem: cut }) };

  return {
    state: runState,
    origin,
    replay,
    previewing,
    previewProblem,
    run: (draft) => {
      dropPreview();
      const request = liveRequestOf(draft);
      const key = requestKey(draft);
      const id = begin();
      const era = forgotten.current;
      setRunState({ status: 'running', id, request, key });
      liveClient()
        .run(request)
        .then((exchange) => {
          offline.current = false;
          if (forgotten.current === era) recorded.current.set(key, { status: 'done', exchange, opened: false, key });
          setRunState((current) => (current?.id === id ? { status: 'done', id, exchange, opened: false, follow: true, key } : current));
          notifyLiveChanged();
        }, (error: unknown) => failed(id, error));
    },
    open,
    show,
    follow: () => {
      if (done === undefined) return;
      applied.current = { id: done.id, choice: undefined, opened: applied.current.opened };
      setRunState({ ...done, follow: true });
    },
    forget: () => {
      lastRun.current += 1;
      forgotten.current += 1;
      dropPreview();
      recorded.current.clear();
      offline.current = false;
      setRunState(undefined);
      setOrigin(undefined);
    },
  };
}
