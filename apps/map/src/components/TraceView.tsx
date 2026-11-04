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
  withinFrame,
  type Row,
  type TraceState,
} from '../lib/trace';
import { firstSentence, nodeWords, sideWords } from '../lib/words';
import { Badge, DiffView, Inline } from './ChangeParts';

export interface TraceViewProps {
  data: MapData;
  changes: ChangeIndex | undefined;
  rootId: string;
  state: TraceState;
  trees: ReadonlyMap<string, FlowTree>;
  diffs: ReadonlyMap<string, FrameChange>;
  enabled: ReadonlySet<string>;
  /**
   * The node selected: its frame and its id, and whether it was picked in the
   * diagram (its row then scrolls into view). The row that shows it is
   * highlighted: its own, or the row it is folded into.
   */
  selected: { frame: string; node: string; reveal: boolean } | null;
  onState: (next: TraceState) => void;
  onSelect: (row: { frame: string; node: TreeNode; frameId: string } | null) => void;
  onOpenFunction: (id: string) => void;
}

/** The small label of a decision before its words. */
const KIND_WORDS: Partial<Record<TreeNode['kind'], string>> = {
  if: '分岐',
  switch: '分岐',
  loop: '繰り返し',
  'cond-expr': '式の分岐',
};

/** Where the reader's choice to show the code of every row is kept (a convenience of this browser only). */
const CODE_KEY = 'map.outline.code';

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

/** The frames opened under a key, the key itself included: closing a frame closes them too. */
function withoutFrame(open: readonly string[], key: string): string[] {
  return open.filter((candidate) => !withinFrame(candidate, key));
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
          title={forced !== undefined ? 'この側だけが残る（値を作る機能がオフ）' : chosen === branch.key ? '選択を外す' : 'この側だけを活性にする'}
          onClick={() => onState({ ...state, choices: choose(state.choices, key, chosen === branch.key ? undefined : branch.key) })}
        >
          {branch.label}
        </button>
      ))}
    </span>
  );
}

/**
 * The trace as an outline, one line per row so a reader can skim it: the
 * natural language of each node in the order the code runs (lib/words.ts),
 * with the code only where there are no words, or the code of every row when
 * the reader switches to コード. What does not fit (the rest of the words, the
 * code, the whole text, every change) opens under a row with </>. Below a
 * call the reader opens, the rows of its callee, indented one more; a step
 * folds to its label until it is opened.
 *
 * A decision keeps every side: choosing one (its chip, or its side row)
 * turns the rows of the other sides grey, so nothing goes away. In the map
 * of a pull request, a changed row carries its badge and what changed in
 * words, its diff opens under it, a removed node shows struck through, and
 * a call that leads to changes says how many.
 */
export function TraceView({ data, changes, rootId, state, trees, diffs, enabled, selected, onState, onSelect, onOpenFunction }: TraceViewProps) {
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [details, setDetails] = useState<Set<string>>(() => new Set());
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(() => new Set());
  const [showCode, setShowCode] = useState(readShowCode);
  const rows = useMemo(
    () => traceRows({ rootId, hasFrame: (id) => (entryOf(data, id)?.frame ?? '') !== '', trees, changes: diffs, state, enabled, toggled }),
    [rootId, data, trees, diffs, state, enabled, toggled],
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
  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const indent = (depth: number) => ({ paddingLeft: `${8 + depth * 18}px` });
  /** One line of words, or code, kept to one line; the whole of it in the tooltip. */
  const line = (text: string, code: boolean) => (code ? <span className="row-code mono">{text}</span> : <span className="words-text"><Inline text={text} /></span>);

  const nodeRow = (row: Extract<Row, { kind: 'node' }>): ReactNode => {
    const { node, frame } = row;
    const frameId = ids.get(frame) ?? rootId;
    const change = diffs.get(frameId);
    const mark = nodeMark(change, node.id) ?? (row.call === undefined ? undefined : nodeMark(change, row.call.id));
    const exprs = [...(change?.exprs[node.id] ?? []), ...(row.call === undefined ? [] : (change?.exprs[row.call.id] ?? []))];
    const hunks = change?.hunks[node.id] ?? [];
    // The call the row opens: the node itself, the call evaluated before it, or the one call of a step.
    const opens = node.kind === 'call' ? node : row.call;
    const callee = opens?.target?.kind === 'function' ? opens.target.id : undefined;
    const below = callee === undefined ? undefined : belowCounts(changes, callee);
    const child = opens === undefined ? undefined : childFrame(frame, opens.id);
    const words = row.step?.merged === true ? nodeWords(node, data) : nodeWords(node, data, row.call);
    const member = opens?.target?.kind === 'member' ? data.members[opens.target.id] : undefined;
    const catcher = state.errors && opens !== undefined ? catcherOf(trees, ids, frame, opens.id) : undefined;
    const failures = state.errors && callee !== undefined ? (entryOf(data, callee)?.failures ?? []) : [];
    const code = row.step?.merged === true && row.call !== undefined ? row.call.code : node.kind === 'block' ? `[${node.step?.id ?? ''}]` : node.code;
    const exitCode = row.exit === undefined ? '' : row.exit.nodes.map((item) => item.code).join(' / ');
    const full = node.text !== undefined && firstSentence(node.text) !== node.text.replace(/\s*\n\s*/g, ' ').trim() ? node.text : undefined;
    const open = details.has(row.key);
    const select = () => onSelect(selected?.frame === frame && selected.node === node.id ? null : { frame, node, frameId });
    const toggleFrame = () => {
      if (child === undefined) return;
      const closing = row.frameState !== 'closed';
      onState({ ...state, open: closing ? withoutFrame(state.open, child) : [...state.open, child], focus: closing && withinFrame(state.focus, child) ? frame : state.focus });
    };
    const twisty =
      row.step !== undefined && !row.step.merged ? (
        <button type="button" className="twisty" aria-expanded={row.step.open} aria-label={row.step.open ? `${words.text} を畳む` : `${words.text} の中を見る`} onClick={() => setToggled(flip(toggled, row.key))}>
          {row.step.open ? '▾' : '▸'}
        </button>
      ) : row.frameState === 'closed' || row.frameState === 'open' || row.frameState === 'loading' ? (
        <button type="button" className="twisty" aria-expanded={row.frameState !== 'closed'} aria-label={row.frameState === 'closed' ? `${callee?.slice(callee.indexOf('#') + 1) ?? ''}() の中を開く` : '閉じる'} onClick={toggleFrame}>
          {row.frameState === 'closed' ? '▸' : '▾'}
        </button>
      ) : (
        <span className="twisty-space" aria-hidden="true" />
      );
    const classes = ['trace-row', `kind-${node.kind}`, row.on ? 'on' : 'off', row.before ? 'before' : '', row.step !== undefined ? 'step-row' : '', highlighted === row.key ? 'selected' : '', mark !== undefined ? 'changed' : ''].filter((name) => name !== '').join(' ');
    // The line shows the words, or the code when the reader asked for code (a step keeps its label: its code is only its marker).
    const asCode = showCode && !(row.step !== undefined && !row.step.merged);
    const exitWords = row.exit === undefined ? undefined : asCode ? exitCode : sideWords(row.exit.nodes, data);
    const changeLine = exprs.length === 0 ? undefined : `${exprs[0]?.text ?? ''}${exprs.length > 1 ? ` ほか ${exprs.length - 1}` : ''}`;
    const failureLine = state.errors && opens !== undefined && opens.kind === 'call' ? `失敗 → ${catcher === undefined ? '外へ出る' : `${entryOf(data, catcher.id)?.name ?? catcher.id} の catch`}` : undefined;
    const failureList = failures.map((failure) => `${failure.error}${failure.from === callee ? '' : `（${entryOf(data, failure.from)?.name ?? failure.from} から）`}`).join('、');
    return (
      <li key={row.key} data-row={row.key} className={classes} style={indent(row.depth)}>
        <div className="trace-line">
          {twisty}
          {row.before ? <span className="kind">先に</span> : null}
          {KIND_WORDS[node.kind] !== undefined ? <span className="kind">{KIND_WORDS[node.kind]}</span> : null}
          {words.tag !== undefined ? <span className={`tag tag-${words.tag === '失敗' ? 'error' : 'end'}`}>{words.tag}</span> : null}
          <button type="button" className="row-words" onClick={select} title={[asCode ? words.text : code, full ?? (asCode ? '' : node.text ?? '')].filter((part) => part !== '').join('\n')}>
            {asCode ? line(code, true) : line(words.text, words.code)}
            {exitWords !== undefined ? (
              <span className={`row-exit${row.exit?.on === true ? ' on' : ' off'}`}>
                {' → '}
                {asCode ? <span className="mono">{exitWords}</span> : <Inline text={exitWords} />}
              </span>
            ) : null}
          </button>
          {mark !== undefined ? <Badge mark={mark} /> : null}
          {changeLine !== undefined ? (
            <span className="row-change" title={exprs.map((expr) => expr.text).join('\n')}>
              <Inline text={changeLine} />
            </span>
          ) : null}
          {below !== undefined && below.frames.length > 0 ? (
            <span className="below" title={below.frames.map((id) => entryOf(data, id)?.name ?? id).join('、')}>
              <Badge mark={markOf('inside')} /> {below.frames.length}
              {countWords(below.counts) === '' ? '' : `（${countWords(below.counts)}）`}
            </span>
          ) : null}
          {row.frameState === 'recursion' ? <span className="chip">再帰（ここで止める）</span> : null}
          {opens?.target?.kind === 'untraceable' ? <span className="chip" title={opens.target.why}>追えない呼び出し</span> : null}
          {failureLine !== undefined ? (
            <span className="row-failure" title={failureList === '' ? failureLine : `${failureLine}\n${failureList}`}>
              {failureLine}
            </span>
          ) : null}
          {isDecision(node) ? <Sides node={node} frame={frame} state={state} enabled={enabled} onState={onState} /> : null}
          {callee !== undefined ? (
            <button type="button" className="open-page" onClick={() => onOpenFunction(callee)} title="この関数を根にしたトレース（関数のページ）を開く" aria-label={`${callee.slice(callee.indexOf('#') + 1)}() のページを開く`}>
              ↗
            </button>
          ) : null}
          <button type="button" className="row-more" aria-expanded={open} aria-label={open ? '詳しい説明を閉じる' : '詳しい説明を見る'} title={open ? '詳しい説明を閉じる' : asCode ? '言葉と詳しい説明を見る' : 'コードと詳しい説明を見る'} onClick={() => setDetails(flip(details, row.key))}>
            {'</>'}
          </button>
          {hunks.length > 0 ? (
            <button type="button" className="link small" aria-expanded={openDiffs.has(row.key)} onClick={() => setOpenDiffs(flip(openDiffs, row.key))}>
              差分
            </button>
          ) : null}
        </div>
        {open ? (
          <div className="row-details">
            {asCode ? (
              <div className="trace-words">
                <Inline text={words.text} />
              </div>
            ) : (
              <div className="row-code-line mono">
                {code}
                {exitCode === '' ? '' : ` → ${exitCode}`}
              </div>
            )}
            {full !== undefined ? <div className="trace-words">{full}</div> : null}
            {member !== undefined ? (
              <div className="trace-words">
                {member.type}.{member.member}: {member.summary}
              </div>
            ) : null}
            {exprs.length > 0 ? (
              <ul className="exprs">
                {exprs.map((expr, index) => (
                  <li key={index}>
                    <Inline text={expr.text} />
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
            {failureLine !== undefined && failureList !== '' ? <div className="trace-failure">{failureList}</div> : null}
          </div>
        ) : null}
        {openDiffs.has(row.key) ? <DiffView hunks={hunks} /> : null}
      </li>
    );
  };

  const branchRow = (row: Extract<Row, { kind: 'branch' }>): ReactNode => {
    const key = decisionKey(row.frame, row.node.id);
    const forced = forcedSide(row.node, enabled);
    const label = row.branch.key === 'catch' ? '例外が起きたとき' : row.branch.key === 'finally' ? '最後に必ず' : row.branch.label;
    const choosable = forced === undefined && row.branch.always !== true && branchesOf(row.node, enabled).filter((branch) => branch.always !== true).length > 1;
    const toward = row.branch.toward;
    const exit = row.exit === undefined ? undefined : row.exit.nodes.length === 0 ? '無視して先へ進む' : showCode ? row.exit.nodes.map((node) => node.code).join(' / ') : sideWords(row.exit.nodes, data);
    const whole = [label, toward === undefined ? '' : `→ ${toward}`, exit === undefined ? '' : `→ ${exit}`].filter((part) => part !== '').join(' ');
    const content = (
      <>
        <span className="branch-label">{label}</span>
        {toward !== undefined ? <span className="toward"> → {toward}</span> : null}
        {exit !== undefined ? (
          <span className={`row-exit${row.exit?.on === true ? ' on' : ' off'}`}>
            {' → '}
            {showCode && row.exit !== undefined && row.exit.nodes.length > 0 ? <span className="mono">{exit}</span> : <Inline text={exit} />}
          </span>
        ) : null}
      </>
    );
    return (
      <li key={row.key} data-row={row.key} className={`trace-row branch${row.on ? ' on' : ' off'}${row.chosen ? ' chosen' : ''}${row.node.kind === 'try' ? ' catch' : ''}`} style={indent(row.depth)}>
        <div className="trace-line">
          {choosable ? (
            <button
              type="button"
              className="branch-choose"
              aria-pressed={row.chosen}
              title={`${whole}\n${row.chosen ? '押すと選択を外す（すべての側を活性に戻す）' : '押すとこの側だけを活性にする'}`}
              onClick={() => onState({ ...state, choices: choose(state.choices, key, row.chosen ? undefined : row.branch.key) })}
            >
              {content}
            </button>
          ) : (
            <span className="branch-static" title={whole}>
              {content}
            </span>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="trace-outline">
      <div className="outline-tools">
        <span className="seg outline-mode" role="group" aria-label="行の表示">
          {(['words', 'code'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={(mode === 'code') === showCode}
              onClick={() => {
                setShowCode(mode === 'code');
                writeShowCode(mode === 'code');
              }}
            >
              {mode === 'words' ? '言葉' : 'コード'}
            </button>
          ))}
        </span>
        <span className="note outline-hint" title="行を押すと右の図でその場所を示します。</> でその行の詳しい説明を開きます。">
          行を押すと図でその場所を示す · &lt;/&gt; で詳しく
        </span>
      </div>
      <ol className="trace" aria-label="処理の流れ" ref={list}>
        {rows.map((row) => {
          switch (row.kind) {
            case 'node':
              return nodeRow(row);
            case 'branch':
              return branchRow(row);
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
    </div>
  );
}
