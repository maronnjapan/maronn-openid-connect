/**
 * The changes of the pull request a map is built for, as the page shows
 * them: the badge of a frame, of a node of a tree and of an endpoint, the
 * changes a call leads to, the frames grouped by how they changed, the lines
 * of a hunk with their numbers, and the blocks of the text of a change note.
 * Nothing here touches the DOM.
 *
 * The badges are in the grey scale, so the three colors of the diagrams keep
 * their meaning (grey not on the chosen way, blue on it, red an error).
 */
import type { ChangeKind, DiffHunk, FlowEndpoint, FrameChange, FrameChangeEntry, MapChanges, MapData } from '../types';
import { changeReach, entryOf, type ChangeReach } from './trace';

/**
 * What a badge says: how a frame changed; `inside`, a function it calls (or
 * one further down) changed its code; `line`, the pull request changed this
 * node.
 */
export type MarkKind = ChangeKind | 'inside' | 'line';

export interface Mark {
  kind: MarkKind;
  /** The words of the badge. */
  label: string;
  /** What the badge means, for its tooltip. */
  title: string;
}

const MARKS: Record<MarkKind, Omit<Mark, 'kind'>> = {
  added: { label: '追加', title: 'このPRで足した' },
  modified: { label: '変更', title: 'このPRでコードを変えた' },
  moved: { label: '移動', title: 'このPRで別のファイルへ移した（コードは同じ）' },
  docs: { label: '説明', title: 'このPRで JSDoc だけ変えた' },
  removed: { label: '削除', title: 'このPRで消した' },
  noted: { label: 'メモ', title: 'コードは同じで、このPRの変更メモが説明している' },
  inside: { label: '下で変更', title: 'ここから呼ぶ関数（その先を含む）のコードを、このPRで変えた' },
  line: { label: '変更', title: 'このPRで変えたところ' },
};

/** Which badge wins where several apply: a change of the code before a change below it, before the others. */
const RANK: Record<MarkKind, number> = { added: 0, modified: 1, line: 1, inside: 2, moved: 3, docs: 4, noted: 5, removed: 6 };

/** The badge of a kind. */
export function markOf(kind: MarkKind): Mark {
  return { kind, ...MARKS[kind] };
}

/** Whether a badge says that code changed: the frame's own, one of its nodes, or below it. */
export function marksCode(mark: Mark): boolean {
  return RANK[mark.kind] <= RANK.inside;
}

/** The badge that wins among several (see RANK). */
export function strongest(marks: ReadonlyArray<Mark | undefined>): Mark | undefined {
  let best: Mark | undefined;
  for (const mark of marks) if (mark !== undefined && (best === undefined || RANK[mark.kind] < RANK[best.kind])) best = mark;
  return best;
}

/** Whether a kind changes what a frame does: its code is new or different. */
export function changesCode(kind: ChangeKind): boolean {
  return kind === 'added' || kind === 'modified';
}

/** The changes of a map, indexed for the page. */
export interface ChangeIndex {
  changes: MapChanges;
  /** The entry of each frame (a removed one under its id in the base). */
  byId: ReadonlyMap<string, FrameChangeEntry>;
  reach: ChangeReach;
}

/** The index of the changes of a map; undefined for a map without changes (main). */
export function indexChanges(data: MapData): ChangeIndex | undefined {
  const changes = data.changes;
  const reach = changeReach(data);
  if (changes === undefined || reach === undefined) return undefined;
  return { changes, byId: new Map(changes.frames.map((entry) => [entry.id, entry])), reach };
}

/** The badge of a frame: the change of its own code, else `inside` when a call of it leads to one, else its other change. */
export function frameMark(index: ChangeIndex | undefined, id: string): Mark | undefined {
  if (index === undefined) return undefined;
  const own = index.byId.get(id);
  if (own !== undefined && changesCode(own.kind)) return markOf(own.kind);
  if (index.reach.below(id).size > 0) return markOf('inside');
  return own === undefined ? undefined : markOf(own.kind);
}

/** The badge of an endpoint in the list: the badge of the frame its trace starts from. */
export function endpointMark(index: ChangeIndex | undefined, endpoint: Pick<FlowEndpoint, 'root'>): Mark | undefined {
  return frameMark(index, endpoint.root);
}

/** The badge of a node of a changed frame: added or modified by the diff. */
export function nodeMark(change: FrameChange | undefined, id: string): Mark | undefined {
  const mark = change?.marks[id];
  if (mark === undefined) return undefined;
  return mark === 'added' ? markOf('added') : markOf('line');
}

/** How many changes are below a call, by what they are, summed over the changed frames it leads to: `条件 +1、呼び出し +2`. */
export function belowCounts(index: ChangeIndex | undefined, id: string): { frames: string[]; counts: Record<string, number> } {
  if (index === undefined) return { frames: [], counts: {} };
  const frames = [...index.reach.below(id)];
  if (index.reach.changed.has(id)) frames.unshift(id);
  const counts: Record<string, number> = {};
  for (const frame of frames) for (const [key, value] of Object.entries(index.reach.changed.get(frame) ?? {})) counts[key] = (counts[key] ?? 0) + value;
  return { frames, counts };
}

/** The words of the counts of a change: `条件 +1、呼び出し 変更 2`. */
export function countWords(counts: Readonly<Record<string, number>>): string {
  const words: Record<string, string> = { call: '呼び出し', action: '処理', condition: '条件', loop: '繰り返し', try: '例外の捕捉', exit: '終わり', step: 'ステップ', signature: '宣言' };
  return Object.entries(counts)
    .map(([key, value]) => {
      const sign = key.slice(-1);
      return `${words[key.slice(0, -1)] ?? key.slice(0, -1)} ${sign === '~' ? '変更 ' : sign}${value}`;
    })
    .join('、');
}

/** The kinds in the order the page lists them, with the heading of each group. */
export const KIND_GROUPS: ReadonlyArray<{ kind: ChangeKind; heading: string }> = [
  { kind: 'added', heading: '足したもの' },
  { kind: 'modified', heading: 'コードを変えたもの' },
  { kind: 'moved', heading: '別のファイルへ移したもの' },
  { kind: 'docs', heading: 'JSDoc だけ変えたもの' },
  { kind: 'removed', heading: '消したもの' },
  { kind: 'noted', heading: '変更メモが説明するもの（コードは同じ）' },
];

/** The changed frames in groups of KIND_GROUPS (the empty ones left out), each by package, module and name. */
export function groupChanges(changes: MapChanges): Array<{ kind: ChangeKind; heading: string; frames: FrameChangeEntry[] }> {
  const order = (a: FrameChangeEntry, b: FrameChangeEntry) => compare(a.package, b.package) || compare(a.module, b.module) || compare(a.name, b.name);
  return KIND_GROUPS.map(({ kind, heading }) => ({ kind, heading, frames: changes.frames.filter((entry) => entry.kind === kind).sort(order) })).filter((group) => group.frames.length > 0);
}

/** The display name of a changed frame: `verifyClientSecret()`, or the endpoint of a body (`POST /token`). */
export function changeName(data: MapData, entry: FrameChangeEntry): string {
  if (entry.body === true) return data.bodies[entry.id]?.name ?? entry.name;
  return `${entry.name}()`;
}

/** Whether a frame has a file the page can open. */
export function hasFrame(data: MapData, id: string): boolean {
  const entry = entryOf(data, id);
  return entry !== undefined && entry.frame !== '';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A line of a hunk, with the line it is in the base (kept and removed lines) and in the head (kept and added lines). */
export interface NumberedLine {
  op: ' ' | '-' | '+';
  text: string;
  base?: number;
  head?: number;
}

/** The lines of a hunk with their numbers. */
export function numberHunk(hunk: DiffHunk): NumberedLine[] {
  let base = hunk.base;
  let head = hunk.head;
  return hunk.lines.map((line) => {
    const op = (line[0] === '-' || line[0] === '+' ? line[0] : ' ') as NumberedLine['op'];
    const text = line.slice(1);
    if (op === '-') return { op, text, base: base++ };
    if (op === '+') return { op, text, head: head++ };
    return { op, text, base: base++, head: head++ };
  });
}

/** How many lines some hunks add and remove. */
export function diffStat(hunks: readonly DiffHunk[] | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/** The hunks of a change in the order of their lines. */
export function allHunks(change: FrameChange | undefined): DiffHunk[] {
  return Object.values(change?.hunks ?? {})
    .flat()
    .sort((a, b) => a.head - b.head);
}

/** A block of the text of a change note. */
export type NoteBlock = { type: 'paragraph'; text: string } | { type: 'list'; items: string[] } | { type: 'code'; text: string };

/**
 * The blocks of the text of a note, read as the plain Markdown a note is
 * written in: paragraphs separated by blank lines (their line breaks kept,
 * as the repository writes a sentence a line), lists of `-` or `*` items
 * (a line indented under an item continues it), and fenced code.
 */
export function noteBlocks(text: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: string[] | undefined;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    if (list !== undefined) blocks.push({ type: 'list', items: list });
    paragraph = [];
    list = undefined;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      const fence = (/^\s*(```|~~~)/.exec(line) as RegExpExecArray)[1] as string;
      const code: string[] = [];
      for (index += 1; index < lines.length && !(lines[index] as string).trim().startsWith(fence); index += 1) code.push(lines[index] as string);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (paragraph.length > 0) flush();
      list ??= [];
      list.push(item[1] as string);
      continue;
    }
    if (list !== undefined && /^\s+\S/.test(line)) {
      list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`;
      continue;
    }
    if (list !== undefined) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** The parts of a line of a note: text, and the `code` between backticks. */
export function inlineParts(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const at = match.index as number;
    if (at > last) parts.push({ code: false, text: text.slice(last, at) });
    parts.push({ code: true, text: match[1] as string });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}
