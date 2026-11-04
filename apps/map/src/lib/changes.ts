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
import type { ChangeKind, DiffHunk, FlowEndpoint, FrameChange, FrameChangeEntry, MapChanges, MapData, MemberDoc, Reach, Selection } from '../types';
import { changeReach, entryOf, parentOf, type ChangeReach } from './trace';

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

/**
 * The index of the changes of a map, for the endpoints of a source (`hono`
 * or `nextjs`, see sourceOf): an implementation in an app root reaches only
 * that source's calls of its members. Undefined for a map without changes
 * (main).
 */
export function indexChanges(data: MapData, source?: string): ChangeIndex | undefined {
  const changes = data.changes;
  const reach = changeReach(data, source);
  if (changes === undefined || reach === undefined) return undefined;
  return { changes, byId: new Map(changes.frames.map((entry) => [entry.id, entry])), reach };
}

/** The badge of a frame or of a member of an interface: the change of its own code, else `inside` when a call of it (or an implementation of the member) leads to one, else its other change. */
export function frameMark(index: ChangeIndex | undefined, id: string): Mark | undefined {
  if (index === undefined) return undefined;
  const own = index.byId.get(id);
  if (own !== undefined && changesCode(own.kind)) return markOf(own.kind);
  if (index.reach.below(id).size > 0) return markOf('inside');
  return own === undefined ? undefined : markOf(own.kind);
}

/**
 * The badges of what one row of the outline or one box of the diagram shows
 * (the same rule for both): `own`, the strongest badge of its nodes the diff
 * of the frame marks; `calls`, the strongest badge of the frames and members
 * its calls reach (see frameMark); and `mark`, the stronger of the two.
 */
export function heldMarks(index: ChangeIndex | undefined, change: FrameChange | undefined, holds: readonly string[], calls: readonly string[]): { mark?: Mark; own?: Mark; calls?: Mark } {
  const own = strongest(holds.map((id) => nodeMark(change, id)));
  const reached = strongest(calls.map((id) => frameMark(index, id)));
  const mark = strongest([own, reached]);
  return { ...(mark === undefined ? {} : { mark }), ...(own === undefined ? {} : { own }), ...(reached === undefined ? {} : { calls: reached }) };
}

/** The changes below some calls together (see belowCounts): the changed frames they lead to, each once, and their counts summed (a frame some call reaches whole counts whole). */
export function callsBelow(index: ChangeIndex | undefined, calls: readonly string[]): { frames: string[]; counts: Record<string, number> } {
  if (index === undefined) return { frames: [], counts: {} };
  const parts = new Map<string, ReadonlySet<string> | undefined>();
  for (const id of calls) for (const [frame, part] of partsBelow(index, id)) parts.set(frame, mergePart(parts, frame, part));
  return { frames: [...parts.keys()], counts: sumCounts(index, parts) };
}

/** The changed frames below a call of a frame or a member with the part of each that matters there (ChangeReach.parts), the frame itself first (whole) when it changed. */
function partsBelow(index: ChangeIndex, id: string): Map<string, ReadonlySet<string> | undefined> {
  const parts = new Map<string, ReadonlySet<string> | undefined>();
  if (index.reach.changed.has(id)) parts.set(id, undefined);
  for (const [frame, part] of index.reach.parts(id)) parts.set(frame, mergePart(parts, frame, part));
  return parts;
}

/** The part of a frame that matters once one more way reaches it: whole when a way reaches it whole, else the members of every way. */
function mergePart(parts: ReadonlyMap<string, ReadonlySet<string> | undefined>, frame: string, part: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  if (!parts.has(frame)) return part;
  const known = parts.get(frame);
  return known === undefined || part === undefined ? undefined : new Set([...known, ...part]);
}

/**
 * The counts of the changes of some frames, each its part (see
 * ChangeReach.parts): the counts inside the implementations of its members
 * (FrameChangeEntry.memberCounts), or every change of the frame.
 */
function sumCounts(index: ChangeIndex, parts: ReadonlyMap<string, ReadonlySet<string> | undefined>): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (some: Readonly<Record<string, number>>) => {
    for (const [key, value] of Object.entries(some)) counts[key] = (counts[key] ?? 0) + value;
  };
  for (const [frame, part] of parts) {
    const whole = index.reach.changed.get(frame) ?? {};
    const byMember = index.byId.get(frame)?.memberCounts;
    if (part === undefined || byMember === undefined) add(whole);
    else for (const member of part) add(byMember[member] ?? whole);
  }
  return counts;
}

/** What the diff of a frame says about its start (its declaration): the phrases of its summary about it; empty when the start did not change. */
export function startWords(change: FrameChange | undefined): string[] {
  if (change?.marks[''] === undefined) return [];
  return change.summary.filter((line) => line.startsWith('宣言'));
}

/** The last line of the head a hunk takes (its kept and added lines). */
function hunkEnd(hunk: DiffHunk): number {
  return hunk.head + hunk.lines.filter((line) => !line.startsWith('-')).length - 1;
}

/** The hunks that touch some lines of the head (inclusive ranges). */
export function hunksWithin(hunks: readonly DiffHunk[], ranges: ReadonlyArray<readonly [number, number]>): DiffHunk[] {
  return hunks.filter((hunk) => ranges.some(([start, end]) => hunk.head <= end && hunkEnd(hunk) >= start));
}

/**
 * The changed frames below a member of an interface (see ChangeReach.parts),
 * each with the members whose implementation in it leads there: the member
 * itself and the members its implementations call, down the chain. The diff
 * of such a frame that matters to the member is the part inside those
 * members' lines; a frame they reach otherwise (a function an
 * implementation calls) matters whole (no members).
 */
export function memberChanges(index: ChangeIndex | undefined, member: string): Array<{ id: string; members: string[] }> {
  if (index === undefined) return [];
  return [...index.reach.parts(member)].map(([id, part]) => ({ id, members: [...(part ?? [])] }));
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

/**
 * How many changes are below a call of a frame or a member, by what they
 * are, summed over the changed frames it leads to (itself first, when it
 * changed): `条件 +1、呼び出し +2`. A frame reached through the
 * implementation of a member counts only the changes inside it (see
 * ChangeReach.parts).
 */
export function belowCounts(index: ChangeIndex | undefined, id: string): { frames: string[]; counts: Record<string, number> } {
  if (index === undefined) return { frames: [], counts: {} };
  const parts = partsBelow(index, id);
  return { frames: [...parts.keys()], counts: sumCounts(index, parts) };
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
export function changeName(data: Pick<MapData, 'bodies'>, entry: FrameChangeEntry): string {
  if (entry.body === true) return data.bodies[entry.id]?.name ?? entry.name;
  return `${entry.name}()`;
}

/**
 * The frames a way goes through in words, from its step down to the change:
 * the functions it calls on the way and, for a way that ends at a call of a
 * member of an interface (the change is an implementation of it), that
 * member, then the changed implementation with its root (`hono`, `nextjs`).
 */
export function wayLabel(data: MapData, entry: FrameChangeEntry, way: Pick<Reach, 'via' | 'target'>): string[] {
  const last = way.via[way.via.length - 1];
  if (last === undefined || last === entry.id) return [...way.via.slice(0, -1).map((id) => entryOf(data, id)?.name ?? id), changeName(data, entry)];
  // The way ends at a call of a member in the last frame: the call the target names, else one of the members the change implements.
  const sites = entryOf(data, last)?.sites ?? [];
  const at = parentOf(way.target)?.node;
  const callee = sites.find(([node]) => node === at)?.[1] ?? sites.find(([, called]) => (entry.members ?? []).includes(called))?.[1];
  const member: MemberDoc | undefined = callee === undefined ? undefined : data.members?.[callee];
  const names = way.via.map((id) => entryOf(data, id)?.name ?? id);
  const root = entry.id.slice(0, entry.id.indexOf(':'));
  const implementer = `${changeName(data, entry)}（${root}）`;
  if (member === undefined) return [...names, implementer];
  // A member whose implementation the change is not itself reaches it through what its implementations call.
  return [...names, `${member.type}.${member.member}`, ...((entry.members ?? []).includes(member.id) ? [] : ['…']), implementer];
}

/**
 * The ways of a change grouped by the change each leads to (Reach.label), in
 * the order each label first appears; the ways with no label (the frame
 * changed in one place, or the way stops at a call of a member whose
 * implementation leads to every change) in a group with no label.
 */
export function wayGroups(ways: readonly Reach[]): Array<{ label?: string; ways: Reach[] }> {
  const groups = new Map<string, Reach[]>();
  for (const way of ways) groups.set(way.label ?? '', [...(groups.get(way.label ?? '') ?? []), way]);
  return [...groups].map(([label, list]) => (label === '' ? { ways: list } : { label, ways: list }));
}

/** The name of the frame of a `try` that catches a failure on a way (Reach.caught): an endpoint body by its route, a function by its call. */
function catcherName(caught: NonNullable<Reach['caught']>): string {
  return caught.frame.startsWith('endpoint:') ? caught.name : `${caught.name}()`;
}

/** Where a new failure of a change is caught on a way, in words: the frame whose catch catches it and the call that answers; that it leaves the endpoint; undefined for a way that makes no new failure. */
export function catchWords(way: Pick<Reach, 'caught' | 'escapes'>): string | undefined {
  if (way.caught !== undefined) return `新しい失敗は ${catcherName(way.caught)} の catch で捕まえ${way.caught.call === undefined ? 'る' : `、\`${way.caught.call}\` が応答する`}`;
  return way.escapes === true ? '新しい失敗はどこでも捕まえずにエンドポイントの外へ出る' : undefined;
}

/**
 * Where the failures a change makes leave its frame are caught, over its
 * ways from the endpoints of a framework (every framework when none is
 * given): the call each catch answers with (`answer`), else the frame of
 * the catch (`frame`), or nothing (`escape`, the failure leaves the
 * endpoint), each with the endpoints of the ways, each endpoint once.
 */
export function failureCatchers(entry: Pick<FrameChangeEntry, 'reach'>, framework?: string): Array<{ kind: 'answer' | 'frame' | 'escape'; by?: string; endpoints: Array<{ endpoint: string; source: string }> }> {
  const groups = new Map<string, { kind: 'answer' | 'frame' | 'escape'; by?: string; endpoints: Array<{ endpoint: string; source: string }> }>();
  const seen = new Set<string>();
  for (const way of entry.reach) {
    if ((framework !== undefined && !way.frameworks.includes(framework)) || (way.caught === undefined && way.escapes !== true) || seen.has(`${way.source}:${way.endpoint}`)) continue;
    seen.add(`${way.source}:${way.endpoint}`);
    const group = way.caught === undefined ? { kind: 'escape' as const } : way.caught.call === undefined ? { kind: 'frame' as const, by: catcherName(way.caught) } : { kind: 'answer' as const, by: way.caught.call };
    const key = `${group.kind}:${group.by ?? ''}`;
    const known = groups.get(key) ?? { ...group, endpoints: [] };
    known.endpoints.push({ endpoint: way.endpoint, source: way.source });
    groups.set(key, known);
  }
  return [...groups.values()];
}

/**
 * The ways from an endpoint of a framework to the changes, as ready-made
 * choices (よく使う選択 › 変更に至る道筋): each named by the changed frame and
 * the label of the step it goes through (a step of a feature that is off
 * too, by the flow with every feature on), with the change it leads to as
 * its note (Reach.label, else the diff in a phrase). A way that
 * needs a feature that is off is left out: the trace does not show its
 * frames. Ways of one change that open the same frames and choose the same
 * sides are one choice, noting each change.
 */
export function waySelections(data: Pick<MapData, 'flows' | 'bodies'>, index: ChangeIndex | undefined, framework: string, endpoint: string, enabled: ReadonlySet<string>): Selection[] {
  if (index === undefined) return [];
  const steps = data.flows[framework]?.endpoints.find((candidate) => candidate.id === endpoint)?.steps ?? [];
  const selections: Selection[] = [];
  for (const entry of index.changes.frames) {
    const made = new Map<string, Selection>();
    for (const way of entry.reach) {
      if (way.endpoint !== endpoint || !way.frameworks.includes(framework) || !way.features.every((feature) => enabled.has(feature))) continue;
      // A way with no label of its own leads to every change of the frame (it stops at a call of a member whose implementation calls it).
      const note = way.label ?? (entry.summary.length > 1 ? `${entry.summary[0] ?? ''} ほか ${entry.summary.length - 1} 個` : (entry.summary[0] ?? ''));
      const key = `${way.frames.join(',')}|${JSON.stringify(Object.entries(way.decisions).sort(([a], [b]) => compare(a, b)))}`;
      const known = made.get(key);
      if (known !== undefined) {
        if (note !== '' && !(known.note ?? '').split(' / ').includes(note)) known.note = known.note === '' ? note : `${known.note} / ${note}`;
        continue;
      }
      const step = way.step === undefined ? undefined : (steps.find((candidate) => candidate.id === way.step)?.label ?? way.step);
      const selection: Selection = { kind: 'change', name: `${changeName(data, entry)}${step === undefined ? '' : `（${step} から）`}`, note, decisions: way.decisions, frames: way.frames, target: way.target };
      made.set(key, selection);
      selections.push(selection);
    }
  }
  return selections;
}

/**
 * How to narrow a heading that names more than one changed frame by a bare
 * name: by the roots, when the frames are under different ones
 * (`core:verifyClientSecret`), and always by the ids, which tell any two apart.
 */
export function narrowing(reference: string, matches: readonly string[]): { roots: string[]; ids: string[] } {
  const roots = [...new Set(matches.map((id) => id.slice(0, id.indexOf(':'))))];
  return { roots: roots.length === matches.length ? roots.map((root) => `${root}:${reference}`) : [], ids: [...matches] };
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
