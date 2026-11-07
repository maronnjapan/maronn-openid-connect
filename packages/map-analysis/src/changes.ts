/**
 * The changes of a pull request, for its map: the frames (functions of the
 * catalog and endpoint bodies) it adds, rewrites, moves, documents or
 * removes, what it did to each node of their trees, where that takes effect,
 * and what its change notes say about why.
 *
 * The map is built from the working tree, so the changes are those of the
 * working tree since the commit it forked from the base (`git merge-base
 * <base> HEAD`): a pull request shows what it changes, not what its base
 * branch did since. In CI the working tree is the merge commit of the pull
 * request. The files the diff changes are read again as they are at the
 * fork point, laid over the working tree, so the trees before are built the
 * same way as the trees after.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Failure, FlowTree, FrameChange, FrameChangeEntry, MapChanges, Reach, TreeNode } from './model.js';
import { readRevision, type FrameInfo, type Revision } from './analyze.js';
import { countWords, diffTrees, markCounts, nodeWords, placeHunks } from './diff.js';
import { escapingFailures } from './failures.js';
import { CallGraph, reachOf, rootOf, type EndpointRoot } from './impact.js';
import { attachNotes, draftSections, isNote, NOTES_DIRECTORY, parseNote, type Named } from './notes.js';
import type { Repository } from './repository.js';
import { isTestPath, moduleOf } from './roots.js';
import type { BuiltTree } from './tree.js';
import { nodesOf } from './tree.js';
import { joinLines, shorten } from './words.js';

/** The order the kinds of a change are listed in, and their words. */
export const KIND_ORDER = ['added', 'modified', 'moved', 'docs', 'removed', 'noted'] as const;
export const KIND_WORDS: Record<(typeof KIND_ORDER)[number], string> = {
  added: '追加',
  modified: '変更',
  moved: '移動',
  docs: 'JSDoc だけ変更',
  removed: '削除',
  noted: 'メモだけ',
};

/** The lines of context a hunk keeps around the lines it changes. */
const CONTEXT = 3;
/** Beyond this many cells, the lines between the common start and end of two texts are taken as all removed and all added. */
const MAX_DIFF_CELLS = 4_000_000;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Run git in the repository and return what it printed; throws with its error output when it fails. */
export function git(repository: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stderr}`);
  return result.stdout;
}

/** A file `git diff --name-status` lists: its path before (absent for an added file) and after (absent for a deleted one). */
export interface ChangedFile {
  status: string;
  before?: string;
  after?: string;
}

/** The files `git diff --name-status -z --find-renames` lists; a copy counts as an added file. */
export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split('\0');
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index] ?? '';
    if (status === '') {
      index += 1;
      continue;
    }
    const letter = status[0] as string;
    if (letter === 'R' || letter === 'C') {
      const [before, after] = [fields[index + 1] as string, fields[index + 2] as string];
      files.push(letter === 'R' ? { status: letter, before, after } : { status: 'A', after });
      index += 3;
      continue;
    }
    const path = fields[index + 1] as string;
    if (letter === 'A') files.push({ status: letter, after: path });
    else if (letter === 'D') files.push({ status: letter, before: path });
    else files.push({ status: letter, before: path, after: path });
    index += 2;
  }
  return files;
}

/** The operations that turn the lines `a` into `b`: ` ` keeps a line, `-` removes line `a`, `+` adds line `b` (the longest common subsequence between their common start and end). */
export function diffLines(a: readonly string[], b: readonly string[]): Array<{ op: ' ' | '-' | '+'; a?: number; b?: number }> {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops: Array<{ op: ' ' | '-' | '+'; a?: number; b?: number }> = [];
  for (let index = 0; index < start; index += 1) ops.push({ op: ' ', a: index, b: index });
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_DIFF_CELLS) {
    for (let i = start; i < endA; i += 1) ops.push({ op: '-', a: i });
    for (let j = start; j < endB; j += 1) ops.push({ op: '+', b: j });
  } else {
    const width = m + 1;
    const common = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        common[i * width + j] = a[start + i] === b[start + j] ? (common[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ op: ' ', a: start + i, b: start + j });
        i += 1;
        j += 1;
      } else if ((common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0)) {
        ops.push({ op: '-', a: start + i });
        i += 1;
      } else {
        ops.push({ op: '+', b: start + j });
        j += 1;
      }
    }
    for (; i < n; i += 1) ops.push({ op: '-', a: start + i });
    for (; j < m; j += 1) ops.push({ op: '+', b: start + j });
  }
  for (let offset = 0; offset < a.length - endA; offset += 1) ops.push({ op: ' ', a: endA + offset, b: endB + offset });
  return ops;
}

/**
 * The operations of diffLines in hunks with up to `context` kept lines around
 * the changes, as the lines of a unified diff from a line of the base and of
 * the head; and the lines of the head the diff adds.
 */
export function hunksOf(
  ops: ReturnType<typeof diffLines>,
  a: readonly string[],
  b: readonly string[],
  baseLine: number,
  headLine: number,
  context = CONTEXT,
): { hunks: Array<{ base: number; head: number; lines: string[] }>; added: number[] } {
  const added: number[] = [];
  const ranges: Array<{ from: number; to: number }> = [];
  ops.forEach((op, index) => {
    if (op.op === ' ') return;
    if (op.op === '+') added.push(headLine + (op.b as number));
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  });
  const hunks = ranges.map(({ from, to }) => {
    let base = baseLine;
    let head = headLine;
    for (const op of ops.slice(0, from)) {
      if (op.op !== '+') base += 1;
      if (op.op !== '-') head += 1;
    }
    return { base, head, lines: ops.slice(from, to + 1).map((op) => `${op.op}${op.op === '+' ? b[op.b as number] : a[op.a as number]}`) };
  });
  return { hunks, added };
}

/** The lines of the head the operations of diffLines touch: each line they add, and the line before which they remove one. */
export function touchedLines(ops: ReturnType<typeof diffLines>, headLine: number): number[] {
  const lines: number[] = [];
  let next = 0;
  for (const op of ops) {
    if (op.op === '-') {
      lines.push(headLine + next);
      continue;
    }
    if (op.op === '+') lines.push(headLine + (op.b as number));
    next = (op.b as number) + 1;
  }
  return lines;
}

/** The name of a member in a summary: `AuthorizationCodeStorage.consume` of its id. */
function memberName(id: string): string {
  return id.slice(id.indexOf('#') + 1);
}

/** The pull request the map is built for, from MAP_PR, MAP_PR_TITLE and MAP_PR_URL; undefined without a number. */
export function pullRequestOf(env: Readonly<Record<string, string | undefined>>): MapChanges['pullRequest'] {
  const number = Number(env['MAP_PR']);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { number, ...(env['MAP_PR_TITLE'] ? { title: env['MAP_PR_TITLE'] } : {}), ...(env['MAP_PR_URL'] ? { url: env['MAP_PR_URL'] } : {}) };
}

export interface ChangeInput {
  repository: Repository;
  base: string;
  pullRequest?: MapChanges['pullRequest'];
  /** The failures that leave each frame of the working tree. */
  failures: ReadonlyMap<string, Failure[]>;
  /** Read a file of the working tree (the tests give their own). */
  read?: (path: string) => string;
}

export interface ChangeResult {
  changes: MapChanges;
  /** The diff of each changed frame, for its file (FrameFile.change), by its id (the base's for a removed one). */
  frames: Map<string, FrameChange>;
  /** The revision at the fork point, for its trees. */
  base: Revision;
  /** The commit the working tree forked from the base at (`git merge-base`). */
  forkPoint: string;
  /** Every file the working tree changed since the fork point, the untracked ones as added. */
  files: ChangedFile[];
}

/** The lines of a frame in its file: the JSDoc, the declaration up to the body, the rest. */
function partsOf(text: string, frame: FrameInfo, tree: FlowTree): { doc: string[]; head: string[]; code: string[]; all: string[] } {
  const lines = text.split('\n');
  const all = lines.slice(frame.start - 1, frame.end);
  const doc = lines.slice(frame.start - 1, frame.declaration - 1);
  const head = lines.slice(frame.declaration - 1, tree.head[1]);
  const code = lines.slice(frame.declaration - 1, frame.end);
  return { doc, head, code, all };
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** The name a frame is named by in a note: a function's name, or the endpoint of a body (`token`). */
function nameOf(frame: FrameInfo): string {
  return frame.kind === 'body' ? (frame.endpoint ?? frame.name) : frame.name;
}

/** The changes of the working tree since it forked from `base` (see the module comment). */
export function collectChanges(input: ChangeInput): ChangeResult {
  const { repository: repo, base } = input;
  const root = repo.repository;
  const run = (args: readonly string[]) => git(root, args);
  const read = input.read ?? ((path: string) => readFileSync(join(root, path), 'utf8'));
  const forkPoint = run(['merge-base', base, 'HEAD']).trim();
  const head = run(['rev-parse', 'HEAD']).trim();
  const files: ChangedFile[] = [
    ...parseNameStatus(run(['diff', '--name-status', '-z', '--find-renames', '--no-color', '--no-ext-diff', forkPoint])),
    ...run(['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter((path) => path !== '')
      .map((path): ChangedFile => ({ status: 'A', after: path })),
  ];
  const notes: Array<ReturnType<typeof parseNote> & { file: string }> = [];
  const overlay = new Map<string, string | null>();
  const baseModules = new Map<string, string[]>();
  const pairs: Array<{ before?: { root: string; module: string; text: string }; after?: { root: string; module: string; text: string } }> = [];
  let otherFiles = 0;
  let testFiles = 0;
  for (const file of files) {
    if (file.after !== undefined && isNote(file.after)) {
      notes.push({ file: file.after, ...parseNote(read(file.after)) });
      continue;
    }
    const before = file.before === undefined ? undefined : moduleOf(repo.roots, file.before);
    const after = file.after === undefined ? undefined : moduleOf(repo.roots, file.after);
    if (before === undefined && after === undefined) {
      const path = file.after ?? file.before;
      if (path !== undefined && isTestPath(path)) testFiles += 1;
      else if (file.before === undefined || !isNote(file.before)) otherFiles += 1;
      continue;
    }
    const pair: (typeof pairs)[number] = {};
    if (before !== undefined && file.before !== undefined) {
      const text = run(['show', `${forkPoint}:${file.before}`]);
      pair.before = { ...before, text };
      overlay.set(join(root, file.before), text);
      baseModules.set(before.root, [...(baseModules.get(before.root) ?? []), before.module]);
    }
    if (after !== undefined && file.after !== undefined) {
      pair.after = { ...after, text: read(file.after) };
      if (file.after !== file.before) overlay.set(join(root, file.after), null);
    }
    pairs.push(pair);
  }

  // The trees at the fork point of the files the diff changes.
  const baseRevision = readRevision({
    repository: root,
    roots: repo.roots,
    files: baseModules,
    endpoints: repo.endpoints,
    summaryOf: (id) => repo.cli.catalog[id]?.summary,
    stepOf: (id) => repo.steps.get(id),
    joinLines: repo.cli.joinLines,
    joinLinesFlat: repo.cli.joinLinesFlat,
    overlay,
  });

  const entries: FrameChangeEntry[] = [];
  const diffs = new Map<string, FrameChange>();
  /** The frames whose code changed but not their tree: comments or the layout only, which need no note. */
  const cosmetic = new Set<string>();
  const outside: MapChanges['outside'] = [];
  const framesOfFile = (revision: Revision, rootName: string, module: string) => [...revision.frames.values()].filter((frame) => frame.root === rootName && frame.module === module && frame.synthetic !== true);
  const entryOf = (frame: FrameInfo, kind: FrameChangeEntry['kind']): FrameChangeEntry => ({
    id: frame.id,
    name: nameOf(frame),
    package: frame.root,
    module: frame.module,
    line: frame.line,
    kind,
    ...(frame.kind === 'body' ? { body: true } : {}),
    summary: [],
    counts: {},
    reach: [],
    documented: false,
    required: false,
  });

  /** Compare one frame before and after; nothing when it did not change. */
  const compareFrame = (was: { frame: FrameInfo; built: BuiltTree; text: string }, now: { frame: FrameInfo; built: BuiltTree; text: string }) => {
    const a = partsOf(was.text, was.frame, was.built.tree);
    const b = partsOf(now.text, now.frame, now.built.tree);
    const code = !same(a.code, b.code);
    const docs = !same(a.doc, b.doc);
    const moved = was.frame.module !== now.frame.module;
    if (!code && !docs && !moved) return;
    const kind: FrameChangeEntry['kind'] = code ? 'modified' : moved ? 'moved' : 'docs';
    const entry = entryOf(now.frame, kind);
    if (moved) entry.from = was.frame.module;
    const ops = diffLines(a.all, b.all);
    const { hunks, added } = hunksOf(ops, a.all, b.all, was.frame.start, now.frame.start);
    entry.changedLines = added;
    // The members whose implementation the change touches, which name the node that holds them in the summary.
    const touched = touchedLines(ops, now.frame.start);
    const implementations = (now.built.tree.implements ?? []).filter((implementation) => touched.some((line) => line >= implementation.lines[0] && line <= implementation.lines[1]));
    const describe = (node: TreeNode) => {
      const inside = implementations.filter((implementation) => implementation.lines[0] >= node.lines[0] && implementation.lines[1] <= node.lines[1]);
      return inside.length === 0 ? undefined : `${[...new Set(inside.map((implementation) => `\`${memberName(implementation.member)}\``))].join('、')} の実装`;
    };
    const diff = code
      ? diffTrees(was.built.tree, now.built.tree, { before: was.built.own, after: now.built.own }, { signature: !same(a.head, b.head), docs }, { describe })
      : { marks: {}, removed: [], exprs: {}, summary: docs ? ['JSDoc だけ変えた'] : [`${was.frame.module} から移した（コードは同じ）`], counts: {} };
    if (code && Object.keys(diff.marks).length === 0 && diff.removed.length === 0) {
      cosmetic.add(now.frame.id);
      diff.summary.unshift('コメントや書き方だけを変えた（木は同じ）');
    }
    if (moved && code) diff.summary.unshift(`${was.frame.module} から移した`);
    entry.summary = diff.summary;
    entry.counts = diff.counts;
    const change: FrameChange = { kind, before: was.built.tree, marks: diff.marks, removed: diff.removed, exprs: diff.exprs, hunks: placeHunks(now.built.tree, hunks, diff.marks), summary: diff.summary };
    const members = implementations.map((implementation) => implementation.member);
    if (members.length > 0) entry.members = [...new Set(members)];
    if (code && members.length > 0) entry.memberCounts = memberCounts(now.built.tree, diff.marks, implementations, touched);
    entries.push(entry);
    diffs.set(now.frame.id, change);
  };

  const added: Array<{ frame: FrameInfo; built: BuiltTree; text: string }> = [];
  const removed: Array<{ frame: FrameInfo; built: BuiltTree; text: string }> = [];
  for (const pair of pairs) {
    const nowFrames = pair.after === undefined ? [] : framesOfFile(repo.head, pair.after.root, pair.after.module);
    const wasFrames = pair.before === undefined ? [] : framesOfFile(baseRevision, pair.before.root, pair.before.module);
    for (const frame of nowFrames) {
      const built = repo.head.trees.get(frame.id) as BuiltTree;
      const old = wasFrames.find((candidate) => nameOf(candidate) === nameOf(frame) && candidate.kind === frame.kind);
      if (old === undefined) {
        added.push({ frame, built, text: pair.after?.text ?? '' });
        continue;
      }
      compareFrame({ frame: old, built: baseRevision.trees.get(old.id) as BuiltTree, text: pair.before?.text ?? '' }, { frame, built, text: pair.after?.text ?? '' });
    }
    for (const frame of wasFrames) {
      if (!nowFrames.some((candidate) => nameOf(candidate) === nameOf(frame) && candidate.kind === frame.kind)) removed.push({ frame, built: baseRevision.trees.get(frame.id) as BuiltTree, text: pair.before?.text ?? '' });
    }
    // The changed lines outside every frame of the file (imports, types, constants).
    if (pair.after !== undefined) {
      const beforeLines = (pair.before?.text ?? '').split('\n');
      const afterLines = pair.after.text.split('\n');
      const { added: lines } = hunksOf(diffLines(pair.before === undefined ? [] : beforeLines, afterLines), beforeLines, afterLines, 1, 1, 0);
      const spans = nowFrames.map((frame) => [frame.start, frame.end] as const);
      const out = lines.filter((line) => !spans.some(([start, end]) => line >= start && line <= end) && (afterLines[line - 1] ?? '').trim() !== '');
      if (out.length > 0) outside.push({ file: `${pair.after.root}:${pair.after.module}`, lines: out });
    }
  }
  // A frame that leaves a file and arrives in another of the same root under the same name, the only one to, moved there.
  const keyOf = (item: { frame: FrameInfo }) => `${item.frame.root}:${item.frame.kind}:${nameOf(item.frame)}`;
  const count = (list: readonly { frame: FrameInfo }[], key: string) => list.filter((item) => keyOf(item) === key).length;
  const movedFrom = new Set<object>();
  for (const item of added) {
    const key = keyOf(item);
    const from = count(added, key) === 1 && count(removed, key) === 1 ? removed.find((candidate) => keyOf(candidate) === key) : undefined;
    if (from !== undefined) {
      movedFrom.add(from);
      compareFrame(from, item);
      continue;
    }
    const entry = entryOf(item.frame, 'added');
    const lines = item.text.split('\n');
    const all = lines.slice(item.frame.start - 1, item.frame.end);
    const { hunks, added: addedLines } = hunksOf(diffLines([], all), [], all, item.frame.start, item.frame.start);
    entry.changedLines = addedLines;
    entry.summary = [item.frame.kind === 'body' ? 'エンドポイントの処理を足した' : '関数を足した'];
    const marks: FrameChange['marks'] = {};
    for (const node of item.built.tree.nodes) marks[node.id] = 'added';
    const members = (item.built.tree.implements ?? []).map((implementation) => implementation.member);
    if (members.length > 0) entry.members = [...new Set(members)];
    entries.push(entry);
    diffs.set(item.frame.id, { kind: 'added', marks, removed: [], exprs: {}, hunks: placeHunks(item.built.tree, hunks, marks), summary: entry.summary });
  }
  for (const item of removed) {
    if (movedFrom.has(item)) continue;
    const entry = entryOf(item.frame, 'removed');
    entry.summary = [item.frame.kind === 'body' ? 'エンドポイントの処理を消した' : '関数を消した'];
    const lines = item.text.split('\n');
    const all = lines.slice(item.frame.start - 1, item.frame.end);
    const { hunks } = hunksOf(diffLines(all, []), all, [], item.frame.start, item.frame.start);
    entries.push(entry);
    diffs.set(item.frame.id, { kind: 'removed', before: item.built.tree, marks: {}, removed: [], exprs: {}, hunks: { '': hunks }, summary: entry.summary });
  }

  // How the failures that leave each changed frame changed: the base's computed over the trees of the working tree with the changed frames as they were.
  const baseTrees = new Map<string, FlowTree>([...repo.head.trees].map(([id, built]) => [id, built.tree]));
  for (const entry of entries) {
    if (entry.kind === 'added') baseTrees.delete(entry.id);
  }
  for (const [id, built] of baseRevision.trees) if (diffs.has(id) || entries.some((entry) => entry.id === id && entry.kind === 'removed')) baseTrees.set(id, built.tree);
  const baseFailures = escapingFailures(baseTrees);
  for (const entry of entries) {
    if (entry.kind !== 'modified') continue;
    const before = new Set((baseFailures.get(entry.id) ?? []).map((failure) => failure.error));
    const after = new Set((input.failures.get(entry.id) ?? []).map((failure) => failure.error));
    const gained = [...after].filter((error) => !before.has(error)).sort();
    const lost = [...before].filter((error) => !after.has(error)).sort();
    if (gained.length > 0) entry.failuresAdded = gained;
    if (lost.length > 0) entry.failuresRemoved = lost;
  }

  // Where each change takes effect.
  const trees = new Map<string, FlowTree>([...repo.head.trees].map(([id, built]) => [id, built.tree]));
  const roots: EndpointRoot[] = repo.endpoints.flatMap((source) =>
    source.endpoints.flatMap((endpoint) => {
      const rootId = repo.head.endpointRoots.get(`${source.source}:${endpoint.id}`);
      // The feature of an endpoint by its id (`device-authorization-grant`), as the markers of the blocks name theirs.
      const feature = endpoint.feature === undefined ? undefined : (repo.cli.featureIds[endpoint.feature] ?? endpoint.feature);
      return rootId === undefined ? [] : [{ source: source.source, frameworks: source.frameworks, endpoint: { id: endpoint.id, ...(feature === undefined ? {} : { feature }) }, root: rootId }];
    }),
  );
  const graph = new CallGraph(trees, roots);
  // The calls the types do not tell the target of that call a method, by the name they call.
  const untraceableSites: Array<{ frame: string; node: string; why: string; method: string }> = [];
  for (const [id, tree] of trees) {
    for (const node of nodesOf(tree.nodes)) {
      if (node.kind === 'call' && node.target?.kind === 'untraceable' && node.target.method !== undefined) untraceableSites.push({ frame: id, node: node.id, why: node.target.why, method: node.target.method });
    }
  }
  for (const entry of entries) {
    if (entry.kind === 'removed' || entry.kind === 'noted') continue;
    const change = diffs.get(entry.id);
    const tree = trees.get(entry.id);
    // A way to every place the frame changed (each changed node outside another, and where nodes were removed).
    const targets = change === undefined || tree === undefined ? [''] : changeTargets(tree, change);
    const labels = change === undefined || tree === undefined || targets.length < 2 ? new Map<string, string>() : targetLabels(tree, change, targets);
    const failures = (entry.failuresAdded ?? []).length > 0;
    const ways: Reach[] = [];
    for (const target of targets) {
      // A way that stops at the call of a member does not open the frame, so it leads to no place of it.
      const label = labels.get(target);
      for (const way of reachOf(graph, { frame: entry.id, node: target }, { failures })) ways.push(label === undefined || way.through !== undefined ? way : { ...way, label });
    }
    for (const member of entry.members ?? []) ways.push(...reachOf(graph, { member, root: rootOf(entry.id) }, { failures }));
    entry.reach = dedupeReach(ways);
    const untraceable = [...nodesOf(tree?.nodes ?? [])].filter((node) => node.target?.kind === 'untraceable').length;
    if (untraceable > 0) entry.untraceable = untraceable;
    // The calls the types do not tell that may call a member the change reaches through, outside the frames it is known to reach.
    const upstream = graph.upstream([entry.id, ...(entry.members ?? [])]);
    const names = new Set([...upstream].filter((id) => !trees.has(id)).map((id) => memberName(id).slice(memberName(id).lastIndexOf('.') + 1)));
    const callers = untraceableSites.filter((site) => names.has(site.method) && !upstream.has(site.frame)).map(({ frame, node, why }) => ({ frame, node, why }));
    if (callers.length > 0) entry.untraceableCallers = callers;
  }

  // The notes.
  notes.sort((a, b) => compare(a.file, b.file));
  const catalog: Named[] = Object.values(repo.cli.catalog).map((card) => ({ id: card.id, name: card.name, package: card.package, module: card.module }));
  const attached = attachNotes(entries, notes, catalog, (named) => ({
    id: named.id,
    name: named.name,
    package: named.package,
    module: named.module,
    line: repo.cli.catalog[named.id]?.line ?? 1,
    kind: 'noted',
    summary: [],
    counts: {},
    reach: [],
    documented: false,
    required: false,
  }));
  for (const entry of entries) {
    entry.required = (entry.kind === 'added' || entry.kind === 'modified') && !cosmetic.has(entry.id) && (entry.body === true || entry.reach.length > 0);
  }
  entries.sort((a, b) => compare(a.id, b.id));
  const changes: MapChanges = {
    base: { ref: base, commit: forkPoint },
    head: { commit: head, dirty: run(['status', '--porcelain']).trim() !== '' },
    notes: notes.map(({ file, title, summary }) => (title === undefined ? { file, summary } : { file, title, summary })),
    frames: entries,
    unmatched: attached.unmatched,
    unknown: attached.unknown,
    ambiguous: attached.ambiguous,
    undocumented: entries.filter((entry) => entry.required && !entry.documented).map((entry) => entry.id),
    outside,
    otherFiles,
    testFiles,
  };
  if (input.pullRequest !== undefined) changes.pullRequest = input.pullRequest;
  return { changes, frames: diffs, base: baseRevision, forkPoint, files };
}

/** Whether a node of a tree holds another (or is it). */
function holdsNode(node: TreeNode, id: string): boolean {
  if (node.id === id) return true;
  return (node.pre ?? []).some((child) => holdsNode(child, id)) || (node.branches ?? []).some((branch) => branch.nodes.some((child) => holdsNode(child, id)));
}

/**
 * The places of a tree a change is at, for the ways to it: '' for the start
 * (the declaration), each marked node that no marked node holds, and where
 * nodes were removed (the node they stood behind, else the node whose list
 * they were in, the start for the body when nothing else changed) unless a
 * place already holds it; with none of those (a comment changed), the first
 * node a hunk is on, else ''.
 */
export function changeTargets(tree: FlowTree, change: Pick<FrameChange, 'marks' | 'removed' | 'hunks'>): string[] {
  const targets: string[] = [];
  const marked: TreeNode[] = [];
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (change.marks[node.id] !== undefined) {
        marked.push(node);
        continue;
      }
      if (node.pre !== undefined) visit(node.pre);
      for (const branch of node.branches ?? []) visit(branch.nodes);
    }
  };
  visit(tree.nodes);
  targets.push(...marked.map((node) => node.id));
  for (const removed of change.removed) {
    const at = removed.after ?? removed.parent;
    if (at === '' || targets.includes(at) || marked.some((node) => holdsNode(node, at))) continue;
    targets.push(at);
  }
  if (change.marks[''] !== undefined || (targets.length === 0 && change.removed.length > 0)) targets.unshift('');
  if (targets.length > 0) return targets;
  return [Object.keys(change.hunks).find((id) => id !== '') ?? ''];
}

/**
 * The places of a change (changeTargets) in words, to tell the ways to them
 * apart: the start is what the summary says of the declaration (宣言 when
 * it says nothing); a node added, `… を足した`; a node changed, what
 * changed in it; where nodes were removed, `… を消した`. Two that read the
 * same get the line of their node.
 */
export function targetLabels(tree: FlowTree, change: Pick<FrameChange, 'marks' | 'removed' | 'exprs'> & Partial<Pick<FrameChange, 'summary'>>, targets: readonly string[]): Map<string, string> {
  const nodes = new Map([...nodesOf(tree.nodes)].map((node) => [node.id, node]));
  const labels = new Map<string, string>();
  for (const target of targets) {
    const node = nodes.get(target);
    if (node === undefined) {
      // The start: what the summary says of the declaration (`宣言を \`f(a)\` から \`f(a, b)\` に変えた`), else that it changed.
      labels.set(target, change.marks[''] !== undefined ? (change.summary?.find((line) => line.startsWith('宣言')) ?? '宣言') : '始め');
      continue;
    }
    const removed = change.removed.filter((entry) => (entry.after ?? entry.parent) === target);
    const exprs = change.exprs[target] ?? [];
    const mark = change.marks[target];
    labels.set(
      target,
      mark === 'added'
        ? `${nodeWords(node)} を足した`
        : mark === 'modified' && exprs.length > 0
          ? `${nodeWords(node)}: ${exprs.map((expr) => expr.text).join('、')}`
          : mark === undefined && removed.length > 0
            ? `${removed.map((entry) => nodeWords(entry.node)).join('、')} を消した`
            : nodeWords(node),
    );
  }
  const counts = new Map<string, number>();
  for (const label of labels.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  for (const [target, label] of labels) {
    const node = nodes.get(target);
    if ((counts.get(label) ?? 0) > 1 && node !== undefined) labels.set(target, `${label}（${node.lines[0]} 行目）`);
  }
  return labels;
}

/**
 * The counts of the changes inside the implementation of each member a
 * change touches (FrameChangeEntry.memberCounts): for each changed line in
 * its lines, the smallest node the diff marks that holds the line, each
 * node once (markCounts).
 */
export function memberCounts(
  tree: FlowTree,
  marks: FrameChange['marks'],
  implementations: ReadonlyArray<{ member: string; lines: readonly [number, number] }>,
  touched: readonly number[],
): Record<string, Record<string, number>> {
  const marked = [...nodesOf(tree.nodes)].filter((node) => marks[node.id] !== undefined);
  const holder = (line: number) =>
    marked.filter((node) => node.lines[0] <= line && line <= node.lines[1]).reduce<TreeNode | undefined>((best, node) => (best === undefined || node.lines[1] - node.lines[0] < best.lines[1] - best.lines[0] ? node : best), undefined);
  const held = new Map<string, Set<TreeNode>>();
  for (const implementation of implementations) {
    const nodes = held.get(implementation.member) ?? new Set<TreeNode>();
    held.set(implementation.member, nodes);
    for (const line of touched) {
      if (line < implementation.lines[0] || line > implementation.lines[1]) continue;
      const node = holder(line);
      if (node !== undefined) nodes.add(node);
    }
  }
  return Object.fromEntries([...held].map(([member, nodes]) => [member, markCounts(nodes, marks)]));
}

/** One way per endpoint, step and place of the change. */
function dedupeReach(ways: readonly Reach[]): Reach[] {
  const seen = new Set<string>();
  return ways.filter((way) => {
    const key = `${way.source}:${way.endpoint}:${way.step ?? ''}:${way.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Markdown, for the comment on the pull request and the summary of the run

/** A text for a cell of a Markdown table: no line breaks, no `|` that ends the cell. */
function cell(text: string): string {
  return joinLines(text).replace(/\|/g, '\\|');
}

/** The name of the endpoint of a way in the comment: `token`, `token (nextjs)`. */
function endpointWords(way: Reach): string {
  return `${way.endpoint}${way.source === 'hono' ? '' : ` (${way.source})`}`;
}

/**
 * The endpoints a change reaches, in a cell: `token, token (nextjs)`, each
 * with the features every way to it needs (`token（機能: refresh-token）`),
 * and the calls the types do not tell that may reach more.
 */
function reachWords(entry: FrameChangeEntry): string {
  const unknown = entry.untraceableCallers === undefined ? '' : `（追えない呼び出し ${entry.untraceableCallers.length} 箇所）`;
  if (entry.reach.length === 0) return `${entry.body === true ? '（エンドポイントそのもの）' : 'なし'}${unknown}`;
  const features = new Map<string, string[][]>();
  for (const way of entry.reach) features.set(endpointWords(way), [...(features.get(endpointWords(way)) ?? []), way.features]);
  const names = [...features].map(([name, lists]) => {
    const common = (lists[0] ?? []).filter((feature) => lists.every((list) => list.includes(feature)));
    return common.length === 0 ? name : `${name}（機能: ${common.join('、')}）`;
  });
  return `${names.length > 6 ? `${names.slice(0, 6).join(', ')} ほか ${names.length - 6}` : names.join(', ')}${unknown}`;
}

/** Where an entry is, in a cell. */
function placeWords(entry: FrameChangeEntry): string {
  return `${entry.package} ${entry.module}:${entry.line}`;
}

/** The name of an entry, in a cell. */
function nameWords(entry: FrameChangeEntry): string {
  return entry.body === true ? `\`${entry.name}\`（エンドポイントの処理）` : `\`${entry.name}()\``;
}

/** The failures that leave a frame now and did not before (+), and the other way (−), in words. */
function failureWords(entry: FrameChangeEntry): string {
  return [...(entry.failuresAdded ?? []).map((error) => `+\`${error}\``), ...(entry.failuresRemoved ?? []).map((error) => `−\`${error}\``)].join(' ');
}

/** A phrase cut to a width with its code spans closed (an odd backtick left open would run into the rest of the table). */
function cutPhrase(text: string, width: number): string {
  const cut = shorten(text, width);
  return (cut.match(/`/g) ?? []).length % 2 === 0 ? cut : `${cut}\``;
}

/** The summary of the diff, in a cell: the phrases that fit (whole), how many more, the counts, and the change of the failures that leave the frame. */
function summaryWords(entry: FrameChangeEntry): string {
  const shown: string[] = [];
  let length = 0;
  for (const phrase of entry.summary.slice(0, 3)) {
    if (shown.length > 0 && length + phrase.length > 180) break;
    shown.push(cutPhrase(phrase, 180));
    length += phrase.length;
  }
  const more = entry.summary.length > shown.length ? ` ほか ${entry.summary.length - shown.length}` : '';
  const counts = countWords(entry.counts);
  const failures = failureWords(entry);
  const text = `${shown.join(' / ')}${more}${counts === '' ? '' : `（${counts}）`}${failures === '' ? '' : ` / 外へ出る失敗 ${failures}`}`;
  return text.trim() === '' ? '—' : text;
}

/**
 * What the table cannot hold, one line an entry: where each failure the
 * change makes leave its frame is caught on the way from each endpoint (the
 * `try` of a frame on the way, or nothing: it leaves the endpoint), and the
 * calls the types do not tell that may reach the change.
 */
function effectLines(entries: readonly FrameChangeEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if ((entry.failuresAdded ?? []).length > 0) {
      // The endpoints by what catches the failure on the way from each: the call its catch answers with, else the frame of the catch, else nothing.
      const answers = new Map<string, string[]>();
      const frames = new Map<string, string[]>();
      const escapes: string[] = [];
      const seen = new Set<string>();
      for (const way of entry.reach) {
        const name = endpointWords(way);
        if (seen.has(name) || (way.caught === undefined && way.escapes !== true)) continue;
        seen.add(name);
        if (way.caught === undefined) escapes.push(name);
        else if (way.caught.call === undefined) frames.set(way.caught.name, [...(frames.get(way.caught.name) ?? []), name]);
        else answers.set(way.caught.call, [...(answers.get(way.caught.call) ?? []), name]);
      }
      const listed = (map: ReadonlyMap<string, string[]>) => [...map].map(([key, endpoints]) => `\`${key}\`（${endpoints.join('、')}）`).join('、');
      const where = [
        ...(answers.size === 0 ? [] : [`catch で捕まえて ${listed(answers)}が応答する`]),
        ...(frames.size === 0 ? [] : [`${listed(frames)}の catch で捕まる`]),
        ...(escapes.length === 0 ? [] : [`エンドポイントの外へ出る（${escapes.join('、')}）`]),
      ];
      lines.push(`- ${nameWords(entry)} から新しく外へ出る失敗 ${(entry.failuresAdded ?? []).map((error) => `\`${error}\``).join('、')}${where.length === 0 ? '' : `: ${where.join(' / ')}`}`);
    }
    if ((entry.failuresRemoved ?? []).length > 0) lines.push(`- ${nameWords(entry)} から外へ出なくなった失敗 ${(entry.failuresRemoved ?? []).map((error) => `\`${error}\``).join('、')}`);
    if (entry.untraceableCallers !== undefined) {
      const sites = entry.untraceableCallers.map((site) => `\`${site.frame.slice(site.frame.indexOf('#') + 1)}\`（${site.why}）`);
      lines.push(`- ${nameWords(entry)}: 型で呼び先を引けない呼び出し ${sites.length} 箇所が、この変更を呼んでいるかもしれません（届くエンドポイントには入れていません）: ${sites.slice(0, 6).join('、')}${sites.length > 6 ? ` ほか ${sites.length - 6}` : ''}`);
    }
  }
  return lines;
}

/** How to narrow a heading that names more than one change: by a root when the matches are in more than one, by the id otherwise. */
function narrowWords(warning: MapChanges['ambiguous'][number]): string {
  const roots = [...new Set(warning.matches.map(rootOf))];
  const ids = warning.matches.map((id) => `\`${id}\``).join(', ');
  return roots.length > 1
    ? `\`${roots[0]}:${warning.reference}\` のようにルートで絞り込むか、id を書いてください: ${ids}`
    : `どれも \`${roots[0] ?? ''}\` にあるので、id（見出しの末尾に \`<!-- id -->\`）で絞り込んでください: ${ids}`;
}

/**
 * The changes in Markdown (see the module comment): first the changes that
 * need a note and have none (and a draft of the sections to add), then the
 * notes, then every changed frame with its badge, place, automatic summary
 * (with the failures that leave it now or no more), the endpoints it reaches
 * (with the features they need) and the first line of its note, and under
 * the table where the new failures are caught and the calls the types do not
 * tell that may reach a change.
 */
export function changesMarkdown(changes: MapChanges, { limit = 40, sections = [] }: { limit?: number; sections?: readonly string[] } = {}): string {
  const lines: string[] = [];
  const missing = changes.frames.filter((entry) => (entry.kind === 'added' || entry.kind === 'modified') && !entry.documented);
  if (missing.length > 0) {
    const required = changes.undocumented.length;
    lines.push(`### 説明の無い変更（${missing.length}）`, '');
    lines.push(
      required > 0
        ? `このうち、エンドポイントに届く変更とエンドポイントの処理の変更 ${required} 個は変更メモ（\`${NOTES_DIRECTORY}/*.md\`）に説明が要ります。説明が無いと地図の検査が落ちます。`
        : 'どれも説明の要る変更ではない（エンドポイントに届かないか、コメントや書き方だけの変更）ので、検査は落ちません。',
      '',
      '| | 関数 | 場所 | 自動要約 | 届くエンドポイント |',
      '|---|---|---|---|---|',
    );
    for (const entry of missing.slice(0, limit)) {
      lines.push(`| ${entry.required ? '要説明' : KIND_WORDS[entry.kind]} | ${nameWords(entry)} | ${cell(placeWords(entry))} | ${cell(summaryWords(entry))} | ${cell(reachWords(entry))} |`);
    }
    if (missing.length > limit) lines.push('', `ほか ${missing.length - limit} 個は地図で見てください。`);
    const draft = draftSections(missing.filter((entry) => entry.required));
    if (draft !== '') {
      lines.push('', '<details><summary>変更メモに足す節の雛形（<code>pnpm --filter @maronn-openid-connect/map changes:draft</code> でも書けます）</summary>', '', '```md', draft.trimEnd(), '```', '', '</details>');
    }
    lines.push('');
  }
  const counted = changes.frames.filter((entry) => entry.kind !== 'noted');
  lines.push(`### このPRで変わった関数（${counted.length}）`, '');
  const counts = KIND_ORDER.map((kind) => [kind, changes.frames.filter((entry) => entry.kind === kind).length] as const).filter(([, n]) => n > 0);
  lines.push(counts.length > 0 ? counts.map(([kind, n]) => `${KIND_WORDS[kind]} ${n}`).join(' · ') : '地図に載る関数（関数カタログとエンドポイントの処理）の変更はありません。');
  for (const note of changes.notes) {
    const title = note.title === undefined ? '' : `**${note.title}** `;
    const summary = note.summary === '' ? '' : shorten(joinLines(note.summary.split(/\n\s*\n/)[0] ?? ''), 300);
    lines.push('', `> ${title}${summary}`.trimEnd(), `> — \`${note.file}\``);
  }
  if (changes.notes.length === 0) lines.push('', `変更メモ（\`${NOTES_DIRECTORY}/*.md\`）がありません。なぜ変えたかを書くと、地図とこのコメントに表示されます。`);
  for (const warning of changes.ambiguous) lines.push('', `- 見出し \`${warning.reference}\`（${warning.file}）は ${warning.matches.length} 個の変更に当たります。${narrowWords(warning)}`);
  for (const unknown of changes.unknown) lines.push('', `- 見出し \`${unknown.reference}\`（${unknown.file}）に当たる関数がありません。`);
  const ordered = [...changes.frames].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compare(a.id, b.id));
  const listed = ordered.filter((entry) => entry.kind !== 'docs' || entry.documented);
  if (listed.length > 0) {
    lines.push('', '| 札 | 関数 | 場所 | 自動要約 | 届くエンドポイント | メモ |', '|---|---|---|---|---|---|');
    for (const entry of listed.slice(0, limit)) {
      const note = entry.noteLine === undefined ? '説明なし' : shorten(entry.noteLine, 160);
      lines.push(`| ${KIND_WORDS[entry.kind]} | ${nameWords(entry)} | ${cell(placeWords(entry))} | ${cell(summaryWords(entry))} | ${cell(reachWords(entry))} | ${cell(note)} |`);
    }
    if (listed.length > limit) lines.push('', `ほか ${listed.length - limit} 個は地図で見てください。`);
    const effects = effectLines(listed.slice(0, limit));
    if (effects.length > 0) lines.push('', ...effects);
  }
  const folded = ordered.length - listed.length;
  if (folded > 0) lines.push('', `説明のない、JSDoc だけ変えた関数 ${folded} 個は表に入れていません（地図の「このPRの変更」にあります）。`);
  const outsideLines = changes.outside.reduce((sum, file) => sum + file.lines.length, 0);
  if (outsideLines > 0) lines.push('', `関数の外（import、型、定数など）の変更: ${changes.outside.map((file) => `\`${file.file}\` ${file.lines.length} 行`).join('、')}`);
  // The sections others add (the tests of packages/test-catalog), each in its own `###` heading.
  for (const section of sections) if (section.trim() !== '') lines.push('', section.trimEnd());
  return `${lines.join('\n')}\n`;
}

