import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { DiffHunk, MapData, Selection, StepMark, TreeNode } from '../types';
import { allHunks, belowCounts, changeName, frameMark, hunksWithin, markOf, memberChanges, type ChangeIndex, type Mark } from '../lib/changes';
import { activeOf, frameDiagram, markOfBox, type DiagramGroup, type DiagramNode } from '../lib/diagram';
import {
  changedIdsOf,
  childFrame,
  entryOf,
  findNode,
  foldsGuard,
  frameIds,
  frameOrder,
  framesToChanges,
  nodesBelow,
  parentOf,
  runsFor,
  shownFrame,
  sourceOf,
  stepCall,
  stepHolds,
  traceRows,
  withinFrame,
  type TraceState,
} from '../lib/trace';
import { locationOf } from '../lib/model';
import { Badge, ChangeDetail, DiffView, Inline } from './ChangeParts';
import { DetailDrawer } from './DetailDrawer';
import { FlowDiagram } from './FlowDiagram';
import { Chips, Description } from './Parts';
import { useMobileMenu } from './MobileMenu';
import { SelectionBar } from './SelectionBar';
import { rootedName, TraceView, type MemberDiff } from './TraceView';
import { useFrames } from './useFrames';

/** What a trace starts from, what it shows and what it tells the page (see Trace). */
export interface TraceProps {
  data: MapData;
  changes: ChangeIndex | undefined;
  /** The framework shown: its source (hono or nextjs) decides which implementations of a member run. */
  framework: string;
  /** The frame the trace starts from: an endpoint body or a function. */
  rootId: string;
  /** Ready-made choices beyond the root frame's own: the ways to the changes of the pull request. */
  extraSelections?: readonly Selection[];
  state: TraceState;
  onState: (next: TraceState) => void;
  /** The ids of the features that are on (the markers of the code name them the same way). */
  enabled: ReadonlySet<string>;
  onOpenFunction: (id: string) => void;
  /** Open the code drawer at a frame (its id). */
  onOpenCode: (id: string) => void;
  /** The detail of a step a block row is (the endpoint screen gives the step's facts). */
  renderStep?: (step: StepMark) => ReactNode;
  /** Tabs of the pane beside the diagram, the diff and the detail: each is drawn for the frame the diagram shows (its id), so the pane speaks of one thing. */
  tabs?: ReadonlyArray<{ id: string; label: string; content: (frameId: string) => ReactNode }>;
  /** A step of the root frame a link names (`#hono--token--select-signing-keys`): selected and shown once the tree loads. */
  step?: string | null;
  /** A node a link names, keyed like a decision (`<frame>.<node>`, the root's by the node alone): selected and shown once its frame loads. */
  target?: string | null;
}

type Tab = 'diagram' | 'diff' | 'detail' | string;

/** The node selected: in which frame, and where the reader picked it (a box picked in the diagram scrolls its outline row into view). */
interface Selected {
  frame: string;
  node: TreeNode;
  frameId: string;
  from: 'outline' | 'diagram';
}

/** The share of the width the pane beside the outline takes (percent): its default, its bounds, and where the reader's own is kept. */
const PANE_DEFAULT = 42;
const PANE_MIN = 20;
const PANE_MAX = 80;
const PANE_KEY = 'map.paneWidth';
const PANE_OPEN_KEY = 'map.paneOpen';

/** Keep the outline alone by default; restore a reader's choice to work with the pane beside it. */
function readPaneOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(PANE_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Where the reader's choice to show the code of every row is kept (a convenience of this browser only). */
const CODE_KEY = 'map.outline.code';

function readPaneWidth(): number {
  try {
    const saved = Number(globalThis.localStorage?.getItem(PANE_KEY));
    return Number.isFinite(saved) && saved >= PANE_MIN && saved <= PANE_MAX ? saved : PANE_DEFAULT;
  } catch {
    return PANE_DEFAULT;
  }
}

function writePaneWidth(value: number): void {
  try {
    globalThis.localStorage?.setItem(PANE_KEY, String(Math.round(value)));
  } catch {
    // Storage may be unavailable (a private window); the width then lasts for this page only.
  }
}

function readShowCode(): boolean {
  try {
    return globalThis.localStorage?.getItem(CODE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeShowCode(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(CODE_KEY, value ? '1' : '0');
  } catch {
    // Storage may be unavailable (a private window); the choice then lasts for this page only.
  }
}

/** A section of the diff tab: the diff of a frame, or the part of a changed frame a call of a member leads to, at the row the trace runs it. */
interface PathDiff {
  key: string;
  at: number;
  title: ReactNode;
  summary: string[];
  hunks: DiffHunk[];
  loading: boolean;
}

/**
 * A trace (see lib/trace.ts): the ready-made choices, the outline, and
 * beside it a pane whose tabs all speak of the frame the diagram shows (the
 * frame in focus): the diagram of that frame, the diff of that frame and of
 * the frames the outline opens below it in the order they run, the detail
 * of that frame (with no selection needed) and of the node selected in it,
 * and the tabs a page adds. The pane opens on request, starts on the diagram
 * and keeps the tab the reader picks: selecting a row moves it to that frame and
 * keeps the tab. The outline and the diagram fold the same steps the same
 * way (one set of the steps the reader opened or folded), and the pane
 * always speaks of a frame the outline shows. A narrow screen shows the
 * outline alone and opens the others over it.
 */
export function Trace({ data, changes, framework, rootId, extraSelections = [], state, onState, enabled, onOpenFunction, onOpenCode, renderStep, tabs = [], step = null, target = null }: TraceProps) {
  const { mobile } = useMobileMenu();
  const source = sourceOf(framework);
  const tabsId = useId();
  const [tab, setTab] = useState<Tab>('diagram');
  const [overlay, setOverlay] = useState(false);
  const [paneOpen, setPaneOpen] = useState(readPaneOpen);
  const paneToggle = useRef<HTMLButtonElement>(null);
  const paneVisible = !mobile && paneOpen;
  /** Show or hide the optional pane without changing the trace, its selection or its tab. */
  const togglePane = () => {
    if (mobile) {
      setOverlay(true);
      return;
    }
    const next = !paneOpen;
    setPaneOpen(next);
    try {
      globalThis.localStorage?.setItem(PANE_OPEN_KEY, next ? '1' : '0');
    } catch {
      // The pane still opens and closes when browser storage is unavailable.
    }
    if (!next) paneToggle.current?.focus();
  };
  useEffect(() => setOverlay(false), [mobile]);
  // The share of the width the pane takes, set by dragging the splitter (or its keys) and kept for this browser.
  const [paneWidth, setPaneWidth] = useState(readPaneWidth);
  const work = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  // The steps (and runs of statements) the reader opened or folded, by row key `<frame>|<node>`: the outline and the diagram read the same set.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [showCode, setShowCode] = useState(readShowCode);
  // The node whose box the diagram brings into view, renewed by every selection and every step opened or folded.
  const [reveal, setReveal] = useState<{ frame: string; node: string; key: number } | null>(null);
  // What takes the keyboard focus once the diagram of a frame draws it, when the element the reader activated from the keyboard
  // went away: the box of a node (the heading of a step a row opened), or null for the diagram itself (a box that opened its call's frame).
  const [focusRequest, setFocusRequest] = useState<{ frame: string; node: string | null } | null>(null);
  // A node to select once its frame shows: a step or a node a link names, the node a ready-made choice leads to.
  const [pending, setPending] = useState<{ step?: string; target?: string } | null>(() => (step !== null || target !== null ? { ...(step === null ? {} : { step }), ...(target === null ? {} : { target }) } : null));
  const asked = useRef(`${step ?? ''}|${target ?? ''}`);
  if (asked.current !== `${step ?? ''}|${target ?? ''}`) {
    asked.current = `${step ?? ''}|${target ?? ''}`;
    setPending(step !== null || target !== null ? { ...(step === null ? {} : { step }), ...(target === null ? {} : { target }) } : null);
  }
  // The trees load level by level: the frames a level opens are known once its tree is; the changed implementations of the members called load too.
  const [ids, setIds] = useState<Map<string, string>>(() => new Map([['', rootId]]));
  const [implementations, setImplementations] = useState<string>('');
  const frames = useFrames(data, [...new Set([rootId, ...ids.values(), ...(implementations === '' ? [] : implementations.split('\n'))])]);
  const known = useMemo(() => frameIds(rootId, state.open, frames.trees), [rootId, state.open, frames.trees]);
  if ([...known].some(([key, id]) => ids.get(key) !== id) || ids.size !== known.size) setIds(known);
  const hasFrame = useMemo(() => (id: string) => (entryOf(data, id)?.frame ?? '') !== '', [data]);
  const rows = useMemo(
    () => traceRows({ rootId, hasFrame, trees: frames.trees, changes: frames.changes, state, enabled, toggled, foldCode: !showCode }),
    [rootId, hasFrame, frames.trees, frames.changes, state, enabled, toggled, showCode],
  );
  // The frames the outline shows, by the row each starts at: the order the trace runs them.
  const order = useMemo(() => frameOrder(rows), [rows]);
  const loading = rows.some((row) => row.kind === 'loading');
  const root = frames.trees.get(rootId);
  const selections = useMemo(() => [...(frames.selections.get(rootId) ?? []).filter((selection) => selection.kind !== 'change'), ...extraSelections], [frames.selections, rootId, extraSelections]);
  const below = useMemo(() => belowCounts(changes, rootId).frames.filter((id) => id !== rootId).length, [changes, rootId]);
  const expand = changes === undefined ? undefined : () => onState({ ...state, open: [...new Set([...state.open, ...framesToChanges(data, changes.reach, rootId)])] });

  // The members the rows call, and the changed frames below each (an implementation, or what one calls), whose files the diffs of those rows read.
  const memberCalls = useMemo(() => [...new Set(rows.flatMap((row) => ('calls' in row ? row.calls : [])).filter((id) => data.members[id] !== undefined))], [rows, data]);
  const reachedByMembers = useMemo(() => new Map(memberCalls.map((member) => [member, memberChanges(changes, member)])), [memberCalls, changes]);
  const wanted = [...new Set([...reachedByMembers.values()].flatMap((list) => list.map((item) => item.id)))].sort().join('\n');
  if (wanted !== implementations) setImplementations(wanted);
  /** The parts of the diffs of the changed frames a call of a member leads to: within the lines of the members implemented on the way, else whole. */
  const memberDiff = (member: string): MemberDiff[] =>
    (reachedByMembers.get(member) ?? []).map(({ id, members }) => {
      const tree = frames.trees.get(id);
      const all = allHunks(frames.changes.get(id));
      const lines = (tree?.implements ?? []).filter((item) => members.includes(item.member)).map((item) => item.lines);
      const within = lines.length === 0 ? all : hunksWithin(all, lines);
      return { id, name: rootedName(data, id), hunks: within.length === 0 ? all : within, loading: tree === undefined && frames.failed.get(id) === undefined };
    });

  // The frame in focus for the diagram: the one the trace asks for (the frame of the row selected last, a call opened from
  // the diagram, the end of a ready-made choice) when the outline shows it, else the nearest frame above it that the outline shows.
  const focusKey = known.has(state.focus) && order.has(state.focus) ? state.focus : shownFrame(state.focus, order);
  // Once every frame has loaded, a frame the outline no longer shows (a feature turned off took its call out) gives the focus to the frame above it, in the hash too.
  useEffect(() => {
    if (!loading && root !== undefined && focusKey !== state.focus) onState({ ...state, focus: focusKey });
  }, [loading, root, focusKey, state, onState]);
  const focusId = known.get(focusKey) ?? rootId;
  const focusTree = frames.trees.get(focusId);
  const focusChange = frames.changes.get(focusId);
  const focusChangedIds = useMemo(() => changedIdsOf(focusChange), [focusChange]);
  const diagram = useMemo(() => {
    if (focusTree === undefined) return undefined;
    // The diagram folds by the outline's rules (see lib/trace.ts): a step open when it holds a change, an opened frame or a choice, flipped by the reader;
    // a step of one call drawn as that call; a guard on one line unless its true side calls a function with a frame.
    const options = {
      changed: (id: string) => focusChange?.marks[id] !== undefined,
      hasFrame,
      words: data,
      toggled: new Set([...toggled].filter((key) => key.startsWith(`${focusKey}|`)).map((key) => key.slice(focusKey.length + 1))),
      stepOpen: (node: TreeNode) => toggled.has(`${focusKey}|${node.id}`) !== stepHolds(focusKey, node, state, focusChangedIds),
      stepCall: (node: TreeNode) => stepCall(node, enabled, hasFrame),
      foldsGuard: (node: TreeNode) => foldsGuard(node, enabled, hasFrame, (id) => focusChangedIds.includes(id)),
    };
    return frameDiagram(focusTree, focusKey, enabled, options);
  }, [focusTree, focusKey, enabled, focusChange, data, toggled, hasFrame, state, focusChangedIds]);
  const active = useMemo(() => (diagram === undefined || focusTree === undefined ? undefined : activeOf(diagram, focusTree, focusKey, state.choices, enabled)), [diagram, focusTree, focusKey, state.choices, enabled]);
  const marks = useMemo(() => {
    const byBox = new Map<string, Mark>();
    for (const box of [...(diagram?.nodes ?? []), ...(diagram?.groups ?? [])]) {
      const mark = markOfBox(box, focusChange, changes);
      if (mark !== undefined) byBox.set(box.id, mark);
    }
    return byBox;
  }, [diagram, focusChange, changes]);

  // What is selected in the frame in focus: the node selected there, or, when the node is in a frame opened below it, the call
  // of the frame in focus that leads there (the breadcrumb went up); nothing when the diagram went into a frame below the node's.
  const shown = useMemo((): Selected | null => {
    if (selected === null) return null;
    if (selected.frame === focusKey) return selected;
    if (focusTree === undefined || !withinFrame(selected.frame, focusKey)) return null;
    let parent = parentOf(selected.frame);
    while (parent !== undefined && parent.frame !== focusKey) parent = parentOf(parent.frame);
    const node = parent === undefined ? undefined : findNode(focusTree.nodes, parent.node);
    return node === undefined ? null : { frame: focusKey, node, frameId: focusId, from: selected.from };
  }, [selected, focusKey, focusTree, focusId]);
  // The outline highlights the row that shows the node selected, and scrolls it into view when it was picked in the diagram.
  const outlineSelection = useMemo(() => (shown === null ? null : { frame: shown.frame, node: shown.node.id, reveal: shown.from === 'diagram' }), [shown]);

  /** Select a node, and bring its box into view in the diagram. */
  const select = (next: Selected) => {
    setSelected(next);
    setReveal((last) => ({ frame: next.frame, node: next.node.id, key: (last?.key ?? 0) + 1 }));
  };
  // Select what a link or a ready-made choice names once its frame shows; give up once everything has loaded without it.
  useEffect(() => {
    if (pending === null || root === undefined) return;
    if (pending.step !== undefined) {
      const block = nodesBelow(root.nodes, enabled).find((node) => node.kind === 'block' && node.step?.id === pending.step);
      if (block !== undefined) select({ frame: '', node: block, frameId: rootId, from: 'diagram' });
      setPending(pending.target === undefined ? null : { target: pending.target });
      return;
    }
    if (pending.target === undefined) {
      setPending(null);
      return;
    }
    const at = parentOf(pending.target);
    const frameKey = at?.frame ?? '';
    const tree = order.has(frameKey) ? frames.trees.get(known.get(frameKey) ?? '') : undefined;
    const node = tree === undefined || at === undefined ? undefined : findNode(tree.nodes, at.node);
    if (node !== undefined && tree !== undefined) {
      select({ frame: frameKey, node, frameId: tree.id, from: 'diagram' });
      setPending(null);
    } else if (!loading) setPending(null);
  }, [pending, root, enabled, order, frames.trees, known, loading, rootId]);

  /** Open or fold a step (or a run of statements) of a frame, by its row key, in the outline and the diagram at once. */
  const toggle = (key: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /** Open or fold a step of the frame in focus from the diagram, and bring its box into view. */
  const toggleStep = (step: string) => {
    toggle(`${focusKey}|${step}`);
    setReveal((last) => ({ frame: focusKey, node: step, key: (last?.key ?? 0) + 1 }));
  };
  /** Open a step from a row of the diagram that names it: the row goes away as the step opens, so the step's heading takes the keyboard focus. */
  const toggleStepFromRow = (step: string, keyboard: boolean) => {
    toggleStep(step);
    if (keyboard) setFocusRequest({ frame: focusKey, node: step });
  };
  /** Choosing a box of the diagram selects it: its outline row is highlighted and scrolled into view, and the diagram stays where it is. */
  const selectBox = (box: DiagramNode | DiagramGroup) => {
    const node = box.node === undefined || focusTree === undefined ? undefined : findNode(focusTree.nodes, box.node);
    if (node !== undefined) select({ frame: focusKey, node, frameId: focusId, from: 'diagram' });
  };
  /** Look inside the function of a box (the button of its card): the diagram moves to that frame, and the breadcrumb says where it is. */
  const openBox = (box: DiagramNode, keyboard: boolean) => {
    if (box.opens === undefined) return;
    const key = childFrame(focusKey, box.opens.node);
    // The card goes away with this diagram: the diagram of the frame it opens takes the keyboard focus once it shows.
    if (keyboard) setFocusRequest({ frame: key, node: null });
    onState({ ...state, open: [...new Set([...state.open, key])], focus: key });
  };

  /** Move the splitter to a pointer's x: the pane takes the width right of it. */
  const dragTo = (clientX: number) => {
    const rect = work.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return;
    setPaneWidth(Math.min(PANE_MAX, Math.max(PANE_MIN, ((rect.right - clientX) / rect.width) * 100)));
  };
  const onSplitterDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onSplitterMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) dragTo(event.clientX);
  };
  const onSplitterUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    writePaneWidth(paneWidth);
  };
  const onSplitterKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2;
    const next = event.key === 'ArrowLeft' ? paneWidth + step : event.key === 'ArrowRight' ? paneWidth - step : event.key === 'Home' ? PANE_MAX : event.key === 'End' ? PANE_MIN : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const clamped = Math.min(PANE_MAX, Math.max(PANE_MIN, next));
    setPaneWidth(clamped);
    writePaneWidth(clamped);
  };
  const resetPane = () => {
    setPaneWidth(PANE_DEFAULT);
    writePaneWidth(PANE_DEFAULT);
  };

  // Where the diagram is: the root, then the call of each frame opened on the way to the frame in focus.
  const crumbs = useMemo(() => {
    const keys = focusKey === '' ? [] : focusKey.split('.').map((_, index, parts) => parts.slice(0, index + 1).join('.'));
    const nameOf = (id: string | undefined) => {
      const entry = id === undefined ? undefined : entryOf(data, id);
      return entry === undefined ? (id ?? '') : 'endpoint' in entry ? entry.name : `${entry.name}()`;
    };
    return [{ key: '', label: nameOf(rootId) }, ...keys.map((key) => ({ key, label: nameOf(known.get(key)) }))];
  }, [focusKey, known, data, rootId]);
  // The crumbs between the root and the frame in focus fold into one `…` when they would not fit: all of them on a phone, all but the frame above the focus on a screen four deep or more.
  const keep = mobile ? 2 : 3;
  const folded = crumbs.length > keep ? crumbs.slice(1, mobile ? -1 : -2) : [];
  const more = useRef<HTMLDetailsElement>(null);
  const goTo = (key: string) => {
    if (more.current !== null) more.current.open = false;
    onState({ ...state, focus: key });
  };
  const crumb = (item: { key: string; label: string }, index: number, last: boolean) => (
    <span key={item.key || 'root'} className={`crumb${last ? ' current' : ''}${index === 0 ? ' root' : ''}`}>
      {index > 0 ? (
        <span className="crumb-sep" aria-hidden="true">
          ›
        </span>
      ) : null}
      {last ? (
        <strong aria-current="location" title={item.label}>
          {item.label}
        </strong>
      ) : (
        <button type="button" className="link" onClick={() => goTo(item.key)} title={`${item.label} の図に戻る`}>
          {item.label}
        </button>
      )}
    </span>
  );

  // The diff of the frame the diagram shows and of the frames the outline shows below it, in the order the trace runs them,
  // with the parts of the changed frames the calls of members lead to at the row of each call.
  const pathDiff: PathDiff[] = (() => {
    const sections: PathDiff[] = [];
    const seen = new Set<string>();
    for (const [key, at] of order) {
      const id = known.get(key);
      if (id === undefined || !withinFrame(key, focusKey) || seen.has(id)) continue;
      seen.add(id);
      const change = frames.changes.get(id);
      const hunks = allHunks(change);
      if (change === undefined || hunks.length === 0) continue;
      const entry = changes?.byId.get(id);
      sections.push({
        key,
        at,
        title: (
          <>
            {entry !== undefined ? <Badge mark={markOf(entry.kind)} /> : null} {entry !== undefined ? changeName(data, entry) : (entryOf(data, id)?.name ?? id)}
          </>
        ),
        summary: entry?.summary ?? change.summary,
        hunks,
        loading: false,
      });
    }
    rows.forEach((row, at) => {
      if (row.kind !== 'node' || !withinFrame(row.frame, focusKey)) return;
      for (const member of row.calls.filter((id) => data.members[id] !== undefined)) {
        const doc = data.members[member];
        for (const diff of memberDiff(member)) {
          if (seen.has(`${member}>${diff.id}`)) continue;
          seen.add(`${member}>${diff.id}`);
          const entry = changes?.byId.get(diff.id);
          sections.push({
            key: `${row.key}>${diff.id}`,
            at,
            title: (
              <>
                {entry !== undefined ? <Badge mark={markOf(entry.kind)} /> : null} {doc === undefined ? '' : `${doc.type}.${doc.member} の実装の先: `}
                {diff.name}
              </>
            ),
            summary: entry?.summary ?? [],
            hunks: diff.hunks,
            loading: diff.loading,
          });
        }
      }
    });
    return sections.sort((a, b) => a.at - b.at);
  })();

  /** What the pane says about a node of the frame the diagram shows: its code and words, and what it calls. */
  const nodeDetail = (node: TreeNode): ReactNode => {
    if (node.kind === 'block' && node.step !== undefined && renderStep !== undefined) return renderStep(node.step);
    const callee = node.target?.kind === 'function' ? entryOf(data, node.target.id) : undefined;
    const member = node.target?.kind === 'member' ? data.members[node.target.id] : undefined;
    const implementers = (member?.implementedBy ?? []).filter((id) => runsFor(id, source));
    return (
      <section className="node-detail" aria-label="選んだ行">
        <h4>選んだ行</h4>
        <p className="mono">{node.code}</p>
        {node.text !== undefined ? <p>{node.text}</p> : null}
        <p className="where mono">{node.lines[0]}–{node.lines[1]} 行目</p>
        {callee !== undefined ? (
          <>
            <h4>{callee.name}()</h4>
            <p>{callee.summary}</p>
            <p className="where mono">{locationOf(callee)}</p>
            <div className="detail-actions">
              <button type="button" className="code-button" onClick={() => onOpenCode(callee.id)}>
                コードを見る
              </button>
              <button type="button" className="code-button" onClick={() => onOpenFunction(callee.id)}>
                この関数を根にして開く
              </button>
            </div>
          </>
        ) : null}
        {member !== undefined ? (
          <>
            <h4>
              {member.type}.{member.member}() {frameMark(changes, member.id) !== undefined ? <Badge mark={frameMark(changes, member.id) as Mark} /> : null}
            </h4>
            <p>{member.summary || 'インターフェースのメンバー'}</p>
            <p className="where mono">{locationOf(member)}</p>
            {implementers.length > 0 ? (
              <ul className="plain implementers">
                {implementers.map((id) => {
                  const mark = frameMark(changes, id);
                  return (
                    <li key={id}>
                      実装: {data.functions[id] !== undefined ? (
                        <button type="button" className="link" onClick={() => onOpenFunction(id)}>
                          {rootedName(data, id)}
                        </button>
                      ) : (
                        rootedName(data, id)
                      )}{' '}
                      {mark !== undefined ? <Badge mark={mark} /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {memberDiff(member.id).map((diff) => (
              <div key={diff.id} className="member-diff">
                <p className="note">
                  {member.type}.{member.member} の実装の先で変えたところ: {diff.name}
                </p>
                {diff.loading ? <p className="note">読み込んでいます…</p> : <DiffView hunks={diff.hunks} />}
              </div>
            ))}
          </>
        ) : null}
        {node.target?.kind === 'untraceable' ? <p className="note">型で呼び先を引けない呼び出しです（{node.target.why}）。</p> : null}
      </section>
    );
  };

  /**
   * The detail of what the diagram shows: the frame (what it does, where it
   * is, how it fails, what the pull request did to it), and the node selected
   * in it, if any. It needs no selection: the pane always speaks of the frame
   * in the diagram.
   */
  const detail = (): ReactNode => {
    const entry = entryOf(data, focusId);
    const card = data.functions[focusId];
    const change = changes?.byId.get(focusId);
    const failures = [...new Set((entry?.failures ?? []).map((failure) => failure.error))];
    return (
      <div className="frame-detail">
        <section aria-label="図のフレーム">
          <h4>{entry === undefined ? focusId : 'endpoint' in entry ? entry.name : `${entry.name}()`}</h4>
          {card !== undefined ? <Description summary={card.summary} description={card.description} /> : entry?.summary ? <p>{entry.summary}</p> : null}
          <div className="facts-row">
            {entry !== undefined ? <span className="chip mono">{locationOf(entry)}</span> : null}
            {card?.spec ? <Chips items={card.spec} /> : null}
          </div>
          {failures.length > 0 ? (
            <p className="facts-row">
              失敗するとき <Chips items={failures.slice(0, 12)} />
            </p>
          ) : null}
          {change !== undefined ? <ChangeDetail change={change} hunks={allHunks(focusChange)} data={data} framework={framework} onOpenFunction={onOpenFunction} /> : null}
          <div className="detail-actions">
            <button type="button" className="code-button" onClick={() => onOpenCode(focusId)}>
              コードを見る
            </button>
            {card !== undefined && focusId !== rootId ? (
              <button type="button" className="code-button" onClick={() => onOpenFunction(focusId)}>
                この関数を根にして開く
              </button>
            ) : null}
          </div>
        </section>
        {shown !== null ? nodeDetail(shown.node) : <p className="note">アウトラインの行か図の箱を選ぶと、その行の詳細もここに出ます。</p>}
      </div>
    );
  };

  const panes: Array<{ id: Tab; label: string; content: ReactNode }> = [
    ...tabs.map((extra) => ({ id: extra.id, label: extra.label, content: extra.content(focusId) })),
    {
      id: 'diagram',
      label: '図',
      content:
        diagram !== undefined && active !== undefined ? (
          <div className="pane-diagram">
            <nav className="pane-note crumbs" aria-label="図に出しているフレーム">
              {folded.length === 0 ? (
                crumbs.map((item, index) => crumb(item, index, index === crumbs.length - 1))
              ) : (
                <>
                  {crumb(crumbs[0] as { key: string; label: string }, 0, false)}
                  <span className="crumb crumb-folded">
                    <span className="crumb-sep" aria-hidden="true">
                      ›
                    </span>
                    <details className="crumb-more" ref={more}>
                      <summary title={folded.map((item) => item.label).join(' › ')} aria-label={`間のフレーム ${folded.length} 個: ${folded.map((item) => item.label).join('、')}`}>
                        …
                      </summary>
                      <ul className="crumb-menu">
                        {folded.map((item) => (
                          <li key={item.key}>
                            <button type="button" className="link" onClick={() => goTo(item.key)}>
                              {item.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </span>
                  {crumbs.slice(1 + folded.length).map((item, index, rest) => crumb(item, 1 + folded.length + index, index === rest.length - 1))}
                </>
              )}
              {crumbs.length <= 2 ? <span className="note crumb-hint">青が選んだ道筋。箱に重ねる（タップする）と詳しく見られ、そこから中へ潜れます。</span> : null}
            </nav>
            <FlowDiagram
              diagram={diagram}
              active={active}
              selected={shown?.node.id ?? null}
              reveal={reveal?.frame === focusKey ? reveal : null}
              focus={focusRequest?.frame === focusKey ? focusRequest : null}
              label="フレームの図"
              marks={marks}
              onSelect={selectBox}
              onOpen={openBox}
              onToggleStep={toggleStepFromRow}
              onFocused={() => setFocusRequest(null)}
            />
          </div>
        ) : (
          <p className="note pad">読み込んでいます…</p>
        ),
    },
    {
      id: 'diff',
      label: `差分${pathDiff.length > 0 ? `（${pathDiff.length}）` : ''}`,
      content:
        pathDiff.length === 0 ? (
          <p className="note">図のフレームと、その下に開いているフレームに、このPRの差分はありません。{below > 0 ? '「変更まで展開」で、変わった関数まで開けます。' : ''}</p>
        ) : (
          <div className="path-diff">
            {pathDiff.map((section) => (
              <section key={section.key || 'root'}>
                <h4>{section.title}</h4>
                {section.summary.length > 0 ? (
                  <ul className="path-summary note">
                    {section.summary.slice(0, 4).map((line, index) => (
                      <li key={index}>
                        <Inline text={line} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {section.loading ? <p className="note">読み込んでいます…</p> : <DiffView hunks={section.hunks} />}
              </section>
            ))}
          </div>
        ),
    },
    { id: 'detail', label: '詳細', content: detail() },
  ];
  const current = panes.find((pane) => pane.id === tab) ?? panes[0];
  /** The tabs answer the arrow keys, Home and End, as a tablist does: the tab moved to is shown and takes the focus. */
  const onTabsKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = panes.findIndex((pane) => pane.id === current?.id);
    const next = event.key === 'ArrowRight' ? at + 1 : event.key === 'ArrowLeft' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? panes.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const pane = panes[(next + panes.length) % panes.length];
    if (pane === undefined) return;
    setTab(pane.id);
    document.getElementById(`${tabsId}-tab-${pane.id}`)?.focus();
  };

  const paneTabs = (
    <div className="pane-heading">
      <div className="seg pane-tabs" role="tablist" aria-label="図と詳細の切り替え" onKeyDown={onTabsKey}>
        {panes.map((pane) => (
          <button
            key={pane.id}
            id={`${tabsId}-tab-${pane.id}`}
            type="button"
            role="tab"
            aria-selected={pane.id === current?.id}
            aria-controls={`${tabsId}-panel`}
            tabIndex={pane.id === current?.id ? 0 : -1}
            onClick={() => setTab(pane.id)}
          >
            {pane.label}
          </button>
        ))}
      </div>
      {!mobile ? <button type="button" className="icon pane-close" aria-label="図と詳細を閉じる" onClick={togglePane}>×</button> : null}
    </div>
  );
  const paneContent = (
    <div className="pane-content" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-tab-${current?.id ?? 'diagram'}`} tabIndex={0}>
      {current?.content}
    </div>
  );

  return (
    <div className="trace-area">
      <div className={`work${paneVisible ? ' with-pane' : ' outline-only'}`} ref={work} style={paneVisible ? { gridTemplateColumns: `minmax(0, 1fr) 8px minmax(0, ${paneWidth}%)` } : undefined}>
        <div className="outline">
          {root === undefined ? (
            <p className="note pad">{frames.failed.get(rootId) !== undefined ? `読み込めませんでした: ${frames.failed.get(rootId)}` : '読み込んでいます…'}</p>
          ) : (
            <TraceView
              data={data}
              changes={changes}
              rootId={rootId}
              source={source}
              state={state}
              trees={frames.trees}
              diffs={frames.changes}
              enabled={enabled}
              rows={rows}
              onToggle={toggle}
              showCode={showCode}
              onShowCode={(code) => {
                setShowCode(code);
                writeShowCode(code);
              }}
              memberDiff={memberDiff}
              selected={outlineSelection}
              onState={onState}
              onSelect={(row) => {
                if (row === null) {
                  setSelected(null);
                  return;
                }
                select({ ...row, from: 'outline' });
                // The pane follows the frame of the row selected: the diagram shows where it is, the detail and the diff speak of it.
                if (row.frame !== focusKey && known.has(row.frame)) onState({ ...state, focus: row.frame });
              }}
              onOpenFunction={onOpenFunction}
              tools={
                <>
                  <SelectionBar selections={selections} state={state} onState={onState} onExpandChanges={expand} changesBelow={below} onPick={(selection) => setPending({ target: selection.target })} />
                  <button ref={paneToggle} type="button" className="code-button pane-toggle" aria-expanded={mobile ? overlay : paneOpen} aria-controls={`${tabsId}-pane`} onClick={togglePane}>
                    図・詳細
                  </button>
                </>
              }
            />
          )}
        </div>
        {mobile ? (
          <>
            {overlay && current !== undefined ? (
              <DetailDrawer title="図と詳細" onClose={() => setOverlay(false)} className={current.id === 'diagram' ? 'pane-drawer diagram-drawer' : 'pane-drawer'}>
                <div className="pane mobile-pane" id={`${tabsId}-pane`}>
                  {paneTabs}
                  {paneContent}
                </div>
              </DetailDrawer>
            ) : null}
          </>
        ) : paneVisible ? (
          <>
          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="アウトラインと図の幅（左右の矢印キーで変える。ダブルクリックで元に戻す）"
            aria-valuemin={PANE_MIN}
            aria-valuemax={PANE_MAX}
            aria-valuenow={Math.round(paneWidth)}
            aria-valuetext={`図の欄 ${Math.round(paneWidth)}%`}
            tabIndex={0}
            title="ドラッグで幅を変える（ダブルクリックで元に戻す）"
            onPointerDown={onSplitterDown}
            onPointerMove={onSplitterMove}
            onPointerUp={onSplitterUp}
            onPointerCancel={onSplitterUp}
            onDoubleClick={resetPane}
            onKeyDown={onSplitterKey}
          />
          <aside className="pane" id={`${tabsId}-pane`} aria-label="図と詳細" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); togglePane(); } }}>
            {paneTabs}
            {paneContent}
          </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}
