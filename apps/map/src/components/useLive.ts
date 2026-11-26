import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ExchangeSummary, LiveState, ProbeTable } from '@maronn-openid-connect/live-op/api';
import { LiveOpClient, LiveOpError, readerWorkspace } from '@maronn-openid-connect/live-op/client';

/**
 * The page's side of the live OP (packages/live-op, the map's OP): the
 * client of the reader's workspace, the probe tables the traces index, the
 * state of the workspace and the list of its exchanges, each shared by the
 * views of the page and fetched again when something the page did changed
 * the workspace (a run, a case prepared, a grant, the clock moved on).
 */

/** The client of the reader's workspace, made once for the page; making it also sets the workspace cookie, so a tab the reader opens on the OP reaches the same workspace. */
let client: LiveOpClient | undefined;

/** The client of the reader's workspace (see client). */
export function liveClient(): LiveOpClient {
  client ??= new LiveOpClient(readerWorkspace());
  return client;
}

/**
 * Whether a failure of the control API means the page cannot reach the OP:
 * no answer, no OP at the page's origin (a 404 that is no answer of the
 * OP's), or an answer that is no JSON (a host that serves the page for
 * every path).
 */
export function unreachable(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  return error instanceof LiveOpError && (error.status === 0 || (error.status === 404 && error.message !== 'not_found'));
}

/** A failure of the live OP in words: for one that cannot reach it, what is wrong and where the OP runs; else what the OP said. */
export function liveProblem(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error);
  if (unreachable(error)) return `地図の OP に接続できません。このページの配信元で地図の OP が動いていません（ローカルは pnpm --filter @maronn-openid-connect/map dev か preview、Cloudflare は地図の Worker が OP を動かします）。${said}`;
  return said;
}

// ---------------------------------------------------------------------------
// The probe tables

/** The probe tables fetched, by the hash the traces name them by. */
const tables = new Map<string, Promise<ProbeTable>>();

/**
 * The probe table of a hash (TraceEvents.probes): the OP's, fetched once. An
 * exchange recorded by another build of the OP than the one answering now
 * names a table the OP no longer has, which is said.
 */
export function probeTableOf(hash: string): Promise<ProbeTable> {
  const known = tables.get(hash);
  if (known !== undefined) return known;
  const pending = liveClient()
    .probes()
    .then((table) => {
      tables.set(table.hash, Promise.resolve(table));
      if (table.hash !== hash) throw new Error(`この交換を記録した OP（プローブの表 ${hash}）は、いま動いている地図の OP（${table.hash}）とは別のビルドなので、道筋を読めません。`);
      return table;
    });
  tables.set(hash, pending);
  pending.catch(() => {
    if (tables.get(hash) === pending) tables.delete(hash);
  });
  return pending;
}

// ---------------------------------------------------------------------------
// Changes of the workspace

/** How many times the page changed the workspace: the views that show it fetch it again when it does. */
let changes = 0;
const changeListeners = new Set<() => void>();

/** Say the page changed the workspace (it sent a request, prepared a case, made a grant, moved the clock on, made it again). */
export function notifyLiveChanged(): void {
  changes += 1;
  for (const listener of changeListeners) listener();
}

/** Listen to the page changing the workspace. */
function subscribeChanges(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** How many times the page changed the workspace, as state. */
function useLiveChanges(): number {
  return useSyncExternalStore(subscribeChanges, () => changes);
}

// ---------------------------------------------------------------------------
// The state of the workspace

/** What the page has of the workspace's state: loading, the state, or why it could not be read. */
export type LiveStateStatus = { kind: 'loading' } | { kind: 'ready'; state: LiveState } | { kind: 'failed'; message: string; unreachable: boolean };

let stateStatus: LiveStateStatus = { kind: 'loading' };
/** The changes the state was last fetched for, and the fetch under way. */
let stateFor = -1;
let stateFetch: Promise<void> | undefined;
const stateListeners = new Set<() => void>();

/** Show a state of the workspace to every view. */
function setStateStatus(next: LiveStateStatus): void {
  stateStatus = next;
  for (const listener of stateListeners) listener();
}

/** Take the state the OP gave for something the page did (a clock moved on, a workspace made again) as the state of the workspace. */
export function takeLiveState(state: LiveState): void {
  stateFor = changes;
  setStateStatus({ kind: 'ready', state });
}

/** Fetch the state of the workspace again, once for the changes so far (a fetch under way serves those it started for). */
export function refreshLiveState(force = false): Promise<void> {
  if (!force && stateFor === changes && stateStatus.kind !== 'failed') return stateFetch ?? Promise.resolve();
  const wanted = changes;
  stateFor = wanted;
  const pending = liveClient()
    .state()
    .then(
      (state) => {
        if (stateFor === wanted) setStateStatus({ kind: 'ready', state });
      },
      (error: unknown) => {
        if (stateFor === wanted) setStateStatus({ kind: 'failed', message: liveProblem(error), unreachable: unreachable(error) });
      },
    );
  stateFetch = pending;
  return pending;
}

/** Listen to the state of the workspace. */
function subscribeState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** The state of the reader's workspace, fetched when a view first needs it and again whenever the page changed the workspace. */
export function useLiveState(): LiveStateStatus {
  const status = useSyncExternalStore(subscribeState, () => stateStatus);
  const changed = useLiveChanges();
  useEffect(() => {
    void refreshLiveState();
  }, [changed]);
  return status;
}

// ---------------------------------------------------------------------------
// The exchanges of the workspace

/** How often the list of the exchanges is fetched again while it shows (milliseconds). */
const EXCHANGES_EVERY = 5000;

/** What the page has of the exchanges of the workspace: the list (oldest first) once read, why it could not be, and whether a fetch is under way. */
export interface ExchangesStatus {
  list: ExchangeSummary[] | undefined;
  problem: string | undefined;
  fetching: boolean;
  /** Fetch the list again now. */
  refresh: () => void;
}

/**
 * The exchanges of the reader's workspace: fetched while `active` (the
 * list shows) every few seconds while the page is visible, and at once
 * when the page changed the workspace, so requests a browser tab or a
 * client sends to the OP show up as they come.
 */
export function useExchanges(active: boolean): ExchangesStatus {
  const [list, setList] = useState<ExchangeSummary[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [fetching, setFetching] = useState(false);
  const [asked, setAsked] = useState(0);
  const changed = useLiveChanges();
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    let busy = false;
    let timer: number | undefined;
    const fetchList = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        timer = window.setTimeout(fetchList, EXCHANGES_EVERY);
        return;
      }
      busy = true;
      setFetching(true);
      liveClient()
        .exchanges()
        .then(
          (summaries) => {
            if (!live) return;
            setList(summaries);
            setProblem(undefined);
          },
          (error: unknown) => {
            if (live) setProblem(liveProblem(error));
          },
        )
        .finally(() => {
          busy = false;
          if (!live) return;
          setFetching(false);
          timer = window.setTimeout(fetchList, EXCHANGES_EVERY);
        });
    };
    fetchList();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || busy) return;
      window.clearTimeout(timer);
      fetchList();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, changed, asked]);
  return { list, problem, fetching, refresh: () => setAsked((count) => count + 1) };
}
