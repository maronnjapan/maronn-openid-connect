/**
 * The changes of the pull request a map is built for, as the page shows them:
 * the badge of a step, of a box of the flow of a function and of an
 * endpoint, the changed functions a step or a function leads to, the
 * functions grouped by how they changed, the lines of a hunk with their
 * numbers, and the blocks of the text of a change note. Nothing here touches
 * the DOM.
 */
import type { ChangeKind, DiffHunk, FlowEndpoint, FlowStep, FunctionCard, FunctionChange, FunctionFlowNode, MapChanges, MapData } from '../types';
import { holdsFunction } from './model';

/**
 * What a badge says: how a function changed; `inside`, a function it calls
 * (or one further down) changed its code; or `line`, the pull request changed
 * this line of the function.
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
  added: { label: '追加', title: 'このPRで足した関数' },
  modified: { label: '変更', title: 'このPRでコードを変えた関数' },
  moved: { label: '移動', title: 'このPRで別のファイルへ移した関数（コードは同じ）' },
  docs: { label: '説明', title: 'このPRで JSDoc だけ変えた関数' },
  removed: { label: '削除', title: 'このPRで消した関数' },
  noted: { label: 'メモ', title: 'コードは同じで、このPRの変更メモが説明している関数' },
  inside: { label: '中で変更', title: 'ここから呼ぶ関数（その先を含む）のコードを、このPRで変えた' },
  line: { label: '変更', title: 'このPRで変えた行' },
};

/** Which badge wins where several apply: a change of the code before a change below it, before the others. */
const RANK: Record<MarkKind, number> = { added: 0, modified: 1, line: 1, inside: 2, moved: 3, docs: 4, noted: 5, removed: 6 };

/** The badge of a kind. */
export function markOf(kind: MarkKind): Mark {
  return { kind, ...MARKS[kind] };
}

/** Whether a badge says that code changed: the function's own, one of its lines, or below it. */
export function marksCode(mark: Mark): boolean {
  return RANK[mark.kind] <= RANK.inside;
}

/** The kinds in the order the page lists them, with the heading of each group. */
export const KIND_GROUPS: ReadonlyArray<{ kind: ChangeKind; heading: string }> = [
  { kind: 'added', heading: '足した関数' },
  { kind: 'modified', heading: 'コードを変えた関数' },
  { kind: 'moved', heading: '別のファイルへ移した関数' },
  { kind: 'docs', heading: 'JSDoc だけ変えた関数' },
  { kind: 'removed', heading: '消した関数' },
  { kind: 'noted', heading: '変更メモが説明する関数（コードは同じ）' },
];

/** Whether a kind changes what the function does: its code is new or different. */
export function changesCode(kind: ChangeKind): boolean {
  return kind === 'added' || kind === 'modified';
}

/** The changes of a map, indexed for the page. */
export interface ChangeIndex {
  changes: MapChanges;
  /** The change of each function of the head (a removed function has no card, so it is not here). */
  byId: ReadonlyMap<string, FunctionChange>;
  /** Whether the code of a function, or of a function it calls (and so on down), changed. */
  reaches(id: string): boolean;
}

/** The index of the changes of a map; undefined for a map without changes (main). */
export function indexChanges(data: MapData): ChangeIndex | undefined {
  const changes = data.changes;
  if (changes === undefined) return undefined;
  const byId = new Map(changes.functions.filter((change) => change.kind !== 'removed').map((change) => [change.id, change]));
  const memo = new Map<string, boolean>();
  const reaches = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    // A call back into a function being visited adds nothing.
    memo.set(id, false);
    const own = byId.get(id);
    const result = (own !== undefined && changesCode(own.kind)) || (data.functions[id]?.calls ?? []).some(reaches);
    memo.set(id, result);
    return result;
  };
  return { changes, byId, reaches };
}

/** The ids a step calls: those of the body of its function, or of its block of a Route Handler. */
function callsOfStep(data: MapData, step: FlowStep): readonly string[] {
  return step.functionId === undefined ? step.calls : (data.functions[step.functionId]?.calls ?? []);
}

/**
 * The badge of a step of an endpoint: the change of the code of its own
 * function; else `inside` when a function it calls leads to a change of
 * code; else the other change of its own function (moved, docs, noted).
 */
export function stepMark(index: ChangeIndex | undefined, data: MapData, step: FlowStep): Mark | undefined {
  if (index === undefined) return undefined;
  const own = step.functionId === undefined ? undefined : index.byId.get(step.functionId);
  if (own !== undefined && changesCode(own.kind)) return markOf(own.kind);
  if (callsOfStep(data, step).some((id) => index.reaches(id))) return markOf('inside');
  return own === undefined ? undefined : markOf(own.kind);
}

/**
 * The badge of a box of the flow of a function whose change is `change`:
 * `line` when the pull request changed the line of the box, or for the start
 * box a line of the declaration (from `declarationLine`, the line of the
 * card, down to the brace of the body: a parameter added, for one); a
 * function it added is new as a whole, so its boxes get none. Else, for a
 * call, `added` when the callee is a function the pull request added,
 * `inside` when the callee leads to a change of code.
 */
export function nodeMark(
  index: ChangeIndex | undefined,
  change: FunctionChange | undefined,
  node: FunctionFlowNode,
  declarationLine: number = node.line,
): Mark | undefined {
  if (index === undefined) return undefined;
  if (change?.kind === 'modified') {
    const from = node.kind === 'start' ? Math.min(declarationLine, node.line) : node.line;
    if (change.changedLines?.some((line) => line >= from && line <= node.line) === true) return markOf('line');
  }
  if (node.kind !== 'call' || node.callee === undefined) return undefined;
  if (index.byId.get(node.callee)?.kind === 'added') return markOf('added');
  return index.reaches(node.callee) ? markOf('inside') : undefined;
}

/**
 * The changed functions the own file of an endpoint holds (a Route Handler
 * of Next.js and the functions beside it, the pipeline.ts of Hono), by name.
 * Its blocks are not functions of their own, so a change there may show in
 * no step.
 */
export function changesInFile(index: ChangeIndex | undefined, endpoint: Pick<FlowEndpoint, 'module'>): FunctionChange[] {
  if (index === undefined) return [];
  return [...index.byId.values()].filter((change) => holdsFunction(endpoint, change)).sort((a, b) => compare(a.name, b.name));
}

/** The badge of an endpoint in the list: the strongest badge of its steps and of the changed functions of its own file. */
export function endpointMark(index: ChangeIndex | undefined, data: MapData, endpoint: FlowEndpoint): Mark | undefined {
  if (index === undefined) return undefined;
  return strongest([...endpoint.steps.map((step) => stepMark(index, data, step)), ...changesInFile(index, endpoint).map((change) => markOf(change.kind))]);
}

/** The badge that wins among several (see RANK). */
export function strongest(marks: ReadonlyArray<Mark | undefined>): Mark | undefined {
  let best: Mark | undefined;
  for (const mark of marks) {
    if (mark !== undefined && (best === undefined || RANK[mark.kind] < RANK[best.kind])) best = mark;
  }
  return best;
}

/** A changed function that a step or a function leads to, with the functions between them. */
export interface ReachedChange {
  change: FunctionChange;
  card: FunctionCard;
  /** The functions from the first call down to the changed one, that one left out. */
  via: FunctionCard[];
}

/**
 * The functions whose code changed among those the given ids lead to (the
 * ids themselves, the functions they call, and so on down to `maxDepth`),
 * each once by its shortest way, nearest first.
 */
export function changesBelow(index: ChangeIndex | undefined, data: MapData, calls: readonly string[], maxDepth = 8): ReachedChange[] {
  if (index === undefined) return [];
  const found: ReachedChange[] = [];
  const seen = new Set<string>();
  let frontier = calls.map((id) => ({ id, via: [] as FunctionCard[] }));
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: Array<{ id: string; via: FunctionCard[] }> = [];
    for (const item of frontier) {
      const card = data.functions[item.id];
      if (seen.has(item.id) || card === undefined) continue;
      seen.add(item.id);
      const change = index.byId.get(item.id);
      if (change !== undefined && changesCode(change.kind)) found.push({ change, card, via: item.via });
      for (const callee of card.calls) next.push({ id: callee, via: [...item.via, card] });
    }
    frontier = next;
  }
  return found;
}

/** The changes a step leads to through what it calls (its own function's change is shown apart). */
export function changesOfStep(index: ChangeIndex | undefined, data: MapData, step: FlowStep): ReachedChange[] {
  return changesBelow(index, data, callsOfStep(data, step));
}

/** The changed functions in groups of KIND_GROUPS (the empty ones left out), each group by package, module and name. */
export function groupChanges(changes: MapChanges): Array<{ kind: ChangeKind; heading: string; functions: FunctionChange[] }> {
  const order = (a: FunctionChange, b: FunctionChange) => compare(a.package, b.package) || compare(a.module, b.module) || compare(a.name, b.name);
  return KIND_GROUPS.map(({ kind, heading }) => ({ kind, heading, functions: changes.functions.filter((change) => change.kind === kind).sort(order) })).filter(
    (group) => group.functions.length > 0,
  );
}

/** Code-unit order, the same on every platform and locale. */
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

/** How many lines the hunks of a change add and remove. */
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
  const pattern = /`([^`]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index as number;
    if (at > last) parts.push({ code: false, text: text.slice(last, at) });
    parts.push({ code: true, text: match[1] as string });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}
