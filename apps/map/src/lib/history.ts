/**
 * The history of main (HistoryData, written by packages/map-analysis
 * history.ts) as the page reads it: the key of a change in the URL
 * (`pr-207`, or the commit of a push without a pull request), the changes
 * the reader filters for, the changes that touched a function, the
 * endpoints a change reaches in the map as it is now, and the links to
 * GitHub. Nothing here touches the DOM.
 */
import type { FlowEndpoint, HistoryData, HistoryEntry, MapData, OpFlow } from '../types';
import { namesPull } from '@maronn-openid-connect/map-analysis/history-brief';
import { endpointsInModule, endpointsUsing } from './model';

// The keys of the changes (keyOf opens the change it is for, when two share a pull request number) and the words of a diff left out are the ones the history command gives an AI.
export { entryKey, entryOf, keyOf, namesPull, omittedWords, sharingNumber } from '@maronn-openid-connect/map-analysis/history-brief';

/** Whether a change reached main without a pull request of its own: a commit pushed to it, or a merge made and pushed by hand. */
export function withoutPullRequest(entry: HistoryEntry): boolean {
  return entry.pr === undefined;
}

/** What the reader narrows the list to. */
export interface HistoryFilter {
  /** Words of the title, the branch, a function, a file or the number (`#207`). */
  query: string;
  /** Only the changes that added, changed or removed a function of the catalog. */
  code: boolean;
  /** Only the changes that reached main without a pull request of their own (withoutPullRequest). */
  direct: boolean;
}

/** The changes that pass the filter, newest first (as the history holds them). */
export function filterEntries(history: HistoryData, filter: HistoryFilter): HistoryEntry[] {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  return history.entries.filter((entry) => {
    if (filter.code && entry.functions.length === 0) return false;
    if (filter.direct && !withoutPullRequest(entry)) return false;
    if (words.length === 0) return true;
    const carried = (entry.carried ?? []).flatMap((pull) => [`#${pull.pr}`, pull.title]);
    const text = [entry.title, entry.branch ?? '', entry.pr === undefined ? '' : `#${entry.pr}`, entry.commit.slice(0, 10), ...carried, ...entry.authors, ...entry.functions.map((change) => change.name), ...entry.notes, ...entry.commits.map((commit) => commit.subject)].join('\n').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** How many functions a change added, changed and removed. */
export function functionCounts(entry: HistoryEntry): { added: number; modified: number; removed: number } {
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const change of entry.functions) counts[change.status] += 1;
  return counts;
}

/** The changes that touched a function, newest first, with what each did to it. */
export function changesOf(history: HistoryData, id: string): Array<{ entry: HistoryEntry; status: HistoryEntry['functions'][number]['status'] }> {
  return (history.functions[id] ?? []).flatMap((index) => {
    const entry = history.entries[index];
    const change = entry?.functions.find((candidate) => candidate.id === id);
    return entry === undefined || change === undefined ? [] : [{ entry, status: change.status }];
  });
}

/** How many calls up from a changed function the history looks for the root of an endpoint (as endpointsUsing looks for its steps). */
const REACH_DEPTH = 8;

/**
 * The endpoints of a framework that the functions a change touched reach in
 * the map as it is now (a function since removed reaches none), as the page
 * of a function counts them: the trace of the endpoint starts from one or
 * from a function or endpoint body that calls it (down to a few calls), one
 * of its steps calls one, or its own file (route.ts, pipeline.ts) holds one.
 */
export function endpointsReached(data: MapData, flow: OpFlow | undefined, entry: HistoryEntry): FlowEndpoint[] {
  if (flow === undefined) return [];
  const found = new Set<string>();
  // The functions and the endpoint bodies that call a changed function, up to REACH_DEPTH calls.
  const callers = new Set<string>();
  let frontier = entry.functions.map((change) => change.id).filter((id) => data.functions[id] !== undefined);
  for (const id of frontier) callers.add(id);
  for (let depth = 0; depth < REACH_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const caller of data.functions[id]?.calledBy ?? []) {
        if (callers.has(caller)) continue;
        callers.add(caller);
        if (data.functions[caller] !== undefined) next.push(caller);
      }
    }
    frontier = next;
  }
  for (const endpoint of flow.endpoints) if (callers.has(endpoint.root)) found.add(endpoint.id);
  for (const change of entry.functions) {
    const card = data.functions[change.id];
    if (card === undefined) continue;
    for (const endpoint of endpointsInModule(flow, card)) found.add(endpoint.id);
    for (const use of endpointsUsing(data, flow, change.id)) found.add(use.endpoint.id);
  }
  return flow.endpoints.filter((endpoint) => found.has(endpoint.id));
}

/** The page of a change on GitHub: its pull request when its number names it there (namesPull: GitHub confirmed it, or no other change has the number), else its commit; undefined when the repository is not known. */
export function changeUrl(history: HistoryData, entry: HistoryEntry): string | undefined {
  if (history.repository === undefined) return undefined;
  return namesPull(history, entry) ? `https://github.com/${history.repository}/pull/${entry.pr}` : `https://github.com/${history.repository}/commit/${entry.commit}`;
}

/** The page of a commit, or of a file as a commit left it, on GitHub. */
export function commitUrl(history: HistoryData, commit: string, path?: string): string | undefined {
  if (history.repository === undefined) return undefined;
  return path === undefined ? `https://github.com/${history.repository}/commit/${commit}` : `https://github.com/${history.repository}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The date of a change as the page writes it (`2026-11-21`), in the time zone the change was made in. */
export function dayOf(date: string): string {
  return date.slice(0, 10);
}
