import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FlowTree, FrameChange, MapData, TreeNode } from '../types';
import { belowCounts, countWords, markOf, nodeMark, type ChangeIndex } from '../lib/changes';
import {
  branchesOf,
  catcherOf,
  childFrame,
  chosenSide,
  choose,
  decisionKey,
  entryOf,
  forcedSide,
  frameIds,
  isDecision,
  rowFor,
  traceRows,
  type Row,
  type TraceState,
} from '../lib/trace';
import { Badge, DiffView } from './ChangeParts';

export interface TraceViewProps {
  data: MapData;
  changes: ChangeIndex | undefined;
  rootId: string;
  state: TraceState;
  trees: ReadonlyMap<string, FlowTree>;
  diffs: ReadonlyMap<string, FrameChange>;
  enabled: ReadonlySet<string>;
  /**
   * The node selected, for the detail beside the outline: its frame and its
   * id, and whether it was picked in the diagram (its row then scrolls into view).
   * The row that shows it is highlighted: its own, or the folded row it is in.
   */
  selected: { frame: string; node: string; reveal: boolean } | null;
  onState: (next: TraceState) => void;
  onSelect: (row: { frame: string; node: TreeNode; frameId: string } | null) => void;
  onOpenFunction: (id: string) => void;
}

/** The words of the kind of a node, before its code. */
const KIND_WORDS: Partial<Record<TreeNode['kind'], string>> = {
  if: 'if',
  switch: 'switch',
  loop: '繰り返し',
  try: 'try',
  'cond-expr': '式の分岐',
  return: 'return',
  throw: 'throw',
  end: '終わり',
};

/** The frames opened under a key, the key itself included: closing a frame closes them too. */
function withoutFrame(open: readonly string[], key: string): string[] {
  return open.filter((candidate) => candidate !== key && !candidate.startsWith(`${key}.`));
}

/** The chips that choose a side of a decision: each side, chosen or not. */
function Sides({ node, frame, state, enabled, onState }: { node: TreeNode; frame: string; state: TraceState; enabled: ReadonlySet<string>; onState: (next: TraceState) => void }) {
  const key = decisionKey(frame, node.id);
  const forced = forcedSide(node, enabled);
  const chosen = forced ?? chosenSide(state.choices, key);
  const branches = branchesOf(node, enabled).filter((branch) => branch.always !== true);
  if (branches.length < 2 && forced === undefined) return null;
  return (
    <span className="sides" role="group" aria-label={`${node.subject ?? node.code} の進む側`}>
      {branches.map((branch) => (
        <button
          key={branch.key}
          type="button"
          className="side"
          aria-pressed={chosen === branch.key}
          disabled={forced !== undefined}
          title={forced !== undefined ? 'この側だけが残る（値を作る機能がオフ）' : chosen === branch.key ? '選択を外す' : 'この側を選ぶ'}
          onClick={() => onState({ ...state, choices: choose(state.choices, key, chosen === branch.key ? undefined : branch.key) })}
        >
          {branch.label}
        </button>
      ))}
    </span>
  );
}

/**
 * The trace as an outline: the tree of the root frame as indented rows, and
 * below a call the reader opens, the tree of its callee, indented one more.
 * A decision carries its sides as chips; the side not chosen folds to one
 * line, a guard (`if (!x) throw ...`) and an optional item read as one line,
 * a run of actions as one. In the map of a pull request, a changed node
 * carries its badge, its diff opens under it, a removed node shows struck
 * through, and a call that leads to changes says how many.
 */
export function TraceView({ data, changes, rootId, state, trees, diffs, enabled, selected, onState, onSelect, onOpenFunction }: TraceViewProps) {
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(() => new Set());
  const rows = useMemo(
    () => traceRows({ rootId, hasFrame: (id) => (entryOf(data, id)?.frame ?? '') !== '', trees, changes: diffs, state, enabled, unfolded }),
    [rootId, data, trees, diffs, state, enabled, unfolded],
  );
  const ids = useMemo(() => frameIds(rootId, state.open, trees), [rootId, state.open, trees]);
  const highlighted = selected === null ? undefined : rowFor(rows, selected.frame, selected.node);
  const list = useRef<HTMLOListElement>(null);
  // A box picked in the diagram brings its row into view; a row picked here is in view already.
  useEffect(() => {
    if (selected === null || !selected.reveal || highlighted === undefined) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])].find((item) => item.dataset.row === highlighted);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const indent = (depth: number) => ({ paddingLeft: `${8 + depth * 18}px` });

  const nodeRow = (row: Extract<Row, { kind: 'node' }>): ReactNode => {
    const { node, frame } = row;
    const frameId = ids.get(frame) ?? rootId;
    const change = diffs.get(frameId);
    const mark = nodeMark(change, node.id);
    const exprs = change?.exprs[node.id] ?? [];
    const hunks = change?.hunks[node.id] ?? [];
    const callee = node.target?.kind === 'function' ? node.target.id : undefined;
    const below = callee === undefined ? undefined : belowCounts(changes, callee);
    const child = childFrame(frame, node.id);
    const title = node.kind === 'block' ? node.step?.label ?? node.text ?? node.code : node.code;
    const words = node.kind === 'block' ? `[${node.step?.id ?? ''}]${node.step?.feature === undefined ? '' : ` 機能 ${node.step.feature}`}` : node.text;
    const member = node.target?.kind === 'member' ? data.members[node.target.id] : undefined;
    const catcher = state.errors && node.kind === 'call' ? catcherOf(trees, ids, frame, node.id) : undefined;
    const failures = state.errors && callee !== undefined ? (entryOf(data, callee)?.failures ?? []) : [];
    return (
      <li key={row.key} data-row={row.key} className={`trace-row kind-${node.kind}${row.on ? ' on' : ' off'}${row.before ? ' before' : ''}${highlighted === row.key ? ' selected' : ''}${mark !== undefined ? ' changed' : ''}`} style={indent(row.depth)}>
        <div className="trace-line">
          {row.frameState === 'closed' || row.frameState === 'open' || row.frameState === 'loading' ? (
            <button
              type="button"
              className="twisty"
              aria-expanded={row.frameState !== 'closed'}
              aria-label={row.frameState === 'closed' ? `${callee ?? ''} の中を開く` : '閉じる'}
              onClick={() => onState({ ...state, open: row.frameState === 'closed' ? [...state.open, child] : withoutFrame(state.open, child), focus: row.frameState === 'closed' ? state.focus : state.focus.startsWith(child) ? frame : state.focus })}
            >
              {row.frameState === 'closed' ? '▸' : '▾'}
            </button>
          ) : (
            <span className="twisty-space" aria-hidden="true" />
          )}
          {KIND_WORDS[node.kind] !== undefined && node.kind !== 'return' && node.kind !== 'throw' ? <span className="kind">{KIND_WORDS[node.kind]}</span> : null}
          <button type="button" className={`code-text${node.kind === 'block' ? ' step-title' : ' mono'}`} onClick={() => onSelect(selected?.frame === frame && selected.node === node.id ? null : { frame, node, frameId })} title={node.code}>
            {title}
          </button>
          {row.folded !== undefined && row.folded !== '' ? <span className="folded mono">{row.folded}</span> : null}
          {mark !== undefined ? <Badge mark={mark} /> : null}
          {below !== undefined && below.frames.length > 0 ? (
            <span className="below" title={below.frames.map((id) => entryOf(data, id)?.name ?? id).join('、')}>
              <Badge mark={markOf('inside')} /> {below.frames.length}
              {countWords(below.counts) === '' ? '' : `（${countWords(below.counts)}）`}
            </span>
          ) : null}
          {row.frameState === 'recursion' ? <span className="chip">再帰（ここで止める）</span> : null}
          {node.target?.kind === 'untraceable' ? <span className="chip" title={node.target.why}>追えない呼び出し</span> : null}
          {isDecision(node) ? <Sides node={node} frame={frame} state={state} enabled={enabled} onState={onState} /> : null}
          {callee !== undefined ? (
            <button type="button" className="open-page" onClick={() => onOpenFunction(callee)} title="この関数を根にしたトレース（関数のページ）を開く" aria-label={`${callee.slice(callee.indexOf('#') + 1)}() のページを開く`}>
              ↗
            </button>
          ) : null}
          {(node.form === 'guard' || node.form === 'optional') && row.folded !== undefined ? (
            <button type="button" className="link small" onClick={() => setUnfolded(toggle(unfolded, row.key))}>
              開く
            </button>
          ) : null}
          {hunks.length > 0 ? (
            <button type="button" className="link small" aria-expanded={openDiffs.has(row.key)} onClick={() => setOpenDiffs(toggle(openDiffs, row.key))}>
              差分
            </button>
          ) : null}
        </div>
        {words !== undefined && words !== '' && words !== title && !row.before ? <div className={`trace-words${node.kind === 'block' ? ' step-words' : node.from === 'comment' ? ' from-comment' : ''}`}>{words}</div> : null}
        {member !== undefined ? <div className="trace-words">{member.type}.{member.member}: {member.summary}</div> : null}
        {exprs.length > 0 ? (
          <ul className="exprs">
            {exprs.map((expr, index) => (
              <li key={index}>
                {expr.text}
                {expr.before !== undefined && expr.after !== undefined && expr.text === '式を書き換えた' ? (
                  <span className="mono">
                    {' '}
                    <del>{expr.before}</del> → <ins>{expr.after}</ins>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {state.errors && node.kind === 'call' ? (
          <div className="trace-failure">
            失敗すると → {catcher === undefined ? '捕まらずに外へ出る' : `${entryOf(data, catcher.id)?.name ?? catcher.id} の catch（${catcher.node.lines[0]} 行目〜）で捕まる`}
            {failures.length > 0 ? (
              <span className="muted">
                {' '}
                （{failures.slice(0, 4).map((failure) => `${failure.error}${failure.from === callee ? '' : `（${entryOf(data, failure.from)?.name ?? failure.from} から）`}`).join('、')}
                {failures.length > 4 ? ` ほか ${failures.length - 4}` : ''}）
              </span>
            ) : null}
          </div>
        ) : null}
        {openDiffs.has(row.key) ? <DiffView hunks={hunks} /> : null}
      </li>
    );
  };

  return (
    <ol className="trace" aria-label="処理の流れ" ref={list}>
      {rows.map((row) => {
        switch (row.kind) {
          case 'node':
            return nodeRow(row);
          case 'branch':
            return (
              <li key={row.key} data-row={row.key} className={`trace-row branch${row.on ? ' on' : ' off'}`} style={indent(row.depth)}>
                <div className="trace-line">
                  <span className="branch-label">{row.branch.label}</span>
                  {row.branch.toward !== undefined ? <span className="toward">→ {row.branch.toward}</span> : null}
                  {row.folded !== undefined ? (
                    <>
                      <span className="folded">{row.folded}</span>
                      <button type="button" className="link small" onClick={() => setUnfolded(toggle(unfolded, row.key))}>
                        開く
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          case 'actions':
            return (
              <li key={row.key} data-row={row.key} className={`trace-row kind-action${row.on ? ' on' : ' off'}${highlighted === row.key ? ' selected' : ''}`} style={indent(row.depth)}>
                <div className="trace-line">
                  <span className="twisty-space" aria-hidden="true" />
                  <span className="kind">処理 ×{row.nodes.length}</span>
                  <span className="folded mono">{row.nodes.map((item) => item.code).join(' / ')}</span>
                  <button type="button" className="link small" onClick={() => setUnfolded(toggle(unfolded, row.key))}>
                    開く
                  </button>
                </div>
              </li>
            );
          case 'removed':
            return (
              <li key={row.key} data-row={row.key} className="trace-row removed" style={indent(row.depth)}>
                <div className="trace-line">
                  <span className="twisty-space" aria-hidden="true" />
                  <Badge mark={markOf('removed')} />
                  <del className="mono">{row.node.code}</del>
                </div>
              </li>
            );
          case 'loading':
            return (
              <li key={row.key} data-row={row.key} className="trace-row loading" style={indent(row.depth)}>
                <span className="note">読み込んでいます…</span>
              </li>
            );
        }
      })}
    </ol>
  );
}
