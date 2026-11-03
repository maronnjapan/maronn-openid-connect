import { useMemo, useState, type ReactNode } from 'react';
import type { MapData, Selection, StepMark, TreeNode } from '../types';
import { allHunks, belowCounts, changeName, frameMark, markOf, nodeMark, type ChangeIndex, type Mark } from '../lib/changes';
import { activeOf, frameDiagram } from '../lib/diagram';
import { entryOf, frameIds, framesToChanges, type TraceState } from '../lib/trace';
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
  const [selected, setSelected] = useState<{ key: string; frame: string; node: TreeNode; frameId: string } | null>(null);
  // The trees load level by level: the frames a level opens are known once its tree is.
  const [ids, setIds] = useState<Map<string, string>>(() => new Map([['', rootId]]));
  const frames = useFrames(data, [...new Set([rootId, ...ids.values()])]);
  const known = useMemo(() => frameIds(rootId, state.open, frames.trees), [rootId, state.open, frames.trees]);
  if ([...known].some(([key, id]) => ids.get(key) !== id) || ids.size !== known.size) setIds(known);
  const root = frames.trees.get(rootId);
  const selections = useMemo(() => [...(frames.selections.get(rootId) ?? []).filter((selection) => selection.kind !== 'change'), ...extraSelections], [frames.selections, rootId, extraSelections]);
  const below = useMemo(() => belowCounts(changes, rootId).frames.filter((id) => id !== rootId).length, [changes, rootId]);
  const expand = changes === undefined ? undefined : () => onState({ ...state, open: [...new Set([...state.open, ...framesToChanges(data, changes.reach, rootId)])] });

  // The frame in focus for the diagram: the one asked for, else the frame of the node selected, else the root.
  const focusKey = known.has(state.focus) ? state.focus : '';
  const focusId = known.get(focusKey) ?? rootId;
  const focusTree = frames.trees.get(focusId);
  const diagram = useMemo(() => (focusTree === undefined ? undefined : frameDiagram(focusTree, focusKey, enabled)), [focusTree, focusKey, enabled]);
  const active = useMemo(() => (diagram === undefined || focusTree === undefined ? undefined : activeOf(diagram, focusTree, focusKey, state.choices, enabled)), [diagram, focusTree, focusKey, state.choices, enabled]);
  const marks = useMemo(() => {
    const byBox = new Map<string, Mark>();
    const change = frames.changes.get(focusId);
    for (const box of diagram?.nodes ?? []) {
      if (box.node === undefined) continue;
      const mark = nodeMark(change, box.node) ?? (box.target !== undefined && 'fn' in box.target ? frameMark(changes, box.target.fn) : undefined);
      if (mark !== undefined) byBox.set(box.id, mark);
    }
    return byBox;
  }, [diagram, frames.changes, focusId, changes]);

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
            <p className="note pane-note">
              {focusKey === '' ? 'このトレースの根' : `${entryOf(data, focusId)?.name ?? focusId}() の中`}の流れ。青が選んだ道筋です。
              {focusKey !== '' ? (
                <button type="button" className="link" onClick={() => onState({ ...state, focus: '' })}>
                  根に戻る
                </button>
              ) : null}
            </p>
            <FlowDiagram diagram={diagram} active={active} selected={selected?.frame === focusKey ? selected.node.id : null} label="フレームの図" marks={marks} onSelect={(box) => {
              if (box.target !== undefined && 'fn' in box.target) {
                const node = box.node;
                const key = node === undefined ? undefined : focusKey === '' ? node : `${focusKey}.${node}`;
                if (key !== undefined) onState({ ...state, open: [...new Set([...state.open, key])], focus: key });
              }
            }} />
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
      <div className={`work${mobile ? '' : ' with-pane'}`}>
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
              selected={selected?.key ?? null}
              onState={onState}
              onSelect={(row) => {
                if (row === null) {
                  setSelected(null);
                  return;
                }
                setSelected({ ...row, key: `${row.frame}|${row.node.id}` });
                if (row.node.kind === 'block' || mobile) setTab('detail');
                if (mobile) setOverlay(true);
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
              <DetailDrawer title={current.label} onClose={() => setOverlay(false)} className="pane-drawer">
                {current.content}
              </DetailDrawer>
            ) : null}
          </>
        ) : (
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
        )}
      </div>
    </div>
  );
}
