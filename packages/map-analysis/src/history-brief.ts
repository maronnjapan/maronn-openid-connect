/**
 * The history of main as an AI reads it, from the data of the map (map.json,
 * history/<hash>.json and the diff of each change): the history command of
 * apps/map prints it for Claude Code, and an AI the map carries later can
 * read the same. The diff of a change does not stand for the code: it points
 * the AI at the code. So for each function a change touched it gives the diff
 * of the provider's code (not the tests, documents or tools) and where the
 * function is in the code the map was built from, and the AI reads that code
 * and weighs the diff against it.
 *
 * - changeBrief: a change, its intent, its functions with their diff and
 *   their place now, and the changes outside the functions; with
 *   `diffs: false` the outline of a large change, file by file
 * - functionBrief: the changes that made a function what it is, newest first,
 *   with the sections of their change notes about it
 * - listBrief: the latest changes, one line each, with their keys
 *
 * A key the briefs print always opens the change it is printed for (keyOf):
 * the history has pull request numbers that two changes share.
 *
 * Plain data in, Markdown out: besides types it imports only the reading of
 * the change notes (notes.ts), so the map can import it
 * (`@maronn-openid-connect/map-analysis/history-brief`).
 */
import type { DiffHunk, HistoryData, HistoryDetail, HistoryEntry, HistoryFileDiff, MapData } from './model.js';
import { parseNote, resolveReference, type Named } from './notes.js';

/** What a brief needs of map.json: the frames and the files they are in. */
export type BriefMap = Pick<MapData, 'functions' | 'bodies' | 'sources'>;

/** A value of a record by its own key only (`constructor` names no function). */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The key of a change in the URL of the map: `pr-<number>` for a pull request, else the first ten characters of its commit. */
export function entryKey(entry: HistoryEntry): string {
  return entry.pr === undefined ? entry.commit.slice(0, 10) : `pr-${entry.pr}`;
}

/** The change a key names; a commit key matches the start of the commit, and the key of a pull request another change brought (HistoryEntry.carried) names that change. */
export function entryOf(history: HistoryData, key: string): HistoryEntry | undefined {
  const found = history.entries.find((entry) => entryKey(entry) === key) ?? (/^[0-9a-f]{7,}$/.test(key) ? history.entries.find((entry) => entry.commit.startsWith(key)) : undefined);
  if (found !== undefined) return found;
  const number = /^pr-(\d+)$/.exec(key)?.[1];
  return number === undefined ? undefined : history.entries.find((entry) => entry.carried?.some((pull) => pull.pr === Number(number)) === true);
}

/**
 * The key that opens a change: its entryKey, or the start of its commit when
 * that key opens another change (two changes of the history share a pull
 * request number, and `pr-<number>` opens the newer).
 */
export function keyOf(history: HistoryData, entry: HistoryEntry): string {
  const key = entryKey(entry);
  return entryOf(history, key) === entry ? key : entry.commit.slice(0, 10);
}

/** The key a person or an AI types for a change: `#219` and `219` name the pull request as `pr-219` does; a commit stays as it is, without the `^` git blame puts before the oldest commit. */
export function keyOfInput(text: string): string {
  const trimmed = text.trim().replace(/^\^/, '');
  const number = /^(?:#|pr-?)?(\d{1,6})$/i.exec(trimmed)?.[1];
  return number === undefined ? trimmed.toLowerCase() : `pr-${number}`;
}

/**
 * The change a person or an AI names: by its key (keyOfInput), by a commit of
 * its merged branch (the history keeps those that are no merge), or by the
 * merge of a pull request it brought. A merge inside a branch is not in the
 * data: the history command finds its change with git.
 */
export function changeNamed(history: HistoryData, text: string): HistoryEntry | undefined {
  const key = keyOfInput(text);
  const entry = entryOf(history, key);
  if (entry !== undefined || !/^[0-9a-f]{7,}$/.test(key)) return entry;
  return history.entries.find((candidate) => candidate.commits.some((commit) => commit.sha.startsWith(key)) || candidate.carried?.some((pull) => pull.commit.startsWith(key)) === true);
}

/** The other changes of the history with the same pull request number as a change (`pr-<number>` opens the newest of them). */
export function sharingNumber(history: HistoryData, entry: HistoryEntry): HistoryEntry[] {
  return entry.pr === undefined ? [] : history.entries.filter((other) => other !== entry && other.pr === entry.pr);
}

/** A hunk as the text of a unified diff, its header first (`@@ -12,4 +12,5 @@`). */
export function unifiedHunk(hunk: DiffHunk): string {
  const base = hunk.lines.filter((line) => line[0] !== '+').length;
  const head = hunk.lines.filter((line) => line[0] !== '-').length;
  return [`@@ -${hunk.base},${base} +${hunk.head},${head} @@`, ...hunk.lines].join('\n');
}

/** A fence around a text that no run of backquotes in it closes, so its own headings open no section of the brief. */
function fenced(language: string, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** A path as a word of a shell command: as it is when it is plain, else in single quotes (the route groups of Next.js, `(ciba)`). */
function shellWord(path: string): string {
  return /^[\w./@:+=-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Where a function or an endpoint body of the map is now: the path of its file and its inclusive lines; undefined when the map has no lines of it. */
export function placeOf(map: BriefMap, id: string): { path: string; start: number; end: number } | undefined {
  const source = (own(map.functions, id) ?? own(map.bodies, id))?.source;
  if (source === undefined) return undefined;
  return { path: own(map.sources, source.file)?.path ?? source.file, start: source.start, end: source.end };
}

/** The place of a function now, in words: `packages/core/src/a.ts:10-24`, or why there is none. */
function placeWords(map: BriefMap, id: string): string {
  const place = placeOf(map, id);
  if (place !== undefined) return `${place.path}:${place.start}-${place.end}`;
  return own(map.functions, id) !== undefined || own(map.bodies, id) !== undefined ? '（地図に行の無い関数）' : '今の地図には無い（消えたか、名前かファイルが変わった）';
}

/** The functions and endpoint bodies that call a function now, by name and place, up to a few. */
function callersWords(map: BriefMap, id: string, limit = 8): string | undefined {
  const callers = own(map.functions, id)?.calledBy ?? [];
  if (callers.length === 0) return undefined;
  const named = callers.slice(0, limit).map((caller) => {
    const entry = own(map.functions, caller) ?? own(map.bodies, caller);
    const place = placeOf(map, caller);
    const named = entry === undefined ? caller : 'endpoint' in entry ? `${entry.name}（エンドポイントの処理）` : `${entry.name}()`;
    return `${named}${place === undefined ? '' : `（${place.path}:${place.start}）`}`;
  });
  return `${named.join('、')}${callers.length > limit ? ` ほか ${callers.length - limit}` : ''}`;
}

/** What the lines of a brief about the code now mean, said once at its top. */
const READING_NOTES = [
  '- 「今のコード」の行は、地図をビルドしたときのコードのもの。ビルドの後にコードを変えたら、その行はずれる',
  '- 「今これを呼ぶもの」は、関数とエンドポイントの処理から型で辿れる呼び出しだけで、登録・初期化・モジュールの最上位からの呼び出しは入らない',
];

/** What a change did to a function, in a word. */
const STATUS_WORDS = { added: '追加', modified: '変更', removed: '削除' } as const;

/** Why the map has no diff of a file, in words. */
export function omittedWords(omitted: HistoryFileDiff['omitted']): string {
  return omitted === 'change' ? '変更全体の差分が多いので、このファイルの差分は地図に載せていない' : '差分が長いので地図に載せていない';
}

/** The heading of a change: `PR #219: …`, or its commit when it had no pull request. */
function titleOf(entry: HistoryEntry): string {
  return `${entry.pr === undefined ? `${entry.commit.slice(0, 10)}（PR なし）` : `PR #${entry.pr}`}: ${entry.title}`;
}

/** The page of a change on GitHub, when the repository is known: its pull request, or its commit when another change of the history has the same number (which of them the number names on GitHub is not known). */
function urlOf(history: HistoryData, entry: HistoryEntry): string | undefined {
  if (history.repository === undefined) return undefined;
  return entry.pr === undefined || sharingNumber(history, entry).length > 0 ? `https://github.com/${history.repository}/commit/${entry.commit}` : `https://github.com/${history.repository}/pull/${entry.pr}`;
}

/**
 * The git command that shows what a change did against the first parent (the
 * tests and documents too), or to some files of it (a renamed file by both
 * its paths); undefined for the oldest commit of a shallow clone, whose
 * parent git does not have.
 */
function gitShow(entry: HistoryEntry, files: ReadonlyArray<Pick<HistoryFileDiff, 'path' | 'from'>> = []): string | undefined {
  if (entry.boundary === true) return undefined;
  const paths = files.flatMap((file) => (file.from === undefined ? [file.path] : [file.from, file.path]));
  return `\`git show --diff-merges=first-parent --format= ${entry.commit.slice(0, 12)}${paths.length === 0 ? '' : ` -- ${paths.map(shellWord).join(' ')}`}\``;
}

/** The git command that shows the messages of the commits a change brought (their bodies often say why); undefined for the oldest commit of a shallow clone. */
function gitMessages(entry: HistoryEntry): string | undefined {
  if (entry.boundary === true) return undefined;
  const commit = entry.commit.slice(0, 12);
  return entry.kind === 'merge' ? `\`git log --no-merges --format='%h %s%n%n%b' ${commit}^1..${commit}\`` : `\`git log -1 --format=%B ${commit}\``;
}

/** Where to read a diff the map left out, in words. */
function omittedWhere(entry: HistoryEntry, file: HistoryFileDiff): string {
  const command = gitShow(entry, [file]);
  return `（${omittedWords(file.omitted)}${command === undefined ? '' : `。${command} で読める`}）`;
}

/** The lines a diff adds and removes, in words: `+12 −3 行`. */
function sizeWords(hunks: readonly DiffHunk[]): string {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) for (const line of hunk.lines) if (line[0] === '+') added += 1;
  else if (line[0] === '-') removed += 1;
  return `+${added} −${removed} 行`;
}

/** A function or a frame of the catalog by its id (`core:client-auth.ts#verifyClientSecret`), as the change notes name it. */
function namedOf(id: string, name: string): Named {
  const colon = id.indexOf(':');
  const hash = id.lastIndexOf('#');
  return { id, name, package: colon === -1 ? '' : id.slice(0, colon), module: colon === -1 || hash < colon ? '' : id.slice(colon + 1, hash) };
}

/**
 * The sections of the change notes of a change that are about a function: as
 * the map attaches them (notes.ts attachNotes), a section is about each
 * changed function one of its references resolves to (by id, by name, by
 * `root:name` or `module#name`). With `byId` (an endpoint body, which the map
 * makes a frame of only when its own lines changed, and never when it has
 * none), only the sections that name it by its id.
 */
function notesOn(detail: HistoryDetail | undefined, entry: HistoryEntry, id: string, byId = false): Array<{ path: string; heading: string; text: string }> {
  const changed = entry.functions.map((change) => namedOf(change.id, change.name));
  const found: Array<{ path: string; heading: string; text: string }> = [];
  for (const note of detail?.notes ?? []) {
    for (const section of parseNote(note.text).sections) {
      const about = byId ? section.references.includes(id) : section.references.some((reference) => resolveReference(reference, changed).some((target) => target.id === id));
      if (about && section.text.trim() !== '') found.push({ path: note.path, heading: section.heading, text: section.text.trim() });
    }
  }
  return found;
}

/** The diff of a function in a change: its hunks and the file they are in; undefined when the detail has none of it. */
function diffOf(detail: HistoryDetail | undefined, id: string): { file: HistoryFileDiff; hunks: DiffHunk[] } | undefined {
  for (const file of detail?.files ?? []) {
    const fn = file.functions.find((candidate) => candidate.id === id);
    if (fn !== undefined) return { file, hunks: fn.hunks };
  }
  return undefined;
}

/** The diff of a function in a change as the lines of a brief: the fenced hunks, or why there are none and where to read them. */
function diffLines(entry: HistoryEntry, detail: HistoryDetail | undefined, unread: boolean, id: string): string[] {
  const diff = diffOf(detail, id);
  const moved = diff?.file.from === undefined ? [] : [`（ファイルを ${diff.file.from} から ${diff.file.path} へ移した変更。前の履歴は元のファイルにある）`, ''];
  if (diff !== undefined && diff.hunks.length > 0) return [...moved, fenced('diff', diff.hunks.map(unifiedHunk).join('\n')), ''];
  if (diff?.file.omitted !== undefined) return [...moved, omittedWhere(entry, diff.file), ''];
  if (unread) return ['（差分を読めなかった）', ''];
  return [...moved, '（差分なし）', ''];
}

/**
 * A change for an AI: what it meant (the text of its pull request and of the
 * change notes it wrote), each function it added, changed or removed with
 * its diff and where it is now (and who calls it), the changes outside the
 * functions, and how to read the rest with git. With `diffs: false` it is the
 * outline of a large change instead: the gist of its intent, and its
 * functions by the file they are in now with the size of their diff, whose
 * functions the AI then reads one by one.
 */
export function changeBrief(map: BriefMap, history: HistoryData, entry: HistoryEntry, detail: HistoryDetail | undefined, options: { diffs?: boolean } = {}): string {
  const outline = options.diffs === false;
  const unread = detail === undefined && entry.detail !== undefined;
  const url = urlOf(history, entry);
  const whole = gitShow(entry);
  const lines: string[] = [`# ${titleOf(entry)}${outline ? '（見取り図）' : ''}`, ''];
  lines.push(`- キー: ${keyOf(history, entry)} · main に入った日: ${entry.date.slice(0, 10)}${entry.branch === undefined ? '' : ` · ブランチ: ${entry.branch}`} · 作成者: ${entry.authors.join('、')}${url === undefined ? '' : ` · ${url}`}`);
  lines.push('- 差分は、OSS が出すコード（関数カタログの根のファイル）の、変更したときのもの。判断の前に、各関数の「今のコード」の行を読む');
  if (whole !== undefined) lines.push(`- テストや文書を含む変更全体: ${whole}`);
  const shared = sharingNumber(history, entry);
  if (shared.length > 0) lines.push(`- PR 番号 #${entry.pr} の変更はほかにもある: ${shared.map((other) => `${keyOf(history, other)}（${other.date.slice(0, 10)} ${other.title}）`).join('、')}`);
  lines.push(...READING_NOTES, '');
  if (entry.boundary === true) lines.push('浅い clone の最も古いコミットなので、何を変えたかは分からない。', '');
  if (unread) lines.push('この変更の差分（地図のデータ）を読めなかった。関数ごとの差分と関数の外の変更は、上の git のコマンドで読む。', '');

  lines.push('## 意図', '');
  const intent = lines.length;
  if (outline) {
    const gist = gistOf(entry.body);
    if (gist.length > 0) lines.push(`- PR の本文: ${gist.join(' ')}`);
    for (const pull of entry.carried ?? []) lines.push(`- この変更で main に入った PR #${pull.pr}: ${pull.title}`);
    for (const note of detail?.notes ?? []) {
      const headings = parseNote(note.text).sections.map((section) => section.heading);
      lines.push(`- 変更メモ ${note.path}${headings.length === 0 ? '' : `（節: ${headings.slice(0, 12).join('、')}${headings.length > 12 ? ` ほか ${headings.length - 12}` : ''}）`}`);
    }
    if (lines.length > intent) lines.push('', '本文と変更メモの全文は、見取り図でない変更のブリーフにある。', '');
  } else {
    if (entry.body !== undefined && entry.body.trim() !== '') lines.push('### PR の本文', '', fenced('markdown', entry.body.trim()), '');
    for (const pull of entry.carried ?? []) lines.push(`### この変更で main に入った PR #${pull.pr}: ${pull.title}`, '', pull.body === undefined || pull.body.trim() === '' ? '（本文なし）' : fenced('markdown', pull.body.trim()), '');
    for (const note of detail?.notes ?? []) lines.push(`### 変更メモ ${note.path}`, '', fenced('markdown', note.text.trim()), '');
  }
  const unreadNotes = entry.notes.filter((path) => detail?.notes.some((note) => note.path === path) !== true);
  if (unreadNotes.length > 0) lines.push('### 変更メモ（本文を読めなかった）', '', ...unreadNotes.map((path) => `- ${path}${entry.boundary === true ? '' : `（\`git show ${entry.commit.slice(0, 12)}:${shellWord(path)}\`）`}`), '');
  if (lines.length === intent) lines.push(entry.pr === undefined ? 'PR が無い。コミットのメッセージが、何をしたかの記録である（下の「コミット」）。' : '地図のデータに PR の本文が無い（ビルドに MAP_PULLS を渡すと載る）。コミットのメッセージも読む（下の「コミット」）。', '');

  const counts = { added: 0, modified: 0, removed: 0 };
  for (const change of entry.functions) counts[change.status] += 1;
  lines.push(`## 変えた関数（追加 ${counts.added}・変更 ${counts.modified}・削除 ${counts.removed}）`, '');
  if (entry.functions.length === 0) lines.push('関数カタログの関数は変えていない。', '');
  if (outline) lines.push(...outlineLines(map, entry, detail, unread));
  else {
    for (const change of entry.functions) {
      lines.push(`### ${STATUS_WORDS[change.status]} \`${change.name}()\` \`${change.id}\``, '');
      lines.push(`- 今のコード: ${placeWords(map, change.id)}`);
      const callers = callersWords(map, change.id);
      if (callers !== undefined) lines.push(`- 今これを呼ぶもの: ${callers}`);
      lines.push('', ...diffLines(entry, detail, unread, change.id));
    }
  }

  const outside = (detail?.files ?? []).filter((file) => file.outside.length > 0);
  if (outside.length > 0) {
    lines.push('## 関数の外の変更（import、型、定数、エンドポイントの処理など）', '');
    for (const file of outside) {
      const path = file.from === undefined ? file.path : `${file.from} → ${file.path}`;
      if (outline) lines.push(`- ${path}（${sizeWords(file.outside)}）`);
      else lines.push(`### ${path}`, '', fenced('diff', file.outside.map(unifiedHunk).join('\n')), '');
    }
    if (outline) lines.push('');
  }
  const omitted = (detail?.files ?? []).filter((file) => file.omitted !== undefined);
  if (omitted.length > 0) {
    const command = gitShow(entry, omitted);
    lines.push('## 地図に載せなかった差分', '', ...omitted.map((file) => `- ${file.from === undefined ? file.path : `${file.from} → ${file.path}`}（${omittedWords(file.omitted)}）`), '');
    if (command !== undefined) lines.push(`${command} で読める。`, '');
  }
  if (entry.commits.length > 0) {
    const shown = outline ? entry.commits.slice(0, 10) : entry.commits;
    const messages = gitMessages(entry);
    lines.push(`## コミット ${entry.commits.length}`, '', ...shown.map((commit) => `- ${commit.sha.slice(0, 10)} ${commit.subject}（${commit.author}）`), '');
    if (shown.length < entry.commits.length) lines.push(`ほか ${entry.commits.length - shown.length} コミット。`, '');
    if (messages !== undefined) lines.push(`メッセージの本文（なぜそうしたかを書いていることが多い）: ${messages}`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The functions of a change for its outline: by the file each is in now (those the map no longer has at the end), with the lines of their place and the size of their diff. */
function outlineLines(map: BriefMap, entry: HistoryEntry, detail: HistoryDetail | undefined, unread: boolean): string[] {
  const files = new Map<string, string[]>();
  const gone: string[] = [];
  for (const change of entry.functions) {
    const place = placeOf(map, change.id);
    const diff = diffOf(detail, change.id);
    const size = diff !== undefined && diff.hunks.length > 0 ? sizeWords(diff.hunks) : diff?.file.omitted !== undefined ? '差分は地図に無い' : unread ? '差分を読めなかった' : '差分なし';
    const moved = diff?.file.from === undefined ? '' : `、${diff.file.from} から移した`;
    if (place === undefined) {
      gone.push(`- ${STATUS_WORDS[change.status]} \`${change.id}\`（${size}${moved}）`);
      continue;
    }
    const list = files.get(place.path) ?? [];
    list.push(`- ${STATUS_WORDS[change.status]} \`${change.name}()\` ${place.start}-${place.end}（${size}${moved}）`);
    files.set(place.path, list);
  }
  const lines: string[] = [];
  for (const [path, list] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) lines.push(`### ${path}`, '', ...list, '');
  if (gone.length > 0) lines.push('### 今の地図に無い関数', '', ...gone, '');
  return lines;
}

/** The first paragraph of the text of a pull request, its headings and HTML comments skipped, up to a few lines. */
function gistOf(body: string | undefined, limit = 4): string[] {
  const gist: string[] = [];
  for (const line of (body ?? '').replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const text = line.trim();
    if (text.startsWith('#') || text === '') {
      if (gist.length > 0) break;
      continue;
    }
    gist.push(text);
    if (gist.length === limit) break;
  }
  return gist;
}

/**
 * The ids of the functions a text names, as a change note names them (an id,
 * a name, `root:name`, `module#name`): among the functions and endpoint
 * bodies of the map and the functions of the history, or with `within` among
 * the functions that change touched.
 */
export function functionsNamed(map: BriefMap, history: HistoryData, text: string, within?: HistoryEntry): string[] {
  const reference = text.trim().replace(/\(\)$/, '');
  const candidates = new Map<string, Named>();
  if (within !== undefined) {
    for (const change of within.functions) candidates.set(change.id, namedOf(change.id, change.name));
    // An endpoint body is no function of the change: the change touched it when it changed its file.
    for (const body of Object.values(map.bodies)) {
      const path = bodyPathOf(map, body.id);
      if (path !== undefined && changedFile(within, path)) candidates.set(body.id, { id: body.id, name: body.name, package: body.package, module: body.module });
    }
  } else {
    for (const entry of [...Object.values(map.functions), ...Object.values(map.bodies)]) candidates.set(entry.id, { id: entry.id, name: entry.name, package: entry.package, module: entry.module });
    for (const entry of history.entries) for (const change of entry.functions) if (!candidates.has(change.id)) candidates.set(change.id, namedOf(change.id, change.name));
  }
  return [...new Set(resolveReference(reference, [...candidates.values()]).map((named) => named.id))].sort();
}

/** The path of the file an endpoint body is in now: the file of its lines, else of its module (a body the map has no lines of, as one that only hands the request to its functions). */
function bodyPathOf(map: BriefMap, id: string): string | undefined {
  const body = own(map.bodies, id);
  if (body === undefined) return undefined;
  return placeOf(map, id)?.path ?? own(map.sources, `${body.package}:${body.module}`)?.path;
}

/** Whether a change changed a file (by its path now, or by its path before a rename). */
function changedFile(entry: HistoryEntry, path: string): boolean {
  return entry.files.some((file) => file.path === path || file.from === path);
}

/**
 * The changes a function brief is about, newest first: those the history
 * lists for a function; for an endpoint body, which the history does not
 * follow by itself, those that changed the file it is in now.
 */
export function changesFor(map: BriefMap, history: HistoryData, id: string): HistoryEntry[] {
  const listed = own(history.functions, id);
  if (listed !== undefined) return listed.map((index) => history.entries[index]).filter((entry): entry is HistoryEntry => entry !== undefined);
  const path = bodyPathOf(map, id);
  return path === undefined ? [] : history.entries.filter((entry) => changedFile(entry, path));
}

/** The changes a change made to a file outside its functions (where an endpoint body is) as the lines of a brief. */
function outsideLines(entry: HistoryEntry, detail: HistoryDetail | undefined, unread: boolean, path: string): string[] {
  const file = detail?.files.find((candidate) => candidate.path === path || candidate.from === path);
  if (file !== undefined && file.outside.length > 0) return [fenced('diff', file.outside.map(unifiedHunk).join('\n')), ''];
  if (file?.omitted !== undefined) return [omittedWhere(entry, file), ''];
  if (unread) return ['（差分を読めなかった）', ''];
  return ['（このファイルの関数の外の差分なし）', ''];
}

/**
 * A function for an AI: where it is now and who calls it, and the changes
 * that touched it, newest first, each with the gist of its intent, the
 * sections of its change notes about the function (why it changed), and its
 * diff of the function (`details` by commit; a change whose detail is missing
 * says it could not be read). Up to `limit` changes, the rest counted; with
 * `only`, that change alone. An endpoint body has no history of its own (the
 * history follows the functions of the catalog), so its brief takes the
 * changes of its file (changesFor), with their notes about the body and their
 * diff of the file outside its functions, and says how to read the history of
 * its lines with git.
 */
export function functionBrief(map: BriefMap, history: HistoryData, id: string, details: ReadonlyMap<string, HistoryDetail>, options: { limit?: number; only?: HistoryEntry } = {}): string {
  const limit = options.limit ?? 10;
  const all = changesFor(map, history, id);
  const entries = options.only === undefined ? all : all.filter((entry) => entry === options.only);
  const body = own(history.functions, id) === undefined ? own(map.bodies, id) : undefined;
  const place = placeOf(map, id);
  const bodyPath = body === undefined ? undefined : bodyPathOf(map, id);
  const name = (own(map.functions, id) ?? own(map.bodies, id))?.name ?? all.flatMap((entry) => entry.functions).find((change) => change.id === id)?.name ?? id;
  const lines: string[] = [`# \`${name}${body === undefined ? '()' : ''}\` の変更の履歴${options.only === undefined ? '' : `（${titleOf(options.only)}）`}`, '', `- id: \`${id}\``, `- 今のコード: ${placeWords(map, id)}`];
  const callers = callersWords(map, id);
  if (callers !== undefined) lines.push(`- 今これを呼ぶもの: ${callers}`);
  if (body === undefined) lines.push(`- 変えた変更: ${all.length}（新しい順）。差分は変更したときのもので、今のコードとは行がずれていることがある`, ...READING_NOTES, '');
  else {
    lines.push(`- このファイルを変えた変更: ${all.length}（新しい順）`, ...READING_NOTES, '');
    const lineHistory = place !== undefined ? `この行だけの履歴は \`git log --first-parent -L ${place.start},${place.end}:${shellWord(place.path)}\` で読める。` : bodyPath !== undefined ? `このファイルの履歴は \`git log --first-parent -p -- ${shellWord(bodyPath)}\` で読める。` : '';
    lines.push(`エンドポイントの処理は、変更の履歴が関数ごとには追わない。このファイル${bodyPath === undefined ? '' : `（${bodyPath}）`}を変えた変更を、変更メモのうちこの処理を id（\`<!-- ${id} -->\`）で挙げた節と、このファイルの関数の外の差分（import や型を含む）で並べる。${lineHistory}`, '');
    const handlers = body.calls.filter((call) => own(map.functions, call) !== undefined);
    if (handlers.length > 0) lines.push(`この処理が呼ぶ関数には、関数ごとの履歴がある: ${handlers.slice(0, 8).map((call) => `\`${call}\``).join('、')}${handlers.length > 8 ? ` ほか ${handlers.length - 8}` : ''}`, '');
  }
  if (history.shallow === true) lines.push('浅い clone から読んだ履歴なので、古い変更は無い。', '');
  if (options.only !== undefined && entries.length === 0) lines.push(body === undefined ? 'この変更は、この関数を変えていない。' : 'この変更は、このファイルを変えていない。', '');
  for (const entry of entries.slice(0, limit)) {
    const change = entry.functions.find((candidate) => candidate.id === id);
    lines.push(`## ${titleOf(entry)}`, '', `- キー: ${keyOf(history, entry)} · ${entry.date.slice(0, 10)} · ${change === undefined ? '' : `${STATUS_WORDS[change.status]} · `}作成者: ${entry.authors.join('、')}`);
    const gist = gistOf(entry.body);
    if (gist.length > 0) lines.push(`- 意図（PR の本文から）: ${gist.join(' ')}`);
    lines.push('');
    const detail = details.get(entry.commit);
    const unread = detail === undefined && entry.detail !== undefined;
    if (unread && entry.notes.length > 0) lines.push(`変更メモ（${entry.notes.join('、')}）を読めなかった。`, '');
    for (const section of notesOn(detail, entry, id, body !== undefined)) lines.push(`変更メモ ${section.path} の「${section.heading}」:`, '', fenced('markdown', section.text), '');
    lines.push(...(bodyPath === undefined ? diffLines(entry, detail, unread, id) : outsideLines(entry, detail, unread, bodyPath)));
  }
  if (entries.length > limit) lines.push(`ほか ${entries.length - limit} 件の古い変更（--limit で増やせる）。`, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The latest changes, one line each: the key that opens it, the day, the title and the functions it touched. */
export function listBrief(history: HistoryData, limit = 20): string {
  const head = history.entries[0];
  const lines = [`# main に入った変更（新しい順、${Math.min(limit, history.entries.length)} / ${history.entries.length}${head === undefined ? '' : `。${head.commit.slice(0, 10)} まで`}）`, ''];
  for (const entry of history.entries.slice(0, limit)) {
    const counts = { added: 0, modified: 0, removed: 0 };
    for (const change of entry.functions) counts[change.status] += 1;
    const touched = entry.functions.length === 0 ? '関数の変更なし' : `関数 +${counts.added} ~${counts.modified} -${counts.removed}`;
    lines.push(`- ${keyOf(history, entry)} ${entry.date.slice(0, 10)} ${entry.pr === undefined ? '（PR なし）' : `#${entry.pr}`} ${entry.title}（${touched}）`);
  }
  if (history.shallow === true) lines.push('', '浅い clone から読んだ履歴なので、古い変更は無い。');
  return `${lines.join('\n').trimEnd()}\n`;
}
