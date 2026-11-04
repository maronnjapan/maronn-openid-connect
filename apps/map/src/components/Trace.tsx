import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { MapData, Selection, StepMark, TreeNode } from '../types';
import { allHunks, belowCounts, changeName, markOf, type ChangeIndex, type Mark } from '../lib/changes';
import { activeOf, frameDiagram, markOfBox, type DiagramNode } from '../lib/diagram';
import { childFrame, entryOf, findNode, frameIds, framesToChanges, type TraceState } from '../lib/trace';
import { locationOf } from '../lib/model';
import { Badge, DiffView } from './ChangeParts';
import { DetailDrawer } from './DetailDrawer';
import { FlowDiagram } from './FlowDiagram';
import { useMobileMenu } from './MobileMenu';
import { SelectionBar } from './SelectionBar';
import { TraceView } from './TraceView';
import { useFrames } from './useFrames';

export interface TraceProps {
  data: MapData;
  changes: ChangeIndex | undefined;
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
  /** Tabs of the side panel beside the diagram, the path diff and the detail. */
  tabs?: ReadonlyArray<{ id: string; label: string; content: ReactNode }>;
}

type Tab = 'diagram' | 'diff' | 'detail' | string;

/** The node selected: in which frame, and where the reader picked it (a box picked in the diagram scrolls its outline row into view). */
interface Selected {
  frame: string;
  node: TreeNode;
  frameId: string;
  from: 'outline' | 'diagram';
}

/** No step opened or folded by the reader. */
const NO_TOGGLES: ReadonlySet<string> = new Set();

/** The share of the width the pane beside the outline takes (percent): its default, its bounds, and where the reader's own is kept. */
const PANE_DEFAULT = 42;
const PANE_MIN = 20;
const PANE_MAX = 80;
const PANE_KEY = 'map.paneWidth';

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

/**
 * A trace (see lib/trace.ts): the ready-made choices, the outline, and
 * beside it the diagram of the frame in focus, the diff of the frames open
 * in the order they run, and the detail of the node selected. A narrow
 * screen shows the outline alone and opens the others over it.
 */
export function Trace({ data, changes, rootId, extraSelections = [], state, onState, enabled, onOpenFunction, onOpenCode, renderStep, tabs = [] }: TraceProps) {
  const { mobile } = useMobileMenu();
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'diagram');
  const [overlay, setOverlay] = useState(false);
  // The share of the width the pane takes, set by dragging the splitter (or its keys) and kept for this browser.
  const [paneWidth, setPaneWidth] = useState(readPaneWidth);
  const work = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  // The steps the reader opened or folded in the diagram, for the frame in focus only.
  const [toggled, setToggled] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: '', ids: NO_TOGGLES });
  // The node whose box the diagram brings into view, renewed by every selection and every step opened or folded.
  const [reveal, setReveal] = useState<{ frame: string; node: string; key: number } | null>(null);
  // What takes the keyboard focus once the diagram of a frame draws it, when the element the reader activated from the keyboard
  // went away: the box of a node (the heading of a step a row opened), or null for the diagram itself (a box that opened its call's frame).
  const [focusRequest, setFocusRequest] = useState<{ frame: string; node: string | null } | null>(null);
  // The trees load level by level: the frames a level opens are known once its tree is.
  const [ids, setIds] = useState<Map<string, string>>(() => new Map([['', rootId]]));
  const frames = useFrames(data, [...new Set([rootId, ...ids.values()])]);
  const known = useMemo(() => frameIds(rootId, state.open, frames.trees), [rootId, state.open, frames.trees]);
  if ([...known].some(([key, id]) => ids.get(key) !== id) || ids.size !== known.size) setIds(known);
  const root = frames.trees.get(rootId);
  const selections = useMemo(() => [...(frames.selections.get(rootId) ?? []).filter((selection) => selection.kind !== 'change'), ...extraSelections], [frames.selections, rootId, extraSelections]);
  const below = useMemo(() => belowCounts(changes, rootId).frames.filter((id) => id !== rootId).length, [changes, rootId]);
  const expand = changes === undefined ? undefined : () => onState({ ...state, open: [...new Set([...state.open, ...framesToChanges(data, changes.reach, rootId)])] });

  // The frame in focus for the diagram: the one the trace asks for (the frame of the row selected last, a call opened from
  // the diagram, the end of a ready-made choice), else the root.
  const focusKey = known.has(state.focus) ? state.focus : '';
  const focusId = known.get(focusKey) ?? rootId;
  const focusTree = frames.trees.get(focusId);
  const focusChange = frames.changes.get(focusId);
  const foldKey = `${focusId} ${focusKey}`;
  const toggledIds = toggled.key === foldKey ? toggled.ids : NO_TOGGLES;
  const diagram = useMemo(
    () =>
      focusTree === undefined
        ? undefined
        : frameDiagram(focusTree, focusKey, enabled, {
            changed: (id) => focusChange?.marks[id] !== undefined,
            hasFrame: (id) => (entryOf(data, id)?.frame ?? '') !== '',
            toggled: toggledIds,
          }),
    [focusTree, focusKey, enabled, focusChange, data, toggledIds],
  );
  const active = useMemo(() => (diagram === undefined || focusTree === undefined ? undefined : activeOf(diagram, focusTree, focusKey, state.choices, enabled)), [diagram, focusTree, focusKey, state.choices, enabled]);
  const marks = useMemo(() => {
    const byBox = new Map<string, Mark>();
    for (const box of diagram?.nodes ?? []) {
      const mark = markOfBox(box, focusChange, changes);
      if (mark !== undefined) byBox.set(box.id, mark);
    }
    return byBox;
  }, [diagram, focusChange, changes]);
  // The outline highlights the row that shows the node selected, and scrolls it into view when it was picked in the diagram.
  const outlineSelection = useMemo(() => (selected === null ? null : { frame: selected.frame, node: selected.node.id, reveal: selected.from === 'diagram' }), [selected]);

  /** Select a node, and bring its box into view in the diagram. */
  const select = (next: Selected) => {
    setSelected(next);
    setReveal((last) => ({ frame: next.frame, node: next.node.id, key: (last?.key ?? 0) + 1 }));
  };
  /** Open or fold a step of the frame in focus in place, and bring its box into view. */
  const toggleStep = (step: string) => {
    const ids = new Set(toggledIds);
    if (ids.has(step)) ids.delete(step);
    else ids.add(step);
    setToggled({ key: foldKey, ids });
    setReveal((last) => ({ frame: focusKey, node: step, key: (last?.key ?? 0) + 1 }));
  };
  /** Open a step from a row of the diagram that names it: the row goes away as the step opens, so the step's heading takes the keyboard focus. */
  const toggleStepFromRow = (step: string, keyboard: boolean) => {
    toggleStep(step);
    if (keyboard) setFocusRequest({ frame: focusKey, node: step });
  };
  /** Choosing a box of the diagram selects it: its outline row is highlighted and scrolled into view, and the diagram stays where it is. */
  const selectBox = (box: DiagramNode) => {
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

  // The diff of the frames open, in the order the trace runs them.
  const pathDiff = [...known].filter(([, id], index, list) => list.findIndex(([, other]) => other === id) === index).flatMap(([key, id]) => {
    const change = frames.changes.get(id);
    const hunks = allHunks(change);
    if (change === undefined || hunks.length === 0) return [];
    const entry = changes?.byId.get(id);
    return [{ key, id, change, hunks, entry }];
  });

  const detail = (): ReactNode => {
    if (selected === null) return <p className="note">アウトラインの行を選ぶと、ここに詳細を出します。</p>;
    const { node } = selected;
    if (node.kind === 'block' && node.step !== undefined && renderStep !== undefined) return renderStep(node.step);
    const callee = node.target?.kind === 'function' ? entryOf(data, node.target.id) : undefined;
    const member = node.target?.kind === 'member' ? data.members[node.target.id] : undefined;
    return (
      <section className="node-detail">
        <p className="mono">{node.code}</p>
        {node.text !== undefined ? <p>{node.text}</p> : null}
        <p className="where mono">
          {entryOf(data, selected.frameId)?.name ?? selected.frameId} · {node.lines[0]}–{node.lines[1]} 行目
        </p>
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
              {member.type}.{member.member}()
            </h4>
            <p>{member.summary || 'インターフェースのメンバー'}</p>
            <p className="where mono">{locationOf(member)}</p>
            {member.implementedBy !== undefined ? (
              <p className="note">
                実装: {member.implementedBy.map((id) => entryOf(data, id)?.name ?? id).join('、')}
              </p>
            ) : null}
          </>
        ) : null}
        {node.target?.kind === 'untraceable' ? <p className="note">型で呼び先を引けない呼び出しです（{node.target.why}）。</p> : null}
        {callee === undefined ? (
          <button type="button" className="code-button" onClick={() => onOpenCode(selected.frameId)}>
            このフレームのコードを見る
          </button>
        ) : null}
      </section>
    );
  };

  const panes: Array<{ id: Tab; label: string; content: ReactNode }> = [
    ...tabs,
    {
      id: 'diagram',
      label: '図',
      content:
        diagram !== undefined && active !== undefined ? (
          <div className="pane-diagram">
            <nav className="pane-note crumbs" aria-label="図に出しているフレーム">
              {crumbs.map((crumb, index) => (
                <span key={crumb.key || 'root'} className="crumb">
                  {index > 0 ? <span className="crumb-sep" aria-hidden="true">›</span> : null}
                  {index === crumbs.length - 1 ? (
                    <strong aria-current="location">{crumb.label}</strong>
                  ) : (
                    <button type="button" className="link" onClick={() => onState({ ...state, focus: crumb.key })} title="この関数の図に戻る">
                      {crumb.label}
                    </button>
                  )}
                </span>
              ))}
              <span className="note crumb-hint">青が選んだ道筋。箱に重ねると詳しく見られます。</span>
            </nav>
            <FlowDiagram
              diagram={diagram}
              active={active}
              selected={selected?.frame === focusKey ? selected.node.id : null}
              reveal={reveal?.frame === focusKey ? reveal : null}
              focus={focusRequest?.frame === focusKey ? focusRequest : null}
              label="フレームの図"
              marks={marks}
              onSelect={(box, keyboard) => (box.opens !== undefined ? openBox(box, keyboard) : box.step !== undefined && (box.step.open || box.step.toggles) ? toggleStep(box.step.id) : selectBox(box))}
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
      label: `経路の差分${pathDiff.length > 0 ? `（${pathDiff.length}）` : ''}`,
      content:
        pathDiff.length === 0 ? (
          <p className="note">開いているフレームに、このPRの差分はありません。{below > 0 ? '「変更まで展開」で、変わった関数まで開けます。' : ''}</p>
        ) : (
          <div className="path-diff">
            {pathDiff.map(({ key, id, hunks, entry }) => (
              <section key={key || 'root'}>
                <h4>
                  {entry !== undefined ? <Badge mark={markOf(entry.kind)} /> : null} {entry !== undefined ? changeName(data, entry) : (entryOf(data, id)?.name ?? id)}
                </h4>
                {entry?.summary.length ? <p className="note">{entry.summary.slice(0, 4).join(' / ')}</p> : null}
                <DiffView hunks={hunks} />
              </section>
            ))}
          </div>
        ),
    },
    { id: 'detail', label: '詳細', content: detail() },
  ];
  const current = panes.find((pane) => pane.id === tab) ?? panes[0];

  return (
    <div className="trace-area">
      <SelectionBar selections={selections} state={state} onState={onState} onExpandChanges={expand} changesBelow={below} />
      <div className={`work${mobile ? '' : ' with-pane'}`} ref={work} style={mobile ? undefined : { gridTemplateColumns: `minmax(0, 1fr) 8px minmax(0, ${paneWidth}%)` }}>
        <div className="outline">
          {root === undefined ? (
            <p className="note pad">{frames.failed.get(rootId) !== undefined ? `読み込めませんでした: ${frames.failed.get(rootId)}` : '読み込んでいます…'}</p>
          ) : (
            <TraceView
              data={data}
              changes={changes}
              rootId={rootId}
              state={state}
              trees={frames.trees}
              diffs={frames.changes}
              enabled={enabled}
              selected={outlineSelection}
              onState={onState}
              onSelect={(row) => {
                if (row === null) {
                  setSelected(null);
                  return;
                }
                select({ ...row, from: 'outline' });
                // The diagram follows the frame of the row selected, and shows where it is: the pane turns to the diagram.
                if (row.frame !== focusKey && known.has(row.frame)) onState({ ...state, focus: row.frame });
                setTab('diagram');
              }}
              onOpenFunction={onOpenFunction}
            />
          )}
        </div>
        {mobile ? (
          <>
            <div className="mobile-pane-buttons">
              {panes.map((pane) => (
                <button key={pane.id} type="button" className="code-button" onClick={() => { setTab(pane.id); setOverlay(true); }}>
                  {pane.label}
                </button>
              ))}
            </div>
            {overlay && current !== undefined ? (
              <DetailDrawer title={current.label} onClose={() => setOverlay(false)} className={current.id === 'diagram' ? 'pane-drawer diagram-drawer' : 'pane-drawer'}>
                {current.content}
              </DetailDrawer>
            ) : null}
          </>
        ) : (
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
          <aside className="pane" aria-label="図と詳細">
            <div className="seg pane-tabs" role="tablist">
              {panes.map((pane) => (
                <button key={pane.id} type="button" role="tab" aria-selected={pane.id === current?.id} aria-pressed={pane.id === current?.id} onClick={() => setTab(pane.id)}>
                  {pane.label}
                </button>
              ))}
            </div>
            <div className="pane-content">{current?.content}</div>
          </aside>
          </>
        )}
      </div>
    </div>
  );
}
