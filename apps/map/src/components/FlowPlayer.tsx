import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { FlowStep, MapData, Selection } from '../types';
import type { PartingLine } from '../lib/parting';
import { departureScene, STEP_KIND_WORDS, SPEEDS, sceneAt, sceneDuration, sceneLines, selectionKey, type FlowWalk, type Scene, type SceneLine, type WalkStop } from '../lib/playback';
import { briefBody, statusLine, statusTone } from '../lib/requests';
import { oauthErrorOf } from '../lib/run';
import { choose, entryOf, type TraceState } from '../lib/trace';
import { firstSentence } from '../lib/words';
import { Inline } from './ChangeParts';
import { FeatureBadge } from './FeatureBadge';
import { failureGroups } from './SelectionBar';
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
      // The node gone to is the one to stay on, should the scenes change before the next render shows it (frames a replay opens one after another).
      const target = next === 0 ? undefined : scenes[next];
      was.current = target === undefined ? undefined : { frame: target.frame, node: target.node.id };
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

/**
 * The stops of the way the playback showed before the request it follows
 * last changed (a run of a new id): read from the render before, since the
 * way the trace shows changes to the new run's only in the renders after
 * the run comes.
 */
function useWayBefore(runId: number | undefined, stops: readonly WalkStop[]): readonly WalkStop[] {
  const last = useRef(stops);
  const before = useRef<{ id: number | undefined; stops: readonly WalkStop[] }>({ id: runId, stops });
  if (before.current.id !== runId) before.current = { id: runId, stops: last.current };
  last.current = stops;
  return before.current.stops;
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
  /** The playback as the reader moves it (the controls, the keys, the line above the chart). */
  playback: Playback;
  /** The playback as the flow moves it on its own when the request followed changes (to its start, to where it parts): not the reader's move. */
  steer: Pick<Playback, 'go' | 'play'>;
  /** Whether the reader moved the playback since the run of an id came: the flow's own move for that run gives way. */
  readerMoved: (run: number) => boolean;
  /** The ready-made way played, by its index in `selections`; -1 for none (おまかせ, the reader's own sides, or the way of a request followed). */
  picked: number;
  /** The words a scene is named by: those of its box in the diagram. */
  titleOf: (scene: Scene) => { text: string; code: boolean };
  /** The endpoint whose root the trace starts from (see TraceProps.endpoint): a scene of one of its steps says the step's kind and values. */
  endpoint?: { id: string; name: string; steps: readonly FlowStep[]; request?: { method: string; path: string } } | undefined;
  /** The request the reader runs on the live OP, and what it gave (useRun.ts). */
  run: RequestRun;
  /** Where the request followed parts from the request it was edited from (lib/parting.ts), once read; undefined for a request read against none. */
  partings: readonly PartingLine[] | undefined;
  /**
   * The trace shows the way of the request the playback follows, every
   * frame it goes into loaded: the scenes are that way's, not those of the
   * way before on their way to it (see Trace).
   */
  settled: boolean;
  /** The ready-made way the request run ended by, in words, while the playback follows it. */
  ending: string | undefined;
  /** Why the playback shows no way, when it follows a request that did not run the root. */
  idle?: string | undefined;
  /** Whether a function has a frame the playback can go into. */
  hasFrame: (id: string) => boolean;
  /** Frames of the trace are still being read: the playback may grow. */
  loading: boolean;
  /** How many calls on the way the playback could still go into, and whether it is inside any. */
  deeper: number;
  canFold: boolean;
  onDeeper: () => void;
  onFold: () => void;
  /** Go into the frame of a call (by its frame key): the playback moves into it. Or come out of it. */
  onEnter: (key: string) => void;
  onLeave: (key: string) => void;
  onOpenCode: (id: string) => void;
  /** Leave the flow view for the outline, on a scene's row when one is given. */
  onOutline: (scene?: Scene) => void;
  /** The chart of the frame shown: drawn between the controls and the scene. */
  children: ReactNode;
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
 * The player of the flow view, around the chart of the frame it shows:
 * above it, which way the request takes (a ready-made choice, the sides the
 * reader chose, or the way a request took on the live OP), the controls of
 * the playback and, for a request followed, what it answered and how it
 * ended; below it, what happens in the scene shown, in the words the
 * outline uses. A node of the chart goes to its scene. The request itself is
 * written beside the stage (FlowRequest).
 *
 * A decision the way does not decide is taken on an assumed side, marked 仮:
 * its other sides are buttons, and taking one makes it part of the way (the
 * same choice the outline's side buttons make). A call that has a frame can
 * be gone into: the request goes through that function too, and the
 * playback moves to its first scene.
 *
 * The playback follows the request: a request sent or opened plays its way
 * from the start; one the editor came to (a preview of an edit, a request
 * sent before that the reader came back to) stops the playback and moves it
 * to where the new way departs from the way shown before (the places where
 * the request parts from the one it was edited from, when read against it,
 * else lib/playback.ts departureScene), and stays when it does not depart.
 */
export function FlowPlayer({ data, selections, state, onState, enabled, walked, scenes, playback, steer, readerMoved, picked, titleOf, endpoint, hasFrame, loading, deeper, canFold, onDeeper, onFold, onEnter, onLeave, onOpenCode, onOutline, run, partings, settled, ending, idle, children }: FlowPlayerProps) {
  const { at, playing, speed } = playback;
  const scene = scenes[at];
  const choice = state.choices[0];
  // While the playback follows the way of a request run, that is the way chosen, ready-made or not.
  const ran = run.state?.status === 'done' && run.state.follow;
  const custom = !ran && picked === -1 && choice !== undefined && Object.keys(choice).length > 0;
  // A request run (or an exchange opened) plays the way it took from the start, once that way is read. One sent that was read against the request
  // it was edited from plays from the first place the two part, once read: the scenes before it are those of the request before the edits, and
  // a playback from the start showed nothing of the edit for half a minute (an introspected token the OP does not know answers 200 as one it knows).
  // One the editor's request came to (a preview of an edit, or a request sent before that it came back to) does not play on its own:
  // a playback still playing the way before stops there, and moves to where the new way departs from it (below).
  // A move the reader made since the run came (End, a node of the chart, a place it parts) stands: the flow does not take the playback back.
  const played = useRef(0);
  useEffect(() => {
    const ranState = run.state;
    if (ranState?.status !== 'done' || !ranState.follow || run.replay === undefined || played.current === ranState.id) return;
    if (ranState.quiet === true) {
      played.current = ranState.id;
      steer.play(false);
      return;
    }
    if (readerMoved(ranState.id)) {
      played.current = ranState.id;
      return;
    }
    if (ranState.against !== undefined && run.replay.rootRan) {
      if (!settled || partings === undefined) return;
      const first = partings[0];
      if (first !== undefined && first.scene === undefined) return;
      played.current = ranState.id;
      steer.go(first?.scene ?? 0);
      steer.play(true);
      return;
    }
    played.current = ranState.id;
    steer.go(0);
    if (run.replay.rootRan) steer.play(true);
  }, [run.state, run.replay, settled, partings, steer, readerMoved]);
  // The editor's request changed the way: once the trace shows the new way, the playback moves to where it departs from the way shown before.
  // A request read against the one it was edited from parts at the places read (its frames open with the replay); else the scenes tell (departureScene).
  const wayBefore = useWayBefore(run.state?.status === 'done' ? run.state.id : undefined, walked.stops);
  const moved = useRef(0);
  useEffect(() => {
    const ranState = run.state;
    if (ranState?.status !== 'done' || !ranState.follow || ranState.quiet !== true || moved.current === ranState.id) return;
    // The request as a case prepared it, or as it was sent or opened, is no edit: the playback stays where it is (at the start, for a case just picked).
    if (ranState.edited !== true || readerMoved(ranState.id)) {
      moved.current = ranState.id;
      return;
    }
    if (!settled || (ranState.against !== undefined && partings === undefined)) return;
    const first = partings?.[0];
    if (first !== undefined && first.scene === undefined) return;
    moved.current = ranState.id;
    const target = first?.scene ?? departureScene(wayBefore, scenes);
    if (target !== undefined) steer.go(target);
  }, [run.state, settled, partings, wayBefore, scenes, steer, readerMoved]);
  const pick = (value: string) => {
    if (value === 'run' || value === 'custom') return;
    playback.play(false);
    playback.go(0);
    // Another way leaves the way of the request run.
    run.forget();
    if (value === 'auto') {
      onState({ ...state, open: [], choices: [], way: undefined, request: undefined, exchange: undefined, previewed: undefined, focus: '' });
      return;
    }
    const selection = selections[Number(value)];
    if (selection === undefined) return;
    // A way is played on its own: its frames open, its sides chosen, from the start.
    onState({ ...state, open: [...(selection.frames ?? [])], choices: [selection.decisions], way: selectionKey(selection), request: undefined, exchange: undefined, previewed: undefined, focus: '' });
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
          <span className="line-actions">
            <button type="button" className="link small" onClick={() => onEnter(frameKey)} title="この関数の中へ進む（図がその関数に移り、再生は中の最初の場面へ進む）">
              {item.kind === 'enters' ? '中へ進む ▸' : '中に入る ▸'}
            </button>
            {item.kind === 'enters' ? (
              <button type="button" className="link small" onClick={() => onLeave(frameKey)} title="この関数の中を通らずに、呼び出しの一行として進む">
                中を閉じる
              </button>
            ) : null}
          </span>
        ) : null}
      </li>
    );
  };

  // What the request the playback follows answered, and how its way ends, on one line above the chart: the edits of the request show here as they land.
  const now = (() => {
    const shown = run.state;
    const pending = run.previewing ? <span className="flow-now-pending">試算中…</span> : null;
    if (shown === undefined) return pending === null ? null : <p className="flow-now">{pending}</p>;
    if (shown.status === 'running') return <p className="flow-now"><span className="flow-label">{shown.opening !== undefined ? '読み込み中' : '送っています…'}</span></p>;
    if (shown.status === 'failed') return <p className="flow-now req-problem">{shown.unreachable ? '地図の OP に接続できません' : '実行できませんでした'}（理由は「リクエスト」の欄にあります）{pending}</p>;
    const { response } = shown.exchange;
    const error = response === undefined ? undefined : oauthErrorOf(response);
    const brief = briefBody(response?.body);
    const label = shown.preview === true ? '試算' : shown.opened ? `開いたリクエスト ${shown.exchange.id}` : `実行したリクエスト ${shown.exchange.id}`;
    // Where it parts from the request it was edited from: what the edit changed, though the answer may read the same (an introspected token active or not, both 200).
    const first = partings?.[0];
    const parting =
      !shown.follow || partings === undefined ? null : first === undefined ? (
        <span className="flow-now-parting">書き換える前と同じ道筋</span>
      ) : (
        <span className="flow-now-parting">
          書き換える前と分かれる所:
          <button
            type="button"
            className="link small"
            disabled={first.scene === undefined}
            title="この場面へ移る"
            onClick={() => {
              if (first.scene === undefined) return;
              playback.play(false);
              playback.go(first.scene);
            }}
          >
            {first.name}
          </button>
          {partings.length > 1 ? `ほか ${partings.length - 1} か所` : ''}
        </span>
      );
    return (
      <p className="flow-now" title={shown.preview === true ? '送る前の試算（地図の OP の今の状態のコピーで動かしました。OP の状態は変えていません）' : undefined}>
        <span className="flow-label">{label}</span>
        {response === undefined ? <span className="req-status req-error">応答なし</span> : <span className={`req-status req-${statusTone(response.status)}`}>{statusLine(response)}</span>}
        {error !== undefined ? <code className="mono req-error-code">{error}</code> : null}
        {brief !== undefined && error === undefined ? <code className="mono flow-now-body" title="応答のボディ">{brief}</code> : null}
        {!shown.follow ? (
          <button type="button" className="link small" onClick={run.follow} title="ほかの側や道筋を選んだので、再生はこのリクエストの道筋から離れています">
            このリクエストの道筋に戻す
          </button>
        ) : ending !== undefined && scenes.length > 0 ? (
          <button type="button" className="link small flow-now-ending" title="この道筋の終わりの場面へ移る" onClick={() => { playback.play(false); playback.go(scenes.length - 1); }}>
            {ending}
          </button>
        ) : null}
        {parting}
        {pending}
      </p>
    );
  })();

  return (
    <>
      <section className="flow-player" aria-label="フローの再生" onKeyDown={onKey}>
        <div className="flow-controls">
          <div className="flow-row">
            <label className="flow-way">
              <span className="flow-label">コードの道筋</span>
              <select value={ran ? 'run' : picked !== -1 ? String(picked) : custom ? 'custom' : 'auto'} onChange={(event) => pick(event.target.value)}>
                <option value="auto">おまかせ（分岐は仮の側へ進む）</option>
                {ran ? <option value="run">{run.state?.status === 'done' && run.state.preview === true ? 'このリクエストを送ると通る道筋（試算）' : '実行したリクエストが通った道筋'}</option> : null}
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
            <div className="flow-depth">
              <span className="flow-label">呼び出しの中</span>
              <button type="button" className="code-button" disabled={deeper === 0} onClick={onDeeper} title="道筋にある関数呼び出しを、もう一段、中まで通る">
                一段深く{deeper > 0 ? `（${deeper}）` : ''}
              </button>
              <button type="button" className="code-button" disabled={!canFold} onClick={onFold} title="いちばん深い段を閉じる">
                一段浅く
              </button>
              {loading ? <span className="note">読み込み中…</span> : null}
            </div>
          </div>
          <div className="flow-row">
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
            <div className="flow-position">
              <input
                className="flow-scrub"
                type="range"
                min={0}
                max={Math.max(0, scenes.length - 1)}
                value={at}
                aria-label="再生の位置"
                aria-valuetext={scene === undefined ? '' : `${at + 1} / ${scenes.length}: ${title?.text ?? ''}`}
                title="← → で前後、Home と End で最初と最後"
                onChange={(event) => {
                  playback.play(false);
                  playback.go(Number(event.target.value));
                }}
              />
              <span className="flow-count" aria-hidden="true">
                {scenes.length === 0 ? '0 / 0' : `${at + 1} / ${scenes.length}`}
              </span>
            </div>
          </div>
        </div>
        {now}
      </section>
      {children}
      <section className="flow-scene" aria-label="いまの場面" onKeyDown={onKey}>
        {scene === undefined || title === undefined ? (
          <p className="note pad">{idle ?? (loading ? '読み込んでいます…' : 'この道筋で通る処理がありません。')}</p>
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
      </section>
    </>
  );
}
