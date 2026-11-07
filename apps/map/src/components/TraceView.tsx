import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { DiffHunk, ExprChange, FlowTree, FrameChange, FrameTestsRef, MapData, TreeNode } from '../types';
import { callsBelow, countWords, heldMarks, markOf, startWords, type ChangeIndex } from '../lib/changes';
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
  runsFor,
  withinFrame,
  type Held,
  type Row,
  type TraceState,
} from '../lib/trace';
import { testBadge } from '../lib/tests';
import { firstSentence, nodeWords, runWords, sideLabel, sideWords } from '../lib/words';
import { Badge, DiffView, Inline } from './ChangeParts';

/** The part of the diff of a changed frame that a call of a member leads to (see memberChanges): the frame, its name with its root, and its hunks there. */
export interface MemberDiff {
  id: string;
  /** `createStoreResolvers()（hono）`. */
  name: string;
  hunks: DiffHunk[];
  /** Its file is still being read. */
  loading: boolean;
}

/** What the outline of a trace shows and what it tells the trace (see TraceView). */
export interface TraceViewProps {
  data: MapData;
  changes: ChangeIndex | undefined;
  rootId: string;
  /** The source of the endpoints shown (hono or nextjs): the implementations of a member that run for it. */
  source: string;
  state: TraceState;
  trees: ReadonlyMap<string, FlowTree>;
  diffs: ReadonlyMap<string, FrameChange>;
  enabled: ReadonlySet<string>;
  /** The rows of the outline (lib/trace.ts traceRows), made by the trace with the steps the reader opened or folded, which the diagram reads too. */
  rows: readonly Row[];
  /** Open or fold a step or a run of statements, by its row key. */
  onToggle: (key: string) => void;
  /** Every row shows its code instead of its words. */
  showCode: boolean;
  onShowCode: (code: boolean) => void;
  /** The parts of the diffs of the changed frames below a call of a member (see MemberDiff). */
  memberDiff: (member: string) => MemberDiff[];
  /** The tests of the frames, for the badge of a row whose call or step is a function with tests (`ユニット 9 到達 38`). */
  tests?: { frames: Readonly<Record<string, FrameTestsRef>>; measured: boolean } | undefined;
  /** The function of a step of the root that is not one call (Hono's steps), by step id. */
  stepFunction?: ((step: string) => string | undefined) | undefined;
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

/** The frames opened under a key, the key itself included: closing a frame closes them too. */
function withoutFrame(open: readonly string[], key: string): string[] {
  return open.filter((candidate) => !withinFrame(candidate, key));
}

/** The name of a function or a body with its root, for the implementations of a member (`createStoreResolvers()（hono）`). */
export function rootedName(data: MapData, id: string): string {
  const entry = entryOf(data, id);
  const name = entry === undefined ? id.slice(id.indexOf('#') + 1) : 'endpoint' in entry ? entry.name : `${entry.name}()`;
  return `${name}（${id.slice(0, id.indexOf(':'))}）`;
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
          {sideLabel(node, branch)}
        </button>
      ))}
    </span>
  );
}

/** The tags of how a folded step ends the flow, as its box in the diagram reads them: `終わり ×3`, `失敗`; each on when the choices run one of its exits. */
function exitTags(exits: ReadonlyArray<{ node: TreeNode; on: boolean }>): Array<{ tone: 'end' | 'error'; text: string; on: boolean }> {
  return (['return', 'throw'] as const).flatMap((kind) => {
    const some = exits.filter((exit) => exit.node.kind === kind);
    if (some.length === 0) return [];
    const words = kind === 'throw' ? '失敗' : '終わり';
    return [{ tone: kind === 'throw' ? ('error' as const) : ('end' as const), text: some.length === 1 ? words : `${words} ×${some.length}`, on: some.some((exit) => exit.on) }];
  });
}

/**
 * The trace as an outline, one line per row so a reader can skim it: the
 * natural language of each node in the order the code runs (lib/words.ts),
 * with the code only where there are no words, or the code of every row when
 * the reader switches to コード. What does not fit (the rest of the words, the
 * code, the whole text, every change, the chips of the sides on a phone)
 * opens under a row with </>. Below a call the reader opens, the rows of its
 * callee, indented one more; a step folds to its label (with how it ends)
 * until it is opened.
 *
 * A decision keeps every side: choosing one (its chip, or its side row)
 * turns the rows of the other sides grey, so nothing goes away. In the map
 * of a pull request, a row carries the badge its box in the diagram carries
 * (lib/changes.ts heldMarks) and what changed in words, the diff of every
 * node it shows opens under it (the diff of a frame's start on the call that
 * opens the frame), a removed node shows struck through, and a call that
 * leads to changes, a member's implementations among them, says how many.
 */
export function TraceView({ data, changes, rootId, source, state, trees, diffs, enabled, rows, onToggle, showCode, onShowCode, memberDiff, tests, stepFunction, selected, onState, onSelect, onOpenFunction }: TraceViewProps) {
  const [details, setDetails] = useState<Set<string>>(() => new Set());
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(() => new Set());
  const ids = frameIds(rootId, state.open, trees);
  const highlighted = selected === null ? undefined : rowFor(rows, selected.frame, selected.node);
  const list = useRef<HTMLOListElement>(null);
  // A box picked in the diagram (or a node a link names) brings its row into view; a row picked here is in view already.
  useEffect(() => {
    if (selected === null || !selected.reveal || highlighted === undefined) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])].find((item) => item.dataset.row === highlighted);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected, highlighted]);
  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  /** The indent of a row by its depth: a custom property, so a phone indents by less (styles.css). */
  const indent = (depth: number) => ({ '--depth': depth }) as CSSProperties;
  /** One line of words, or code, kept to one line; the whole of it in the tooltip. */
  const line = (text: string, code: boolean) => (code ? <span className="row-code mono">{text}</span> : <span className="words-text"><Inline text={text} /></span>);
  const root = entryOf(data, rootId);
  const title = root === undefined ? rootId : 'endpoint' in root ? root.name : `${root.name}()`;

  /** What the pull request did to what a row shows: its badges, the changes below its calls, its expression changes and its hunks (sorted by line). */
  const changeOf = (row: Held & { frame: string }, extra: { hunks?: readonly DiffHunk[]; words?: readonly string[] } = {}) => {
    const change = diffs.get(ids.get(row.frame) ?? rootId);
    const marks = heldMarks(changes, change, row.holds, row.calls);
    const below = callsBelow(changes, row.calls);
    const exprs: ExprChange[] = [...row.holds.flatMap((id) => change?.exprs[id] ?? []), ...(extra.words ?? []).map((text) => ({ text }))];
    const hunks = [...row.holds.flatMap((id) => change?.hunks[id] ?? []), ...(extra.hunks ?? [])].sort((a, b) => a.head - b.head);
    return { ...marks, below, exprs, hunks };
  };

  /** The badge of a row and how many changes are below its calls: `変更`, `下で変更 2（条件 +1）`; a second badge says `下で変更` when the badge is the row's own. */
  const badges = (found: ReturnType<typeof changeOf>) => (
    <>
      {found.mark !== undefined ? <Badge mark={found.mark} /> : null}
      {found.below.frames.length > 0 ? (
        <span className="below" title={`下で変えた関数: ${found.below.frames.map((id) => entryOf(data, id)?.name ?? id).join('、')}${countWords(found.below.counts) === '' ? '' : `\n${countWords(found.below.counts)}`}`}>
          {found.mark === undefined || found.own !== undefined ? <Badge mark={markOf('inside')} /> : null} {found.below.frames.length}
          {countWords(found.below.counts) === '' ? null : <span className="below-words">（{countWords(found.below.counts)}）</span>}
        </span>
      ) : null}
    </>
  );

  /** The badge of the tests of the function a row calls or a step is: its unit tests (and their boundary tests), the tests that reached it, the split in the tooltip; grey like every badge. */
  const testsBadge = (id: string | undefined) => {
    const found = id === undefined || tests === undefined ? undefined : testBadge(tests.frames[id], tests.measured);
    if (found === undefined) return null;
    return (
      <span className="tests-badge" title={found.title}>
        {found.unit}
        {found.detail !== undefined ? <span className="tests-badge-words">{found.detail}</span> : null}
        {found.reach !== undefined ? <span className="tests-badge-reach"> {found.reach}</span> : null}
      </span>
    );
  };

  /** The button that opens the diff of a row under it; `onLine`, one a phone moves from the line under </> (see the row's actions). */
  const diffButton = (key: string, count: number, onLine = false) =>
    count > 0 ? (
      <button type="button" className={`link small${onLine ? ' line-action' : ''}`} aria-expanded={openDiffs.has(key)} onClick={() => setOpenDiffs(flip(openDiffs, key))}>
        差分
      </button>
    ) : null;

  const nodeRow = (row: Extract<Row, { kind: 'node' }>): ReactNode => {
    const { node, frame } = row;
    const frameId = ids.get(frame) ?? rootId;
    // The call the row opens: the node itself, the call evaluated before it, or the one call of a step.
    const opens = node.kind === 'call' ? node : row.call;
    const callee = opens?.target?.kind === 'function' ? opens.target.id : undefined;
    const child = opens === undefined ? undefined : childFrame(frame, opens.id);
    // The start of the frame the row opened (its declaration) is a change of this row.
    const childChange = row.frameState === 'open' && child !== undefined ? diffs.get(ids.get(child) ?? '') : undefined;
    const member = opens?.target?.kind === 'member' ? data.members[opens.target.id] : undefined;
    const reached = member === undefined ? [] : memberDiff(member.id);
    const found = changeOf(row, { hunks: childChange?.hunks[''] ?? [], words: startWords(childChange) });
    const reachedCount = reached.reduce((sum, diff) => sum + (diff.loading ? 1 : diff.hunks.length), 0);
    const words = row.step?.merged === true ? nodeWords(node, data) : nodeWords(node, data, row.call);
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
        <button type="button" className="twisty" aria-expanded={row.step.open} aria-label={row.step.open ? `${words.text} を畳む` : `${words.text} の中を見る`} onClick={() => onToggle(row.key)}>
          {row.step.open ? '▾' : '▸'}
        </button>
      ) : row.frameState === 'closed' || row.frameState === 'open' || row.frameState === 'loading' ? (
        <button type="button" className="twisty" aria-expanded={row.frameState !== 'closed'} aria-label={row.frameState === 'closed' ? `${callee?.slice(callee.indexOf('#') + 1) ?? ''}() の中を開く` : '閉じる'} onClick={toggleFrame}>
          {row.frameState === 'closed' ? '▸' : '▾'}
        </button>
      ) : (
        <span className="twisty-space" aria-hidden="true" />
      );
    const classes = ['trace-row', `kind-${node.kind}`, row.on ? 'on' : 'off', row.before ? 'before' : '', row.step !== undefined ? 'step-row' : '', highlighted === row.key ? 'selected' : '', found.own !== undefined ? 'changed' : ''].filter((name) => name !== '').join(' ');
    // The line shows the words, or the code when the reader asked for code (a step keeps its label: its code is only its marker).
    const asCode = showCode && !(row.step !== undefined && !row.step.merged);
    const exitWords = row.exit === undefined ? undefined : asCode ? exitCode : sideWords(row.exit.nodes, data);
    const changeLine = found.exprs.length === 0 ? undefined : `${found.exprs[0]?.text ?? ''}${found.exprs.length > 1 ? ` ほか ${found.exprs.length - 1}` : ''}`;
    const failureLine = state.errors && opens !== undefined && opens.kind === 'call' ? `失敗 → ${catcher === undefined ? '外へ出る' : `${entryOf(data, catcher.id)?.name ?? catcher.id} の catch`}` : undefined;
    const failureList = failures.map((failure) => `${failure.error}${failure.from === callee ? '' : `（${entryOf(data, failure.from)?.name ?? failure.from} から）`}`).join('、');
    const implementers = (member?.implementedBy ?? []).filter((id) => runsFor(id, source));
    const decision = isDecision(node);
    // The function the tests of the row are of: its call, else the function of a step of the root that is not one call.
    const tested = callee ?? (frame === '' && node.kind === 'block' && node.step !== undefined ? stepFunction?.(node.step.id) : undefined);
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
          {exitTags(row.step?.exits ?? []).map((tag) => (
            <span key={tag.tone} className={`tag tag-${tag.tone}${tag.on ? '' : ' tag-off'}`} title={tag.tone === 'error' ? 'このステップの中で失敗して終わる' : 'このステップの中で終わる'}>
              {tag.text}
            </span>
          ))}
          {row.fails === true ? (
            <span className="tag tag-error" title="選んだ道筋では、この呼び出しがここで失敗する">
              ここで失敗
            </span>
          ) : null}
          {badges(found)}
          {testsBadge(tested)}
          {changeLine !== undefined ? (
            <span className="row-change" title={found.exprs.map((expr) => expr.text).join('\n')}>
              <Inline text={changeLine} />
            </span>
          ) : null}
          {row.frameState === 'recursion' ? <span className="chip">再帰（ここで止める）</span> : null}
          {opens?.target?.kind === 'untraceable' ? <span className="chip" title={opens.target.why}>追えない呼び出し</span> : null}
          {failureLine !== undefined ? (
            <span className="row-failure" title={failureList === '' ? failureLine : `${failureLine}\n${failureList}`}>
              {failureLine}
            </span>
          ) : null}
          {decision ? <Sides node={node} frame={frame} state={state} enabled={enabled} onState={onState} /> : null}
          {callee !== undefined ? (
            <button type="button" className="open-page line-action" onClick={() => onOpenFunction(callee)} title="この関数を根にしたトレース（関数のページ）を開く" aria-label={`${callee.slice(callee.indexOf('#') + 1)}() のページを開く`}>
              ↗
            </button>
          ) : null}
          <button type="button" className="row-more" aria-expanded={open} aria-label={open ? '詳しい説明を閉じる' : '詳しい説明を見る'} title={open ? '詳しい説明を閉じる' : asCode ? '言葉と詳しい説明を見る' : 'コードと詳しい説明を見る'} onClick={() => setDetails(flip(details, row.key))}>
            {'</>'}
          </button>
          {diffButton(row.key, found.hunks.length + reachedCount, true)}
        </div>
        {open ? (
          <div className="row-details">
            {callee !== undefined || found.hunks.length + reachedCount > 0 ? (
              // A phone's line has no room for the page and the diff of the row: they are here.
              <div className="row-actions">
                {found.hunks.length + reachedCount > 0 ? (
                  <button type="button" className="code-button" aria-expanded={openDiffs.has(row.key)} onClick={() => setOpenDiffs(flip(openDiffs, row.key))}>
                    {openDiffs.has(row.key) ? '差分を閉じる' : '差分を見る'}
                  </button>
                ) : null}
                {callee !== undefined ? (
                  <button type="button" className="code-button" onClick={() => onOpenFunction(callee)}>
                    {callee.slice(callee.indexOf('#') + 1)}() のページを開く
                  </button>
                ) : null}
              </div>
            ) : null}
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
            {decision ? (
              <div className="row-sides">
                <Sides node={node} frame={frame} state={state} enabled={enabled} onState={onState} />
              </div>
            ) : null}
            {member !== undefined ? (
              <div className="trace-words">
                {member.type}.{member.member}: {member.summary}
                {implementers.length > 0 ? `（実装: ${implementers.map((id) => `${rootedName(data, id)}${changes?.reach.changed.has(id) === true ? ' 変更' : ''}`).join('、')}）` : ''}
              </div>
            ) : null}
            {found.below.frames.length > 0 ? (
              <div className="trace-words">
                下で変えた関数: {found.below.frames.map((id) => rootedName(data, id)).join('、')}
                {countWords(found.below.counts) === '' ? '' : `（${countWords(found.below.counts)}）`}
              </div>
            ) : null}
            {found.exprs.length > 0 ? (
              <ul className="exprs">
                {found.exprs.map((expr, index) => (
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
        {openDiffs.has(row.key) ? (
          <>
            {found.hunks.length > 0 ? <DiffView hunks={found.hunks} /> : null}
            {reached.map((diff) => (
              <div key={diff.id} className="member-diff">
                <p className="trace-words">
                  {member === undefined ? '' : `${member.type}.${member.member} の実装の先: `}
                  {diff.name}
                </p>
                {diff.loading ? <p className="trace-words">読み込んでいます…</p> : <DiffView hunks={diff.hunks} />}
              </div>
            ))}
          </>
        ) : null}
      </li>
    );
  };

  const branchRow = (row: Extract<Row, { kind: 'branch' }>): ReactNode => {
    const key = decisionKey(row.frame, row.node.id);
    const forced = forcedSide(row.node, enabled);
    const label = row.branch.key === 'catch' ? '例外が起きたとき' : row.branch.key === 'finally' ? '最後に必ず' : sideLabel(row.node, row.branch);
    const choosable = forced === undefined && row.branch.always !== true && branchesOf(row.node, enabled).filter((branch) => branch.always !== true).length > 1;
    const toward = row.branch.toward;
    const exit = row.exit === undefined ? undefined : row.exit.nodes.length === 0 ? '無視して先へ進む' : showCode ? row.exit.nodes.map((node) => node.code).join(' / ') : sideWords(row.exit.nodes, data);
    const whole = [label, toward === undefined ? '' : `→ ${toward}`, exit === undefined ? '' : `→ ${exit}`].filter((part) => part !== '').join(' ');
    const found = changeOf(row);
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
          {row.step !== undefined ? (
            <button type="button" className="twisty" aria-expanded={false} aria-label={`${label} の中を見る`} title="この側のステップをその場で開く（図でも開く）" onClick={() => onToggle(`${row.frame}|${row.step}`)}>
              ▸
            </button>
          ) : null}
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
          {badges(found)}
          {diffButton(row.key, found.hunks.length)}
        </div>
        {openDiffs.has(row.key) ? <DiffView hunks={found.hunks} /> : null}
      </li>
    );
  };

  return (
    <div className="trace-outline">
      <div className="outline-tools">
        <strong className="outline-title" title={title}>
          {title}
        </strong>
        <span className="seg outline-mode" role="group" aria-label="行の表示">
          {(['words', 'code'] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={(mode === 'code') === showCode} onClick={() => onShowCode(mode === 'code')}>
              {mode === 'words' ? '言葉' : 'コード'}
            </button>
          ))}
        </span>
        <span className="note outline-hint" title="行を押すと、右の欄がその行のフレームに移ります（タブはそのまま。図ではその箱を、詳細ではその行の説明を示します）。</> でその行の詳しい説明を開きます。">
          行を押すと右の欄がその行を示す · &lt;/&gt; で詳しく
        </span>
      </div>
      <ol className="trace" aria-label="処理の流れ" ref={list}>
        {rows.map((row) => {
          switch (row.kind) {
            case 'node':
              return nodeRow(row);
            case 'branch':
              return branchRow(row);
            case 'start': {
              const change = diffs.get(rootId);
              const found = changeOf(row, { words: startWords(change) });
              return (
                <li key={row.key} data-row={row.key} className="trace-row kind-start on changed" style={indent(row.depth)}>
                  <div className="trace-line">
                    <span className="twisty-space" aria-hidden="true" />
                    <span className="kind">宣言</span>
                    <span className="row-words row-static">{line(found.exprs[0]?.text ?? '宣言と JSDoc（処理の外の行）を変えた', false)}</span>
                    {badges(found)}
                    {diffButton(row.key, found.hunks.length)}
                  </div>
                  {openDiffs.has(row.key) ? <DiffView hunks={found.hunks} /> : null}
                </li>
              );
            }
            case 'run': {
              const said = runWords(row.nodes);
              const found = changeOf(row);
              return (
                <li key={row.key} data-row={row.key} className={`trace-row kind-run${row.on ? ' on' : ' off'}${highlighted === row.key ? ' selected' : ''}`} style={indent(row.depth)}>
                  <div className="trace-line">
                    <button type="button" className="twisty" aria-expanded={row.open} aria-label={row.open ? 'まとめて読む' : `${row.nodes.length} 行のコードを開く`} onClick={() => onToggle(row.key)}>
                      {row.open ? '▾' : '▸'}
                    </button>
                    <span className="kind">コード {row.nodes.length} 行</span>
                    <button
                      type="button"
                      className="row-words"
                      title={row.nodes.map((item) => item.code).join('\n')}
                      onClick={() => {
                        const first = row.nodes[0];
                        if (first !== undefined) onSelect(selected?.frame === row.frame && selected.node === first.id ? null : { frame: row.frame, node: first, frameId: ids.get(row.frame) ?? rootId });
                      }}
                    >
                      <span className="words-text">
                        <Inline text={said.text} />
                      </span>
                    </button>
                    {badges(found)}
                    {diffButton(row.key, found.hunks.length)}
                  </div>
                  {openDiffs.has(row.key) ? <DiffView hunks={found.hunks} /> : null}
                </li>
              );
            }
            case 'removed':
              return (
                <li key={row.key} data-row={row.key} className="trace-row removed" style={indent(row.depth)}>
                  <div className="trace-line">
                    <span className="twisty-space" aria-hidden="true" />
                    <Badge mark={markOf('removed')} />
                    <del className="mono" title={row.node.code}>
                      {row.node.code}
                    </del>
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
