/**
 * The history of main (HistoryData, written by packages/map-analysis
 * history.ts) as the page reads it: the key of a change in the URL
 * (`pr-207`, or the commit of a push without a pull request), the changes
 * the reader filters for, the changes that touched a function, the
 * endpoints a change reaches in the map as it is now, and the links to
 * GitHub. Nothing here touches the DOM.
 */
import type { DiffHunk, FlowEndpoint, HistoryData, HistoryDetail, HistoryEntry, HistoryFileDiff, MapData, OpFlow } from '../types';
import { endpointsInModule, endpointsUsing } from './model';

/** The key of a change in the URL: `pr-<number>` for a pull request, else the first ten characters of its commit. */
export function entryKey(entry: HistoryEntry): string {
  return entry.pr === undefined ? entry.commit.slice(0, 10) : `pr-${entry.pr}`;
}

/** The change a key names; a commit key matches the start of the commit, and the key of a pull request another change brought (HistoryEntry.carried) names that change. */
export function entryOf(history: HistoryData, key: string): HistoryEntry | undefined {
  const own = history.entries.find((entry) => entryKey(entry) === key) ?? (/^[0-9a-f]{7,}$/.test(key) ? history.entries.find((entry) => entry.commit.startsWith(key)) : undefined);
  if (own !== undefined) return own;
  const number = /^pr-(\d+)$/.exec(key)?.[1];
  return number === undefined ? undefined : history.entries.find((entry) => entry.carried?.some((pull) => pull.pr === Number(number)) === true);
}

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

/** Why the map has no diff of a file: its own diff is too long, or the change kept as much as it may before it. */
export function omittedWords(omitted: HistoryFileDiff['omitted']): string {
  return omitted === 'change' ? '変更全体の差分が多いので、このファイルの差分は地図に載せていない' : '差分が長いので地図に載せていない';
}

/** A hunk as the text of a unified diff, its header first (`@@ -12,4 +12,5 @@`). */
export function unifiedHunk(hunk: DiffHunk): string {
  const base = hunk.lines.filter((line) => line[0] !== '+').length;
  const head = hunk.lines.filter((line) => line[0] !== '-').length;
  return [`@@ -${hunk.base},${base} +${hunk.head},${head} @@`, ...hunk.lines].join('\n');
}

/** A fence around a text that no run of backquotes in it closes. */
function fenced(language: string, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** What a change did to a function, in a word. */
const STATUS_WORDS = { added: '追加', modified: '変更', removed: '削除' } as const;

/**
 * A change as Markdown to hand to an AI: what it meant (the text of its pull
 * request and its change notes), where it reaches in the map now, and the
 * diff of the code the OSS ships only, function by function and then outside
 * the functions, so the AI reads no test, document or tool it does not need.
 * With `only`, the diff keeps the functions (by id) and the files (by path,
 * for their changes outside the functions) the reader chose.
 */
export function aiMarkdown(history: HistoryData, entry: HistoryEntry, detail: HistoryDetail | undefined, reached: readonly FlowEndpoint[], framework: string, only?: ReadonlySet<string>): string {
  const url = changeUrl(history, entry);
  const lines: string[] = [`# ${entry.pr === undefined ? `${entry.commit.slice(0, 10)}（PR なし）` : `PR #${entry.pr}`}: ${entry.title}`, ''];
  lines.push(`- main に入った日: ${dayOf(entry.date)}${entry.branch === undefined ? '' : ` · ブランチ: ${entry.branch}`} · 作成者: ${entry.authors.join('、')}${url === undefined ? '' : ` · ${url}`}`);
  lines.push('- この文書の差分は、OSS が出すコード（関数カタログの根のファイル）だけである。テスト、文書、道具の変更は含まない', '');
  if (only !== undefined) lines.push(`- 差分は、読み手が選んだ ${only.size} か所（関数と、関数の外の変更のあるファイル）だけである。変更全体の関数は ${entry.functions.length} 個ある`, '');
  // The texts are fenced, so their own headings do not open sections of this document.
  if (entry.body !== undefined && entry.body.trim() !== '') lines.push('## PR の本文', '', fenced('markdown', entry.body.trim()), '');
  for (const pull of entry.carried ?? []) lines.push(`## この変更で main に入った PR #${pull.pr}: ${pull.title}`, '', pull.body === undefined ? '（本文なし）' : fenced('markdown', pull.body.trim()), '');
  for (const note of detail?.notes ?? []) lines.push(`## 変更メモ ${note.path}`, '', fenced('markdown', note.text.trim()), '');
  lines.push(`## 今の地図で届くエンドポイント（${framework}）`, '');
  if (reached.length === 0) lines.push('- なし', '');
  else lines.push(...reached.map((endpoint) => `- ${endpoint.methods.join(' | ')} ${endpoint.path}（${endpoint.label}）`), '');
  const counts = functionCounts(entry);
  lines.push(`## 変えた関数（追加 ${counts.added}・変更 ${counts.modified}・削除 ${counts.removed}）`, '');
  const omitted: Array<{ path: string; why: string }> = [];
  const outside: Array<{ path: string; hunks: DiffHunk[] }> = [];
  for (const file of detail?.files ?? []) {
    if (file.omitted !== undefined) omitted.push({ path: file.path, why: omittedWords(file.omitted) });
    for (const fn of file.functions) {
      if (only !== undefined && !only.has(fn.id)) continue;
      const change = entry.functions.find((candidate) => candidate.id === fn.id);
      lines.push(`### ${change === undefined ? '' : `${STATUS_WORDS[change.status]} `}\`${fn.id}\`（${file.path}）`, '');
      if (fn.hunks.length > 0) lines.push(fenced('diff', fn.hunks.map(unifiedHunk).join('\n')), '');
      else lines.push(file.omitted === undefined ? '（差分なし）' : `（${omittedWords(file.omitted)}）`, '');
    }
    if (file.outside.length > 0 && (only === undefined || only.has(file.path))) outside.push({ path: file.from === undefined ? file.path : `${file.from} → ${file.path}`, hunks: file.outside });
  }
  if (outside.length > 0) {
    lines.push('## 関数の外の変更（import、型、定数など）', '');
    for (const file of outside) lines.push(`### ${file.path}`, '', fenced('diff', file.hunks.map(unifiedHunk).join('\n')), '');
  }
  if (omitted.length > 0) lines.push('## 地図に載せなかった差分', '', ...omitted.map((file) => `- ${file.path}（${file.why}）`), '');
  if (entry.commits.length > 0) lines.push('## コミット', '', ...entry.commits.map((commit) => `- ${commit.subject}（${commit.sha.slice(0, 7)}、${commit.author}）`), '');
  return `${lines.join('\n').trimEnd()}\n`;
}
