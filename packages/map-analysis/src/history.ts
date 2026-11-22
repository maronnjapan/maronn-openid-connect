/**
 * What each change that reached main did, read from the first-parent history
 * of main (HistoryData, model.ts): every pull request merged or squashed into
 * it and every commit pushed to it without one, with its commits, the files
 * it changed against the first parent, the functions of the catalog's roots
 * it added, modified or removed, and the change notes it wrote. The owner
 * reads it to trace, after the fact, what each pull request (often made by
 * an agent) implemented.
 *
 * A pull request merged into a branch that a change then merged (a pull of
 * main pushed as a merge, a pull request into another's branch) is no change
 * of its own on the first-parent history: the change that brought it lists it
 * (HistoryEntry.carried). A merge whose message is the title of its pull
 * request (`Title (#12)`) is a merge, not a squash. In a shallow clone the
 * oldest commit lists no files nor functions (HistoryEntry.boundary): git
 * sees its whole tree as added.
 *
 * git is asked a few times, whatever the length of the history: once for the
 * commits, once for the files of every change (raw and numstat), once for the
 * lines each change of a file under the roots touched (`-U0`, the hunks keyed
 * by the blobs before and after), and once for the texts of those files
 * (`cat-file --batch`).
 *
 * The functions of a text are found as the function catalog finds them
 * (packages/cli/src/extract/functions.ts): a top-level `function` declaration
 * whose start is code, the declarations of one name (an overload set) taken
 * together, from the JSDoc right above the first to the end of the body of
 * the last (FunctionSpan of the catalog). A name only in the text after the
 * change was added, one only in the text before was removed, and one in both
 * was modified when a line the change removed is in its lines before or a
 * line it added is in its lines after. A function of a renamed file goes by
 * the id of its new module (a removed one by that of the old), so a rename
 * lists only the functions whose lines it changed. A file outside the roots
 * has no functions: a function moved into the roots from outside counts as
 * added.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import type { HistoryCommit, HistoryData, HistoryEntry, HistoryFile, HistoryFunction } from './model.js';
import { isNote } from './notes.js';
import { moduleOf, type AnalysisRoot } from './roots.js';

/** A pull request as the REST API of GitHub lists it (`GET /repos/{owner}/{repo}/pulls?state=closed`): the fields the history reads. */
export interface PullRequestInfo {
  number: number;
  title?: string;
  body?: string | null;
  head?: { ref?: string };
}

export interface HistoryOptions {
  /** The root of the repository. */
  repository: string;
  /** The roots of the function catalog (readRoots). */
  roots: readonly AnalysisRoot[];
  /** Which characters of a source are code, as the catalog reads them (Cli.codeMaskOf). */
  codeMaskOf(source: string): Uint8Array;
  /** The revision whose first-parent history is read; HEAD by default. */
  revision?: string;
  /** The pull requests on GitHub: their titles replace those of git, and their bodies come with them. */
  pulls?: readonly PullRequestInfo[];
  /** owner/name on GitHub. */
  github?: string;
}

/** A commit as `git log` lists it. */
interface Commit {
  sha: string;
  parents: string[];
  /** The committer date in seconds since the epoch, to order by. */
  time: number;
  /** The committer date, ISO 8601. */
  date: string;
  author: string;
  subject: string;
  body: string;
}

/** A file a commit changed against its first parent, as the raw and numstat output of `git log` list it. */
interface FileChange {
  /** The letter of the raw output: A, M, D, R, T (C counts as A). */
  status: string;
  /** The path before (absent for an added file) and after (absent for a deleted one). */
  before?: string;
  after?: string;
  /** The blobs of the paths before and after. */
  beforeBlob?: string;
  afterBlob?: string;
  additions: number;
  deletions: number;
}

/** A hunk of `git diff -U0`: the lines it removes from the text before (from `oldStart`, `oldCount` of them) and adds to the text after. */
interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** The lines (1-based, inclusive) a function takes in a text: from its JSDoc to the end of its body. */
interface Span {
  start: number;
  end: number;
}

/** A text and which of its characters are code (1), as the catalog parses a file. */
interface CodeText {
  source: string;
  code: Uint8Array;
}

/** The subject GitHub gives the merge of a pull request. */
const MERGE_SUBJECT = /^Merge pull request #(\d+) from (\S+)/;
/** The subject GitHub gives the squash of a pull request: its title, then its number. */
const SQUASH_SUBJECT = /^(.*) \(#(\d+)\)$/;
/** A top-level function declaration, as the catalog finds it (parseFile of packages/cli/src/extract/functions.ts). */
const DECLARATION = /^(export\s+)?(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;

/** Run git in the repository and return what it printed, as bytes; throws with its error output when it fails. */
function gitBytes(repository: string, args: readonly string[], input?: string): Buffer {
  const result = spawnSync('git', ['-c', 'log.showSignature=false', ...args], { cwd: repository, maxBuffer: 1024 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stderr.toString('utf8').trim()}`);
  return result.stdout;
}

/** Run git in the repository and return what it printed, as text. */
function gitText(repository: string, args: readonly string[]): string {
  return gitBytes(repository, args).toString('utf8');
}

/** Every commit of the history of a revision, by sha: its parents, its committer date, its author, its subject and its body. */
function readCommits(repository: string, tip: string): Map<string, Commit> {
  const fields = gitText(repository, ['log', '-z', '--format=%H%x00%P%x00%ct%x00%cI%x00%an%x00%s%x00%b', tip]).split('\0');
  const commits = new Map<string, Commit>();
  for (let index = 0; index + 7 <= fields.length; index += 7) {
    const [sha, parents, time, date, author, subject, body] = fields.slice(index, index + 7) as [string, string, string, string, string, string, string];
    commits.set(sha, { sha, parents: parents === '' ? [] : parents.split(' '), time: Number(time), date: isoDate(date), author, subject, body });
  }
  return commits;
}

/**
 * A date as `git log` writes it (`%cI`), the same whichever git reads it:
 * newer gits write UTC as `Z`, older ones as `+00:00`; the history writes
 * `+00:00`, keeping any other offset as it is.
 */
export function isoDate(date: string): string {
  return date.endsWith('Z') ? `${date.slice(0, -1)}+00:00` : date;
}

/** The commits of the first-parent history of a commit, newest first (`git log --first-parent`); in a shallow clone, those it has. */
function firstParents(tip: string, commits: ReadonlyMap<string, Commit>): Commit[] {
  const chain: Commit[] = [];
  for (let commit = commits.get(tip); commit !== undefined; commit = commit.parents[0] === undefined ? undefined : commits.get(commit.parents[0])) chain.push(commit);
  return chain;
}

/** The commits reachable from a commit outside a set, which takes them in. */
function reachedOutside(start: string, seen: Set<string>, commits: ReadonlyMap<string, Commit>): Commit[] {
  const reached: Commit[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    const commit = commits.get(sha);
    if (commit === undefined || seen.has(sha)) continue;
    seen.add(sha);
    reached.push(commit);
    stack.push(...commit.parents);
  }
  return reached;
}

/** Commits oldest first, as `git log --reverse` lists them: a parent before its children, else the earlier committer date first. */
function oldestFirst(commits: readonly Commit[]): Commit[] {
  const listed = new Set(commits.map((commit) => commit.sha));
  const waiting = new Map(commits.map((commit) => [commit.sha, commit.parents.filter((parent) => listed.has(parent)).length]));
  const ordered: Commit[] = [];
  const left = [...commits];
  while (left.length > 0) {
    let next = -1;
    left.forEach((commit, index) => {
      if (waiting.get(commit.sha) !== 0) return;
      const best = next === -1 ? undefined : left[next];
      if (best === undefined || commit.time < best.time) next = index;
    });
    // A cycle cannot happen in git; should the counts go wrong, the rest go by date.
    if (next === -1) next = left.reduce((best, commit, index) => (commit.time < (left[best] as Commit).time ? index : best), 0);
    const [commit] = left.splice(next, 1) as [Commit];
    ordered.push(commit);
    for (const other of left) if (other.parents.includes(commit.sha)) waiting.set(other.sha, (waiting.get(other.sha) ?? 1) - 1);
  }
  return ordered;
}

/**
 * The commits each merge of the first-parent history brought, oldest first
 * and the merge commits left out (`git log --no-merges --reverse <C>^1..<C>^2`),
 * by the merge's sha. The chain is walked from its oldest commit with the set
 * of every ancestor of the commit reached, so each merge walks only what it
 * brought.
 */
function branchCommits(chain: readonly Commit[], commits: ReadonlyMap<string, Commit>): Map<string, { own: Commit[]; carried: Commit[] }> {
  const seen = new Set<string>();
  const branches = new Map<string, { own: Commit[]; carried: Commit[] }>();
  for (const commit of [...chain].reverse()) {
    commit.parents.slice(1).forEach((parent, index) => {
      const reached = oldestFirst(reachedOutside(parent, seen, commits));
      // The pull requests merged or squashed on the way: in a branch this merge brought, they reach main with it.
      if (index === 0) branches.set(commit.sha, { own: reached.filter((candidate) => candidate.parents.length < 2), carried: reached.filter((candidate) => kindOf(candidate).pr !== undefined).reverse() });
    });
    seen.add(commit.sha);
  }
  return branches;
}

/** The commits a shallow clone has without their parents (the lines of `.git/shallow`); none in a full clone. */
function shallowBoundaries(repository: string): Set<string> {
  const path = gitText(repository, ['rev-parse', '--git-path', 'shallow']).trim();
  const file = isAbsolute(path) ? path : join(repository, path);
  return existsSync(file) ? new Set(readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line !== '')) : new Set();
}

/**
 * The files each commit of the first-parent history changed against its
 * first parent (the root commit against the empty tree), renames found, with
 * their blobs and the lines added and removed (0 for a binary file), by the
 * commit's sha.
 */
function readFiles(repository: string, tip: string): Map<string, FileChange[]> {
  const output = gitText(repository, ['log', '--first-parent', '--diff-merges=first-parent', '-M', '--raw', '--numstat', '-z', '--no-abbrev', '--root', '--format=%x01%H', tip]);
  const files = new Map<string, FileChange[]>();
  for (const chunk of output.split('\x01')) {
    const tokens = chunk.split('\0');
    const sha = (tokens[0] as string).trim();
    if (sha === '') continue;
    const list: FileChange[] = [];
    let counted = 0;
    for (let index = 1; index < tokens.length; ) {
      const token = (tokens[index] as string).replace(/^\n+/, '');
      if (token.startsWith(':')) {
        const [, , beforeBlob, afterBlob, status = ''] = token.slice(1).split(' ');
        const letter = status.charAt(0);
        if (letter === 'R' || letter === 'C') {
          const [before, after] = [tokens[index + 1] as string, tokens[index + 2] as string];
          list.push(letter === 'R' ? { status: 'R', before, after, beforeBlob: beforeBlob as string, afterBlob: afterBlob as string, additions: 0, deletions: 0 } : { status: 'A', after, afterBlob: afterBlob as string, additions: 0, deletions: 0 });
          index += 3;
          continue;
        }
        const path = tokens[index + 1] as string;
        if (letter === 'A') list.push({ status: 'A', after: path, afterBlob: afterBlob as string, additions: 0, deletions: 0 });
        else if (letter === 'D') list.push({ status: 'D', before: path, beforeBlob: beforeBlob as string, additions: 0, deletions: 0 });
        else list.push({ status: letter, before: path, after: path, beforeBlob: beforeBlob as string, afterBlob: afterBlob as string, additions: 0, deletions: 0 });
        index += 2;
        continue;
      }
      const numstat = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
      if (numstat !== null) {
        // The numstat lists the files of the raw output in the same order; a rename gives its two paths as the next tokens.
        const file = list[counted];
        if (file !== undefined) {
          file.additions = numstat[1] === '-' ? 0 : Number(numstat[1]);
          file.deletions = numstat[2] === '-' ? 0 : Number(numstat[2]);
        }
        counted += 1;
        index += numstat[3] === '' ? 3 : 1;
        continue;
      }
      index += 1;
    }
    files.set(sha, list);
  }
  return files;
}

/**
 * Read the hunks of a `git diff -U0 --full-index` output into a map, keyed by
 * the blobs before and after (`<before>..<after>`, as its `index` line names
 * them); a pair already in the map keeps its hunks. Only the `diff --git`,
 * `index` and `@@` lines are read: every line of the text a patch quotes
 * starts with ` `, `+`, `-` or `\`.
 */
function readHunksInto(output: string, hunks: Map<string, Hunk[]>, key?: string): void {
  let current: Hunk[] | undefined = key === undefined ? undefined : [];
  if (key !== undefined && current !== undefined) hunks.set(key, current);
  for (const line of output.split('\n')) {
    if (key === undefined && line.startsWith('diff --git ')) current = undefined;
    else if (key === undefined && line.startsWith('index ')) {
      const pair = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
      const found = pair === null ? undefined : `${pair[1]}..${pair[2]}`;
      current = found === undefined || hunks.has(found) ? undefined : [];
      if (found !== undefined && current !== undefined) hunks.set(found, current);
    } else if (current !== undefined && line.startsWith('@@ -')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk !== null) current.push({ oldStart: Number(hunk[1]), oldCount: hunk[2] === undefined ? 1 : Number(hunk[2]), newStart: Number(hunk[3]), newCount: hunk[4] === undefined ? 1 : Number(hunk[4]) });
    }
  }
}

/**
 * The hunks of some pairs of blobs (`<before>..<after>`): those of the patches
 * of the first-parent history under some paths, read at once, and each pair
 * that history did not show (a rename git paired otherwise there) diffed on
 * its own.
 */
function readHunks(repository: string, tip: string, paths: readonly string[], pairs: ReadonlySet<string>): Map<string, Hunk[]> {
  const hunks = new Map<string, Hunk[]>();
  const options = ['-U0', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv'];
  readHunksInto(gitText(repository, ['log', '--first-parent', '--diff-merges=first-parent', '-M', ...options, '--root', '--format=%x01%H', tip, '--', ...paths]), hunks);
  for (const pair of pairs) {
    if (hunks.has(pair)) continue;
    const [before, after] = pair.split('..') as [string, string];
    readHunksInto(gitText(repository, ['diff', ...options, before, after]), hunks, pair);
  }
  return hunks;
}

/** The texts of some blobs (`git cat-file --batch`), by sha; a blob git does not have is left out. */
function readBlobs(repository: string, blobs: readonly string[]): Map<string, string> {
  const texts = new Map<string, string>();
  if (blobs.length === 0) return texts;
  const output = gitBytes(repository, ['cat-file', '--batch'], `${blobs.join('\n')}\n`);
  for (let offset = 0; offset < output.length; ) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) break;
    const [sha, type, size] = output.toString('utf8', offset, newline).split(' ');
    offset = newline + 1;
    if (sha === undefined || type === undefined || size === undefined) continue;
    texts.set(sha, output.toString('utf8', offset, offset + Number(size)));
    offset += Number(size) + 1;
  }
  return texts;
}

/** The end (exclusive) of the balanced group that opens at `open`, or -1 (closeOf of packages/cli/src/extract/functions.ts). */
function closeOf(file: CodeText, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let index = open; index < file.source.length; index += 1) {
    if (file.code[index] !== 1) continue;
    const char = file.source[index];
    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** The next offset at or after `from` whose character is code and not whitespace (nextCode of packages/cli/src/extract/functions.ts). */
function nextCode(file: CodeText, from: number): number {
  for (let index = from; index < file.source.length; index += 1) {
    if (file.code[index] === 1 && !/\s/.test(file.source[index] as string)) return index;
  }
  return -1;
}

/**
 * The body of a function declaration whose name ends at `afterName`: its type
 * parameters and parameter list skipped, the first brace group outside any
 * `<...>` that no `{`, `|`, `&`, `[` or `)` follows (bodyOf of
 * packages/cli/src/extract/functions.ts); undefined for one without a body.
 */
function bodyOf(file: CodeText, afterName: number): { start: number; end: number } | undefined {
  let index = nextCode(file, afterName);
  if (index === -1) return undefined;
  if (file.source[index] === '<') {
    index = closeOf(file, index, '<', '>');
    if (index === -1) return undefined;
    index = nextCode(file, index);
  }
  if (index === -1 || file.source[index] !== '(') return undefined;
  index = closeOf(file, index, '(', ')');
  if (index === -1) return undefined;
  let angle = 0;
  for (; index < file.source.length; index += 1) {
    if (file.code[index] !== 1) continue;
    const char = file.source[index];
    if (char === ';') return undefined;
    if (char === '<') angle += 1;
    else if (char === '>' && file.source[index - 1] !== '=') angle = Math.max(0, angle - 1);
    else if (char === '{') {
      const end = closeOf(file, index, '{', '}');
      if (end === -1) return undefined;
      const next = nextCode(file, end);
      const nextChar = next === -1 ? '' : (file.source[next] as string);
      if (angle === 0 && (nextChar === '' || !'{|&[)'.includes(nextChar))) return { start: index, end };
      index = end - 1;
    }
  }
  return undefined;
}

/**
 * The offset of the JSDoc block whose end is right above `index` (only
 * whitespace between, or a `// eslint-disable-next-line` line), if any
 * (jsDocAbove of packages/cli/src/extract/functions.ts).
 */
function jsDocAbove(source: string, index: number): number | undefined {
  const disable = /\n[ \t]*\/\/ eslint-disable-next-line[^\n]*\n$/.exec(source.slice(0, index));
  let end = disable ? disable.index + 1 : index;
  while (end > 0 && /\s/.test(source[end - 1] as string)) end -= 1;
  if (!source.endsWith('*/', end)) return undefined;
  const start = source.lastIndexOf('/**', end - 2);
  if (start === -1) return undefined;
  // The block must be the one that ends here, not an earlier one.
  if (source.indexOf('*/', start + 3) !== end - 2) return undefined;
  return start;
}

/** The line (1-based) of an offset of a text, by the offsets its lines start at. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * The top-level functions of a text as the catalog finds them, by name in the
 * order of their first declaration: the lines each takes, from the JSDoc
 * above its first declaration (or the declaration) to the end of the body of
 * its last (or the line of a last declaration without a body).
 */
function functionSpans(source: string, codeMaskOf: (source: string) => Uint8Array): Map<string, Span> {
  const file: CodeText = { source, code: codeMaskOf(source) };
  const starts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1);
  const spans = new Map<string, Span>();
  for (const match of source.matchAll(DECLARATION)) {
    const index = match.index;
    if (file.code[index] !== 1) continue;
    const name = match[3] as string;
    const body = bodyOf(file, index + match[0].length);
    const end = lineAt(starts, body === undefined ? index : body.end - 1);
    const known = spans.get(name);
    if (known !== undefined) {
      known.end = end;
      continue;
    }
    spans.set(name, { start: lineAt(starts, jsDocAbove(source, index) ?? index), end });
  }
  return spans;
}

/** Whether a hunk removes a line of a span of the text before, or adds a line of a span of the text after. */
function touches(hunk: Hunk, before: Span, after: Span): boolean {
  const removes = hunk.oldCount > 0 && hunk.oldStart <= before.end && before.start <= hunk.oldStart + hunk.oldCount - 1;
  const adds = hunk.newCount > 0 && hunk.newStart <= after.end && after.start <= hunk.newStart + hunk.newCount - 1;
  return removes || adds;
}

/**
 * What a commit of the first-parent history is: the merge of a pull request
 * (its number, the branch after the owner, and the title GitHub writes as the
 * first line of the body), the squash of one (`title (#12)`), another merge,
 * or a commit pushed without one.
 */
function kindOf(commit: Commit): Pick<HistoryEntry, 'kind' | 'pr' | 'title' | 'branch'> {
  const merge = commit.parents.length >= 2 ? MERGE_SUBJECT.exec(commit.subject) : null;
  if (merge !== null) {
    const from = merge[2] as string;
    const slash = from.indexOf('/');
    const title = commit.body.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? commit.subject;
    return { kind: 'merge', pr: Number(merge[1]), title, branch: slash === -1 ? from : from.slice(slash + 1) };
  }
  // `Title (#12)`: a squash, or a merge whose message is the title of its pull request (GitHub's setting).
  const titled = SQUASH_SUBJECT.exec(commit.subject);
  if (titled !== null) return { kind: commit.parents.length >= 2 ? 'merge' : 'squash', pr: Number(titled[2]), title: (titled[1] as string).trim() };
  return { kind: commit.parents.length >= 2 ? 'merge' : 'direct', title: commit.subject };
}

/** A commit of a change as the history writes it. */
function commitOf(commit: Commit): HistoryCommit {
  return { sha: commit.sha, subject: commit.subject, date: commit.date, author: commit.author };
}

/** A file a change changed as the history writes it. */
function fileOf(change: FileChange): HistoryFile {
  const counts = { additions: change.additions, deletions: change.deletions };
  if (change.status === 'A') return { path: change.after as string, status: 'added', ...counts };
  if (change.status === 'D') return { path: change.before as string, status: 'deleted', ...counts };
  if (change.status === 'R') return { path: change.after as string, status: 'renamed', from: change.before as string, ...counts };
  return { path: change.after as string, status: 'modified', ...counts };
}

/**
 * The paths whose patches the hunks are read from: the directory of each root,
 * narrowed to its entries when it takes only some.
 */
function rootPaths(roots: readonly AnalysisRoot[]): string[] {
  return [...new Set(roots.flatMap((root) => root.include?.map((entry) => posix.join(root.directory, entry)) ?? [root.directory]))];
}

/** A file of a change with the module of the catalog's roots it was before and is after (absent outside the roots). */
interface RootFile {
  change: FileChange;
  before?: { root: string; module: string };
  after?: { root: string; module: string };
}

/** The files of a change that were or are in the roots of the catalog. */
function rootFilesOf(changes: readonly FileChange[], roots: readonly AnalysisRoot[]): RootFile[] {
  const files: RootFile[] = [];
  for (const change of changes) {
    const before = change.before === undefined ? undefined : moduleOf(roots, change.before);
    const after = change.after === undefined ? undefined : moduleOf(roots, change.after);
    if (before !== undefined || after !== undefined) files.push({ change, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
  }
  return files;
}

/** What the functions of the changes are read from: the texts of the blobs, their functions once read, and the hunks of each pair of blobs. */
interface Texts {
  texts: ReadonlyMap<string, string>;
  spans: Map<string, Map<string, Span>>;
  hunks: ReadonlyMap<string, Hunk[]>;
  codeMaskOf(source: string): Uint8Array;
}

/** The functions of a blob (functionSpans), read once; none for a blob git did not give. */
function spansOf(texts: Texts, blob: string | undefined): Map<string, Span> {
  if (blob === undefined) return new Map();
  let spans = texts.spans.get(blob);
  if (spans === undefined) {
    const text = texts.texts.get(blob);
    spans = text === undefined ? new Map<string, Span>() : functionSpans(text, texts.codeMaskOf);
    texts.spans.set(blob, spans);
  }
  return spans;
}

/** The functions a change added, modified or removed in the files of the roots (see the module comment), file by file, those of the text after first. */
function changedFunctions(files: readonly RootFile[], texts: Texts): HistoryFunction[] {
  const functions: HistoryFunction[] = [];
  for (const { change, before, after } of files) {
    const old = before === undefined ? new Map<string, Span>() : spansOf(texts, change.beforeBlob);
    const now = after === undefined ? new Map<string, Span>() : spansOf(texts, change.afterBlob);
    const hunks = texts.hunks.get(`${change.beforeBlob}..${change.afterBlob}`) ?? [];
    if (after !== undefined) {
      for (const [name, span] of now) {
        const was = old.get(name);
        if (was === undefined) functions.push({ id: `${after.root}:${after.module}#${name}`, name, status: 'added' });
        else if (hunks.some((hunk) => touches(hunk, was, span))) functions.push({ id: `${after.root}:${after.module}#${name}`, name, status: 'modified' });
      }
    }
    if (before !== undefined) {
      for (const name of old.keys()) if (!now.has(name)) functions.push({ id: `${before.root}:${before.module}#${name}`, name, status: 'removed' });
    }
  }
  return functions;
}

/** Give an entry what GitHub says of its pull request: the title (it replaces that of git), the body, and the branch when git did not tell it. */
function withPull(entry: HistoryEntry, pull: PullRequestInfo | undefined): HistoryEntry {
  if (pull === undefined) return entry;
  if (typeof pull.title === 'string' && pull.title.trim() !== '') entry.title = pull.title.trim();
  if (typeof pull.body === 'string' && pull.body.trim() !== '') entry.body = pull.body;
  if (entry.branch === undefined && typeof pull.head?.ref === 'string' && pull.head.ref !== '') entry.branch = pull.head.ref;
  return entry;
}

/** The function ids the entries touched → the indices of those entries, in the order of the entries (newest first). */
function functionIndex(entries: readonly HistoryEntry[]): Record<string, number[]> {
  const indexed = new Map<string, number[]>();
  entries.forEach((entry, position) => {
    for (const { id } of entry.functions) {
      const list = indexed.get(id) ?? [];
      if (list[list.length - 1] !== position) list.push(position);
      indexed.set(id, list);
    }
  });
  return Object.fromEntries([...indexed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Read the first-parent history of a revision (see the module comment). Throws when git cannot read it (not a git repository, an unknown revision). */
export function readHistory(options: HistoryOptions): HistoryData {
  const { repository, roots } = options;
  const tip = gitText(repository, ['rev-parse', '--verify', `${options.revision ?? 'HEAD'}^{commit}`]).trim();
  const shallow = gitText(repository, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  const boundaries = shallow ? shallowBoundaries(repository) : new Set<string>();
  const commits = readCommits(repository, tip);
  const chain = firstParents(tip, commits);
  const branches = branchCommits(chain, commits);
  const changes = readFiles(repository, tip);
  // git diffs the oldest commit of a shallow clone against nothing, as if it added the whole tree: what it changed is not known.
  for (const sha of boundaries) changes.delete(sha);

  // The files of the roots each change touched, and the texts and hunks they need, read at once.
  const rootFiles = new Map(chain.map((commit) => [commit.sha, rootFilesOf(changes.get(commit.sha) ?? [], roots)]));
  const blobs = new Set<string>();
  const pairs = new Set<string>();
  for (const { change, before, after } of [...rootFiles.values()].flat()) {
    if (before !== undefined) blobs.add(change.beforeBlob as string);
    if (after !== undefined) blobs.add(change.afterBlob as string);
    if (before !== undefined && after !== undefined && change.beforeBlob !== change.afterBlob) pairs.add(`${change.beforeBlob}..${change.afterBlob}`);
  }
  const texts: Texts = {
    texts: readBlobs(repository, [...blobs]),
    spans: new Map(),
    hunks: pairs.size === 0 ? new Map() : readHunks(repository, tip, rootPaths(roots), pairs),
    codeMaskOf: options.codeMaskOf,
  };

  const pulls = new Map((options.pulls ?? []).map((pull) => [pull.number, pull]));
  const entries = chain.map((commit) => {
    const { kind, pr, title, branch } = kindOf(commit);
    // A merge brings the commits of its branch; the history says who wrote them, or who merged when it brought none.
    const brought = kind === 'merge' && commit.parents.length >= 2 ? branches.get(commit.sha) : undefined;
    const own = brought === undefined ? [commit] : brought.own;
    const files = (changes.get(commit.sha) ?? []).map(fileOf);
    const entry: HistoryEntry = {
      commit: commit.sha,
      date: commit.date,
      kind,
      ...(pr === undefined ? {} : { pr }),
      title,
      ...(branch === undefined ? {} : { branch }),
      authors: [...new Set((own.length === 0 ? [commit] : own).map((one) => one.author))],
      commits: own.map(commitOf),
      files,
      functions: changedFunctions(rootFiles.get(commit.sha) ?? [], texts),
      notes: files.filter((file) => file.status !== 'deleted' && isNote(file.path)).map((file) => file.path),
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
    const carried = (brought?.carried ?? []).flatMap((inner) => {
      const { pr: number, title: innerTitle } = kindOf(inner);
      if (number === undefined || number === pr) return [];
      const pull = pulls.get(number);
      const body = typeof pull?.body === 'string' && pull.body.trim() !== '' ? pull.body : undefined;
      return [{ pr: number, title: typeof pull?.title === 'string' && pull.title.trim() !== '' ? pull.title.trim() : innerTitle, commit: inner.sha, ...(body === undefined ? {} : { body }) }];
    });
    if (carried.length > 0) entry.carried = carried;
    if (boundaries.has(commit.sha)) entry.boundary = true;
    return withPull(entry, pr === undefined ? undefined : pulls.get(pr));
  });
  return {
    version: 1,
    ...(options.github === undefined ? {} : { repository: options.github }),
    ...(shallow ? { shallow: true } : {}),
    entries,
    functions: functionIndex(entries),
  };
}

/**
 * owner/name of the url of a remote: the last two segments of its path,
 * `.git` left out (`https://github.com/o/r.git`, `git@github.com:o/r.git`, a
 * proxy's `http://proxy@127.0.0.1:1234/git/o/r`); undefined for a url
 * without a host (a local path) or with fewer segments.
 */
export function repositoryOfRemote(url: string): string | undefined {
  const trimmed = url.trim();
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(trimmed)?.[1] ?? /^[^/:]+:(?!\/\/)(.+)$/.exec(trimmed)?.[1];
  if (path === undefined) return undefined;
  const segments = path.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter((segment) => segment !== '');
  const [owner, name] = segments.slice(-2);
  if (owner === undefined || name === undefined || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return undefined;
  return `${owner}/${name}`;
}

/** owner/name of the remote `origin` of a repository (repositoryOfRemote); undefined when it has none or git fails. */
export function originRepository(repository: string): string | undefined {
  try {
    return repositoryOfRemote(gitText(repository, ['remote', 'get-url', 'origin']));
  } catch {
    return undefined;
  }
}
