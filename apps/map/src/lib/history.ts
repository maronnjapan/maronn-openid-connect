/**
 * The history of main (HistoryData, written by packages/map-analysis
 * history.ts) as the page reads it: the key of a change in the URL
 * (`pr-207`, or the commit of a push without a pull request), the changes
 * the reader filters for, the changes that touched a function, the
 * endpoints a change reaches in the map as it is now, and the links to
 * GitHub. Nothing here touches the DOM.
 */
import type { FlowEndpoint, HistoryData, HistoryEntry, MapData, OpFlow } from '../types';
import { endpointsRootedAt, endpointsUsing } from './model';

/** The key of a change in the URL: `pr-<number>` for a pull request, else the first ten characters of its commit. */
export function entryKey(entry: HistoryEntry): string {
  return entry.pr === undefined ? entry.commit.slice(0, 10) : `pr-${entry.pr}`;
}

/** The change a key names; a commit key matches the start of the commit. */
export function entryOf(history: HistoryData, key: string): HistoryEntry | undefined {
  return history.entries.find((entry) => entryKey(entry) === key) ?? (/^[0-9a-f]{7,}$/.test(key) ? history.entries.find((entry) => entry.commit.startsWith(key)) : undefined);
}

/** What the reader narrows the list to. */
export interface HistoryFilter {
  /** Words of the title, the branch, a function, a file or the number (`#207`). */
  query: string;
  /** Only the changes that added, changed or removed a function of the catalog. */
  code: boolean;
  /** Only the commits pushed to main without a pull request. */
  direct: boolean;
}

/** The changes that pass the filter, newest first (as the history holds them). */
export function filterEntries(history: HistoryData, filter: HistoryFilter): HistoryEntry[] {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  return history.entries.filter((entry) => {
    if (filter.code && entry.functions.length === 0) return false;
    if (filter.direct && entry.kind !== 'direct') return false;
    if (words.length === 0) return true;
    const text = [entry.title, entry.branch ?? '', entry.pr === undefined ? '' : `#${entry.pr}`, entry.commit.slice(0, 10), ...entry.authors, ...entry.functions.map((change) => change.name), ...entry.notes, ...entry.commits.map((commit) => commit.subject)].join('\n').toLowerCase();
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

/**
 * The endpoints of a framework that the functions a change touched reach in
 * the map as it is now (a function since removed reaches none): their trace
 * starts from one, or one of their steps calls one, down to a few calls.
 */
export function endpointsReached(data: MapData, flow: OpFlow | undefined, entry: HistoryEntry): FlowEndpoint[] {
  if (flow === undefined) return [];
  const found = new Map<string, FlowEndpoint>();
  for (const change of entry.functions) {
    if (data.functions[change.id] === undefined) continue;
    for (const endpoint of endpointsRootedAt(flow, change.id)) found.set(endpoint.id, endpoint);
    for (const use of endpointsUsing(data, flow, change.id)) found.set(use.endpoint.id, use.endpoint);
  }
  return flow.endpoints.filter((endpoint) => found.has(endpoint.id));
}

/** The page of a change on GitHub: its pull request, or its commit; undefined when the repository is not known. */
export function changeUrl(history: HistoryData, entry: HistoryEntry): string | undefined {
  if (history.repository === undefined) return undefined;
  return entry.pr === undefined ? `https://github.com/${history.repository}/commit/${entry.commit}` : `https://github.com/${history.repository}/pull/${entry.pr}`;
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
