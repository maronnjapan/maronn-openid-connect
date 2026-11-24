import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FlowStep, MapData, Selection } from '../types';
import { STEP_KIND_WORDS, SPEEDS, sceneAt, sceneDuration, sceneLines, scenarioOf, selectionKey, type FlowWalk, type Scene, type SceneLine } from '../lib/playback';
import { choose, entryOf, type TraceState } from '../lib/trace';
import { firstSentence } from '../lib/words';
import { Inline } from './ChangeParts';
import { FeatureBadge } from './FeatureBadge';
import { FlowRequest, type FlowRequestProps } from './FlowRequest';
import { failureGroups } from './SelectionBar';
import { useCurrentPremises, type RootRequestsState } from './useRequests';
import type { RequestRun } from './useRun';

/** Where a playback is and how it moves (see usePlayback). */
export interface Playback {
  /** The scene shown, by index. */
  at: number;
  /** The scene shown before it, when the playback just moved one scene forward: the token travels from there. */
  from: number | undefined;
  playing: boolean;
  speed: number;
  /** Show a scene; `step` says the playback moved one scene forward from the one before (the token travels). */
  go: (index: number) => void;
  play: (on: boolean) => void;
  setSpeed: (speed: number) => void;
}

/**
 * The state of a playback over some scenes: the scene shown, whether it
 * runs on its own, and its speed. While it plays it moves to the next scene
 * after the time a scene stays (sceneDuration) and stops at the last. When
 * the scenes change under it (a side taken, a frame opened), it stays on the
 * node it was showing.
 */
export function usePlayback(scenes: readonly Scene[]): Playback {
  const [at, setAt] = useState(0);
  const [from, setFrom] = useState<number | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const was = useRef<{ frame: string; node: string } | undefined>(undefined);
  const list = useRef(scenes);
  let shown = at;
  if (list.current !== scenes) {
    // The scenes changed: stay on the node shown, without a travel.
    list.current = scenes;
    shown = sceneAt(scenes, was.current, at);
    if (shown !== at) setAt(shown);
    if (from !== undefined) setFrom(undefined);
  }
  const scene = scenes[shown];
  was.current = scene === undefined ? undefined : { frame: scene.frame, node: scene.node.id };
  const last = scenes.length - 1;
  useEffect(() => {
    if (!playing) return undefined;
    if (shown >= last) {
      setPlaying(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setFrom(shown);
      setAt(shown + 1);
    }, sceneDuration(speed));
    return () => window.clearTimeout(timer);
  }, [playing, shown, last, speed]);
  return {
    at: shown,
    from,
    playing,
    speed,
    go: (index) => {
      const next = Math.max(0, Math.min(last, index));
      if (next === 0) was.current = undefined;
      setFrom(next === shown + 1 ? shown : undefined);
      setAt(next);
    },
    play: (on) => {
      // Playing from the end starts over.
      if (on && shown >= last) {
        setFrom(undefined);
        setAt(0);
      }
      setPlaying(on && last > 0);
    },
    setSpeed,
  };
}

/** What the player of a flow shows and what it tells the trace (see FlowPlayer). */
export interface FlowPlayerProps {
  data: MapData;
  /** The ready-made choices of the root (the ways into its steps, the ways it ends, its failures) and the ways to the changes. */
  selections: readonly Selection[];
  state: TraceState;
  onState: (next: TraceState) => void;
  enabled: ReadonlySet<string>;
  walked: FlowWalk;
  scenes: readonly Scene[];
  playback: Playback;
  /** The requests the OP of the map took the ways of the root with (useRootRequests): the request of the way chosen starts from its one. */
  requests: RootRequestsState;
  /** The endpoint's purpose-based request selector. */
  requestCase?: ReactNode;
  /** The selected purpose and the draft it generated, once ready. */
  generatedCase?: FlowRequestProps['generatedCase'];
  /** The framework the map shows (TraceProps.framework). */
  framework: string;
  /** The words a scene is named by: those of its box in the diagram. */
  titleOf: (scene: Scene) => { text: string; code: boolean };
  /** The endpoint whose root the trace starts from (see TraceProps.endpoint): a scene of one of its steps says the step's kind and values, and a request to it is written with its method and path. */
  endpoint?: { name: string; steps: readonly FlowStep[]; request?: { method: string; path: string } } | undefined;
  /** The request the reader runs on the OP of the map, and what it gave (useRun.ts). */
  run: RequestRun;
  /** The ready-made way the request run ended by, in words, while the playback follows it. */
  ending: string | undefined;
  /** Why a request cannot be run on the OP of the map here; undefined when it can. */
  unrunnable: string | undefined;
  /** Whether a function has a frame the playback can go into. */
  hasFrame: (id: string) => boolean;
  /** Frames of the trace are still being read: the playback may grow. */
  loading: boolean;
  /** How many calls on the way the playback could still go into, and whether it is inside any. */
  deeper: number;
  canFold: boolean;
  onDeeper: () => void;
  onFold: () => void;
  /** Go into the frame of a call (by its frame key), or come out of it. */
  onEnter: (key: string) => void;
  onLeave: (key: string) => void;
  onOpenCode: (id: string) => void;
  /** Leave the flow view for the outline, on a scene's row when one is given. */
  onOutline: (scene?: Scene) => void;
}

const GROUP_HEADINGS: ReadonlyArray<{ kind: Selection['kind']; heading: string }> = [
  { kind: 'step', heading: 'ステップへ進む道筋' },
  { kind: 'change', heading: 'このPRの変更に至る道筋' },
  { kind: 'exit', heading: '終わり方' },
];

const TONE_WORDS: Record<Scene['tone'], string> = { normal: '', end: '応答して終わる', error: '失敗する', caught: '例外を受け取る' };

/** The name of a selection in the list of the ways, without the code marks. */
function plain(text: string): string {
  return text.replace(/`/g, '');
}

/**
 * The player of the flow view: which way the request takes (a ready-made
 * choice, or the sides the reader chose), the controls of the playback, what
 * happens in the scene shown, and the draft to run on the map's OP (FlowRequest).
 * The chart beside it shows where the scene is
 * (a node of it goes to its scene); this says what happens there, in the
 * words the outline uses.
 *
 * A decision the way does not decide is taken on an assumed side, marked 仮:
 * its other sides are buttons, and taking one makes it part of the way (the
 * same choice the outline's side buttons make). A call that has a frame can
 * be entered, which makes the request go through that function too.
 */
export function FlowPlayer({ data, selections, state, onState, enabled, walked, scenes, playback, requests, requestCase, generatedCase, framework, titleOf, endpoint, hasFrame, loading, deeper, canFold, onDeeper, onFold, onEnter, onLeave, onOpenCode, onOutline, run, ending, unrunnable }: FlowPlayerProps) {
  const { at, playing, speed } = playback;
  const premises = useCurrentPremises(data);
  const scene = scenes[at];
  const choice = state.choices[0];
  // While the playback follows the way of a request run, that is the way chosen, ready-made or not.
  const ran = run.state?.status === 'done' && run.state.follow;
  const picked = ran ? -1 : scenarioOf(selections, choice, state.way);
  const custom = !ran && picked === -1 && choice !== undefined && Object.keys(choice).length > 0;
  // A request run plays the way it took from the start, once that way is read.
  const played = useRef(0);
  useEffect(() => {
    const ranState = run.state;
    if (ranState?.status !== 'done' || !ranState.follow || run.walked === undefined || played.current === ranState.id) return;
    played.current = ranState.id;
    playback.go(0);
    playback.play(true);
  }, [run.state, run.walked, playback]);
  const pick = (value: string) => {
    if (value === 'run' || value === 'custom') return;
    playback.play(false);
    playback.go(0);
    // Another way leaves the way of the request run.
    run.forget();
    if (value === 'auto') {
      onState({ ...state, open: [], choices: [], way: undefined, request: undefined, focus: '' });
      return;
    }
    const selection = selections[Number(value)];
    if (selection === undefined) return;
    // A way is played on its own: its frames open, its sides chosen, from the start.
    onState({ ...state, open: [...(selection.frames ?? [])], choices: [selection.decisions], way: selectionKey(selection), request: undefined, focus: '' });
  };
  const failures = selections.map((selection, index) => ({ selection, index })).filter((item) => item.selection.kind === 'failure');
  const failureIndex = new Map(failures.map((item) => [item.selection, item.index]));
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === 'SELECT' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      playback.play(false);
      playback.go(at + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      playback.play(false);
      playback.go(at - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      playback.go(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      playback.go(scenes.length - 1);
    }
  };

  const lines = scene === undefined ? [] : sceneLines(scene, data, enabled);
  const title = scene === undefined ? undefined : titleOf(scene);
  /** The step of the endpoint a scene of its root frame runs. */
  const stepOf = (item: Scene): FlowStep | undefined => (item.depth !== 0 || item.step === undefined ? undefined : endpoint?.steps.find((candidate) => candidate.id === item.step));
  const facts = scene === undefined ? undefined : stepOf(scene);
  const frameEntry = scene === undefined ? undefined : entryOf(data, scene.tree);
  const frameName = frameEntry === undefined ? (scene?.tree ?? '') : 'endpoint' in frameEntry ? frameEntry.name : `${frameEntry.name}()`;
  // The whole text behind the scene's title: the JSDoc of the function its call reaches, else the comment of its node.
  const callStop = scene?.stops.find((stop) => stop.node.kind === 'call' && stop.node.target?.kind === 'function');
  const callee = callStop?.node.target?.kind === 'function' ? data.functions[callStop.node.target.id] : undefined;
  const whole = (callee?.summary ?? scene?.node.text)?.replace(/\s*\n\s*/g, ' ').trim();
  // The scene's title is the first sentence of that text: the text is worth a paragraph only when it says more.
  const more = whole !== undefined && title !== undefined && whole.replace(/`/g, '').replace(/。$/, '') !== title.text.replace(/`/g, '').replace(/。$/, '') ? whole : undefined;
  /** Whether a line says in words what the title already says: it then shows its code instead. */
  const bare = (text: string) => text.replace(/`/g, '').replace(/。$/, '');
  const repeats = (item: SceneLine) => !item.code && title !== undefined && (bare(item.text) === bare(title.text) || (more !== undefined && bare(more).startsWith(bare(item.text))));
  // What that function calls in turn, the first few: a look inside before going in.
  const inside = (callee?.calls ?? []).slice(0, 6).flatMap((id) => (data.functions[id] === undefined ? [] : [data.functions[id]]));
  const feature = scene?.node.feature ?? scene?.node.step?.feature;
  const assumedCount = walked.assumed.length;

  /** A line of the scene: what runs, the side a decision takes (with the other sides to take), how it ends or fails. */
  const line = (item: SceneLine, index: number): ReactNode => {
    const key = `${item.stop.node.id}:${index}`;
    const said = item.code ? <code className="mono">{item.text}</code> : repeats(item) ? <code className="mono">{item.stop.node.code}</code> : <Inline text={item.text} />;
    if (item.kind === 'side' && item.decision !== undefined) {
      const decision = item.decision;
      return (
        <li key={key} className={`scene-line line-side${decision.assumed ? ' assumed' : ''}`}>
          <span className="line-kind">分岐</span>
          <span className="line-words">{said}</span>
          <span className="line-sides" role="group" aria-label="進む側">
            {decision.sides.map((side) => (
              <button
                key={side.key}
                type="button"
                className="side"
                aria-pressed={side.key === decision.taken}
                title={side.key === decision.taken ? (decision.assumed ? 'いまは仮にこの側へ進んでいます。押すとこの側に決めます' : 'この側へ進んでいます。押すと選択を外します') : 'この側へ進む道筋に変える'}
                onClick={() => {
                  playback.play(false);
                  const unpick = side.key === decision.taken && !decision.assumed;
                  onState({ ...state, choices: choose(state.choices.slice(0, 1), decision.key, unpick ? undefined : side.key), way: undefined });
                }}
              >
                {side.label}
              </button>
            ))}
            {decision.assumed ? <span className="assumed-mark" title="この分岐は道筋が決めていないので、仮の側へ進んでいます">仮</span> : null}
          </span>
        </li>
      );
    }
    const target = item.stop.node.target;
    const calleeId = item.stop.node.kind === 'call' && target?.kind === 'function' && hasFrame(target.id) && target.id !== item.stop.tree ? target.id : undefined;
    const frameKey = item.stop.frame === '' ? item.stop.node.id : `${item.stop.frame}.${item.stop.node.id}`;
    const words: Partial<Record<SceneLine['kind'], string>> = { enters: '中へ', returns: '終わり', ends: '終わり', throws: '失敗', fails: 'ここで失敗', catches: '捕まえる' };
    return (
      <li key={key} className={`scene-line line-${item.kind}`}>
        {words[item.kind] !== undefined ? <span className="line-kind">{words[item.kind]}</span> : null}
        <span className="line-words">
          {said}
          {item.error !== undefined ? <code className="mono line-error">{item.error}</code> : null}
        </span>
        {calleeId !== undefined ? (
          item.kind === 'enters' ? (
            <button type="button" className="link small" onClick={() => onLeave(frameKey)} title="この関数の中を通らずに、呼び出しの一行として進む">
              中を閉じる
            </button>
          ) : (
            <button type="button" className="link small" onClick={() => onEnter(frameKey)} title="この関数の中の処理も、リクエストが通る道筋に入れる">
              中に入る ▸
            </button>
          )
        ) : null}
      </li>
    );
  };

  return (
    <section className="flow-player" aria-label="フローの再生" onKeyDown={onKey}>
      {requestCase}
      <div className="flow-controls">
        <label className="flow-way">
          <span className="flow-label">コードの道筋</span>
          <select value={ran ? 'run' : picked !== -1 ? String(picked) : custom ? 'custom' : 'auto'} onChange={(event) => pick(event.target.value)}>
            <option value="auto">おまかせ（分岐は仮の側へ進む）</option>
            {ran ? <option value="run">実行したリクエストが通った道筋</option> : null}
            {custom ? <option value="custom">自分で選んだ道筋</option> : null}
            {GROUP_HEADINGS.map(({ kind, heading }) => {
              const items = selections.map((selection, index) => ({ selection, index })).filter((item) => item.selection.kind === kind);
              return items.length === 0 ? null : (
                <optgroup key={kind} label={heading}>
                  {items.map(({ selection, index }) => (
                    <option key={index} value={index}>
                      {plain(selection.name)}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            {failureGroups(failures.map((item) => item.selection)).map(({ error, items }) => (
              <optgroup key={error} label={`失敗: ${plain(error)}`}>
                {items.map((selection) => (
                  <option key={failureIndex.get(selection)} value={failureIndex.get(selection)}>
                    {selection.failure !== undefined && (selection.frames ?? []).length > 0 ? `${selection.failure.name} から` : plain(selection.name)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="flow-buttons" role="group" aria-label="再生の操作">
          <button type="button" className="icon" aria-label="最初に戻る" title="最初に戻る（Home）" disabled={at === 0} onClick={() => { playback.play(false); playback.go(0); }}>
            ⏮
          </button>
          <button type="button" className="icon" aria-label="前へ" title="前へ（←）" disabled={at === 0} onClick={() => { playback.play(false); playback.go(at - 1); }}>
            ◀
          </button>
          <button type="button" className="flow-play" aria-pressed={playing} disabled={scenes.length < 2} onClick={() => playback.play(!playing)}>
            {playing ? '⏸ 止める' : at >= scenes.length - 1 && scenes.length > 1 ? '↻ もう一度' : '▶ 再生'}
          </button>
          <button type="button" className="icon" aria-label="次へ" title="次へ（→）" disabled={at >= scenes.length - 1} onClick={() => { playback.play(false); playback.go(at + 1); }}>
            ▶
          </button>
          <span className="seg flow-speed" role="group" aria-label="再生の速さ">
            {SPEEDS.map((value) => (
              <button key={value} type="button" aria-pressed={speed === value} onClick={() => playback.setSpeed(value)}>
                {value}×
              </button>
            ))}
          </span>
        </div>
        <input
          className="flow-scrub"
          type="range"
          min={0}
          max={Math.max(0, scenes.length - 1)}
          value={at}
          aria-label="再生の位置"
          aria-valuetext={scene === undefined ? '' : `${at + 1} / ${scenes.length}: ${title?.text ?? ''}`}
          onChange={(event) => {
            playback.play(false);
            playback.go(Number(event.target.value));
          }}
        />
        <div className="flow-depth">
          <span className="flow-label">呼び出しの中</span>
          <button type="button" className="code-button" disabled={deeper === 0} onClick={onDeeper} title="道筋にある関数呼び出しを、もう一段、中まで通る">
            一段深く{deeper > 0 ? `（${deeper}）` : ''}
          </button>
          <button type="button" className="code-button" disabled={!canFold} onClick={onFold} title="いちばん深い段を閉じる">
            一段浅く
          </button>
        </div>
      </div>

      <div className="flow-scene">
      {scene === undefined || title === undefined ? (
        <p className="note pad">{loading ? '読み込んでいます…' : 'この道筋で通る処理がありません。'}</p>
      ) : (
        <article className={`scene-card tone-${scene.tone}`} aria-live="polite" aria-atomic="true">
          <p className="scene-where">
            <span className="scene-count">
              {at + 1} / {scenes.length}
            </span>
            <span className="scene-frame" title={frameName}>
              {scene.depth > 0 ? '↳ ' : ''}
              {frameName}
            </span>
            {TONE_WORDS[scene.tone] !== '' ? <span className={`tag tag-${scene.tone === 'error' ? 'error' : 'end'}`}>{TONE_WORDS[scene.tone]}</span> : null}
          </p>
          <h3 className="scene-title">
            {title.code ? <code className="mono">{title.text}</code> : <Inline text={title.text} />}
            {facts !== undefined ? <span className="chip scene-kind">{STEP_KIND_WORDS[facts.kind]}</span> : null}
            <FeatureBadge features={data.features} feature={feature} />
          </h3>
          {more !== undefined ? (
            <p className="scene-text">
              <Inline text={more} />
            </p>
          ) : null}
          {facts !== undefined && (facts.consumes.length > 0 || facts.produces.length > 0) ? (
            <p className="scene-values">
              {facts.consumes.length > 0 ? (
                <span>
                  <span className="flow-label">受け取る</span> {facts.consumes.map((name) => <code key={name} className="mono">{name}</code>)}
                </span>
              ) : null}
              {facts.produces.length > 0 ? (
                <span>
                  <span className="flow-label">→ 次へ渡す</span> {facts.produces.map((name) => <code key={name} className="mono">{name}</code>)}
                </span>
              ) : null}
            </p>
          ) : null}
          <ul className="scene-lines">{lines.slice(0, 8).map(line)}</ul>
          {lines.length > 8 ? <p className="note">ほか {lines.length - 8} 行（アウトラインで読めます）</p> : null}
          {callee !== undefined && inside.length > 0 && callStop?.event !== 'enters' ? (
            <details className="scene-inside">
              <summary>
                {callee.name}() が中で呼ぶ関数（{callee.calls.length}）
              </summary>
              <ol>
                {inside.map((fn) => (
                  <li key={fn.id}>
                    <code className="mono">{fn.name}()</code>
                    {fn.summary !== '' ? <span className="muted"> {firstSentence(fn.summary)}</span> : null}
                  </li>
                ))}
                {callee.calls.length > inside.length ? <li className="muted">ほか {callee.calls.length - inside.length} 個</li> : null}
              </ol>
            </details>
          ) : null}
          <div className="detail-actions">
            <button type="button" className="code-button" onClick={() => onOpenCode(scene.tree)}>
              コードを見る
            </button>
            <button type="button" className="code-button" onClick={() => onOutline(scene)}>
              アウトラインでこの行を読む
            </button>
          </div>
        </article>
      )}
      </div>

      <FlowRequest
        state={requests}
        premises={premises}
        // The request of a ready-made way the reader picked; a request run keeps the request it ran, whatever way its sides match.
        selection={run.state !== undefined || picked === -1 ? undefined : selections[picked]}
        keep={run.state !== undefined}
        generatedCase={generatedCase}
        assumed={assumedCount}
        framework={framework}
        endpoint={endpoint?.request}
        unrunnable={unrunnable}
        featuresOff={data.features.some((feature) => !enabled.has(feature.id))}
        run={run.state}
        ending={ending}
        onRun={(draft) => {
          playback.play(false);
          run.run(draft, generatedCase?.premises);
        }}
        onFollow={run.follow}
      />
      <p className="flow-foot">
        <button type="button" className="link" onClick={() => onOutline()}>
          ← アウトラインに戻る
        </button>
        <span className="note">{loading ? '読み込み中… · ' : ''}← → で前後、再生ボタンで自動再生</span>
      </p>
    </section>
  );
}
