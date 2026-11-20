/**
 * The playback of a trace: one request followed through the frames the
 * outline opened, a scene at a time. A walk (packages/map-analysis walk.ts)
 * gives the nodes the request reaches in the order they run; a scene is one
 * visit of a box of the diagram, the stops that box stands for read
 * together, so the playback moves the way the diagram is drawn. Nothing here
 * touches the DOM.
 *
 * - The walk follows the first choice of the trace (a way picked from the
 *   ready-made choices, or the sides the reader chose) and assumes a side
 *   where that choice names none; a scene says which sides were assumed, so
 *   the reader can take another.
 * - It goes into the frames the trace has open, and nowhere else: opening a
 *   call (in the outline, or from a scene) is what makes the request go in.
 */
import { walkFlow, type FlowWalk, type WalkStop } from '@maronn-openid-connect/map-analysis/walk';
import type { Branch, Decisions, FlowTree, Selection, StepKind, TreeNode } from '../types';
import { branchesOf, childFrame } from './trace';
import { nodeWords, sideLabel, splitPre, type WordSource } from './words';

export type { FlowWalk, WalkStop };

/** How a scene reads at a glance: the request goes on, the endpoint answers, something fails, or a catch takes a failure. */
export type SceneTone = 'normal' | 'end' | 'error' | 'caught';

/** One visit of a box of a frame's diagram: the stops of the walk that box stands for, in the order they run. */
export interface Scene {
  /** Its place in the playback, from 0. */
  index: number;
  /** The key of the frame it is in, and the id of that frame's tree. */
  frame: string;
  tree: string;
  /** How many frames below the root it is. */
  depth: number;
  /** The box or the region of the frame's diagram that shows it (`n:<node>`, `g:<try>`); undefined when the diagram shows none of its nodes. */
  shape?: string;
  /** The node it is named by and brought into view by: that of its first stop. */
  node: TreeNode;
  stops: WalkStop[];
  tone: SceneTone;
  /** The step of its frame it is in. */
  step?: string;
}

/** What a walk reads besides its tree and its choice (see walkTrace). */
export interface WalkInput {
  /** The frames the trace has open, by key: the walk goes into these. */
  open: readonly string[];
  /** The trees loaded, by frame id. */
  trees: ReadonlyMap<string, FlowTree>;
  enabled?: ReadonlySet<string>;
}

/** Walk the root of a trace along a choice, into the frames the trace has open whose trees are loaded. */
export function walkTrace(root: FlowTree, choice: Decisions, input: WalkInput): FlowWalk {
  const open = new Set(input.open);
  return walkFlow(root, choice, {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    enter: (key, call) => (open.has(key) && call.target?.kind === 'function' ? input.trees.get(call.target.id) : undefined),
  });
}

/** How the stops of a scene read together. */
function toneOf(stops: readonly WalkStop[]): SceneTone {
  if (stops.some((stop) => stop.event === 'throws' || stop.event === 'fails')) return 'error';
  if (stops.some((stop) => stop.event === 'catches')) return 'caught';
  if (stops.some((stop) => stop.depth === 0 && (stop.event === 'returns' || stop.event === 'ends'))) return 'end';
  return 'normal';
}

/**
 * The scenes of a walk: its stops, the ones in a row that one shape of
 * their frame's diagram shows read as one scene. `shapeOf` names that shape
 * (the box or the region that shows a node of a frame); a stop no shape
 * shows is a scene of its own.
 */
export function scenesOf(walked: Pick<FlowWalk, 'stops'>, shapeOf: (stop: WalkStop) => string | undefined): Scene[] {
  const scenes: Scene[] = [];
  for (const stop of walked.stops) {
    const shape = shapeOf(stop);
    const last = scenes[scenes.length - 1];
    if (last !== undefined && shape !== undefined && last.shape === shape && last.frame === stop.frame) {
      last.stops.push(stop);
      last.tone = toneOf(last.stops);
      continue;
    }
    scenes.push({ index: scenes.length, frame: stop.frame, tree: stop.tree, depth: stop.depth, ...(shape === undefined ? {} : { shape }), node: stop.node, stops: [stop], tone: toneOf([stop]), ...(stop.step === undefined ? {} : { step: stop.step }) });
  }
  return scenes;
}

/**
 * The scene a playback is at after its scenes changed (a side taken, a frame
 * opened): the first scene that holds the node it was at, else the scene at
 * the same place, kept inside the list; 0 for an empty list.
 */
export function sceneAt(scenes: readonly Scene[], was: { frame: string; node: string } | undefined, index: number): number {
  if (was !== undefined) {
    const found = scenes.findIndex((scene) => scene.frame === was.frame && scene.stops.some((stop) => stop.node.id === was.node));
    if (found !== -1) return found;
  }
  return Math.max(0, Math.min(scenes.length - 1, index));
}

/** One thing a scene says, a stop of it in words. */
export interface SceneLine {
  /** does: a call or a statement runs; side: a decision takes a side; the others are WalkStop.event. */
  kind: 'does' | 'side' | 'enters' | 'returns' | 'ends' | 'throws' | 'fails' | 'catches';
  /** What happens, in words; code where there are none (`code` says so). */
  text: string;
  code: boolean;
  stop: WalkStop;
  /** For a side: the decision (its key), the side taken, whether the walk assumed it, and every side the reader could take. */
  decision?: { key: string; taken: string; assumed: boolean; sides: Array<{ key: string; label: string }> };
  /** For a failure: what fails, when the tree names it. */
  error?: string;
}

/** The decision key of a stop's node. */
export function stopKey(stop: Pick<WalkStop, 'frame' | 'node'>): string {
  return childFrame(stop.frame, stop.node.id);
}

/**
 * What a scene says, a line a stop (see SceneLine). The heading of a step
 * says nothing its scene's title does not, so it has no line unless it is
 * alone; a decision reads as its condition and the side taken, with the
 * other sides the features leave.
 */
export function sceneLines(scene: Scene, source: WordSource, enabled?: ReadonlySet<string>): SceneLine[] {
  const lines: SceneLine[] = [];
  for (const stop of scene.stops) {
    const { node } = stop;
    if (node.kind === 'block' && scene.stops.length > 1) continue;
    const said = nodeWords(node, source, splitPre(node).call);
    const base = { text: said.text, code: said.code, stop };
    if (stop.event === 'catches') {
      lines.push({ ...base, kind: 'catches', text: '例外を catch が受け取る', code: false, ...(stop.error === undefined ? {} : { error: stop.error }) });
      continue;
    }
    if (stop.side !== undefined) {
      const sides = branchesOf(node, enabled)
        .filter((branch: Branch) => branch.always !== true)
        .map((branch: Branch) => ({ key: branch.key, label: sideLabel(node, branch) }));
      lines.push({ ...base, kind: 'side', decision: { key: stopKey(stop), taken: stop.side.key, assumed: stop.side.assumed, sides } });
      continue;
    }
    if (stop.event === 'throws' || stop.event === 'fails') {
      lines.push({ ...base, kind: stop.event, ...(stop.error === undefined ? {} : { error: stop.error }) });
      continue;
    }
    lines.push({ ...base, kind: stop.event ?? 'does' });
  }
  return lines;
}

/** The calls a walk steps over that have a frame it could go into, by the key of that frame, each once; a call of its own frame (recursion) is left out, since the walk never enters it. */
export function callsToEnter(walked: Pick<FlowWalk, 'stops'>, hasFrame: (id: string) => boolean): string[] {
  const keys: string[] = [];
  for (const stop of walked.stops) {
    const target = stop.node.target;
    if (stop.node.kind !== 'call' || stop.event === 'enters' || target?.kind !== 'function' || !hasFrame(target.id) || target.id === stop.tree) continue;
    const key = stopKey(stop);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** How many calls deep a frame key is: 0 for the root. */
export function depthOf(key: string): number {
  return key === '' ? 0 : key.split('.').length;
}

/** The frames a trace has open without its deepest ones: one level folded back. */
export function withoutDeepest(open: readonly string[]): string[] {
  const deepest = Math.max(0, ...open.map(depthOf));
  return open.filter((key) => depthOf(key) < deepest);
}

/** Whether two choices choose the same sides. */
function sameChoice(a: Decisions, b: Decisions): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** The ready-made choice a trace is on: the first whose sides are exactly those of the choice the playback follows; -1 for none. */
export function scenarioOf(selections: readonly Selection[], choice: Decisions | undefined): number {
  if (choice === undefined) return -1;
  return selections.findIndex((selection) => sameChoice(selection.decisions, choice));
}

/** What a step of an endpoint does, by its kind, as a short label. */
export const STEP_KIND_WORDS: Record<StepKind, string> = {
  parse: '読み取り',
  resolve: '解決',
  validate: '検証',
  decide: '判断',
  dispatch: '振り分け',
  issue: '発行',
  persist: '保存',
  transform: '変換',
  respond: '応答',
};

/** How long a scene stays before the playback moves on, in milliseconds, at a speed (1 is the normal pace). */
export function sceneDuration(speed: number): number {
  return Math.round(1500 / Math.max(0.25, speed));
}

/** What a scene does on the way, in a few words: a line of the summary of the way (see sceneGist). */
export interface SceneGist {
  /** The kind of the endpoint's step the scene is the box of, in words (検証). */
  kind?: string;
  /** What that step hands on. */
  hands?: string[];
  /** The sides its decisions take, in words, and whether the walk assumed them. */
  sides: Array<{ label: string; assumed: boolean }>;
  /** It goes into the frame of a call. */
  enters: boolean;
  /** How it ends its frame or fails, in words where code is set in code marks: `x` を返して終わる, a failure, a catch. */
  end?: { tone: 'end' | 'error' | 'caught'; text: string };
}

/** The value a return returns, as code: `return respondToken(c, x);` → `respondToken(c, x)`; '' for none. */
export function returnedValue(code: string): string {
  return code.replace(/\s+/g, ' ').trim().replace(/^return\b\s*/, '').replace(/;$/, '').trim();
}

/** How a return reads in a line of the way: `` `value` を返して終わる ``, or ここで終わる for a return of nothing. */
function returnLine(code: string): string {
  const value = returnedValue(code);
  return value === '' ? 'ここで終わる' : `\`${value}\` を返して終わる`;
}

/**
 * What a scene does (see SceneGist): the kind and the values of the step
 * whose box it is (`step`, given for a scene of an endpoint's root frame),
 * the sides its decisions take, whether it goes into a call, and how it
 * ends: a return, a failure thrown or come up through a call, a catch.
 */
export function sceneGist(scene: Scene, step?: { kind: StepKind; produces: readonly string[] }): SceneGist {
  const gist: SceneGist = { sides: [], enters: scene.stops.some((stop) => stop.event === 'enters') };
  if (step !== undefined && scene.node.step?.id === scene.step) {
    gist.kind = STEP_KIND_WORDS[step.kind];
    if (step.produces.length > 0) gist.hands = [...step.produces];
  }
  for (const stop of scene.stops) {
    if (stop.side !== undefined && stop.event !== 'catches') gist.sides.push({ label: stop.side.label, assumed: stop.side.assumed });
  }
  const caught = scene.stops.find((stop) => stop.event === 'catches');
  const failed = scene.stops.find((stop) => stop.event === 'throws' || stop.event === 'fails');
  const returned = scene.stops.find((stop) => stop.event === 'returns' || stop.event === 'ends');
  const ending = returned === undefined ? undefined : returned.event === 'ends' ? '最後まで進んで終わる' : returnLine(returned.node.code);
  if (caught !== undefined) gist.end = { tone: 'caught', text: `例外${caught.error === undefined ? '' : ` \`${caught.error}\` `}を受け取る${ending === undefined ? '' : `、${ending}`}` };
  else if (failed !== undefined) gist.end = { tone: 'error', text: `失敗${failed.error === undefined ? '' : ` \`${failed.error}\``}${failed.event === 'fails' ? '（ここで失敗する）' : ''}` };
  else if (ending !== undefined) gist.end = { tone: 'end', text: ending };
  return gist;
}

/**
 * How a whole way ends, in words where code is set in code marks: the value
 * its root returns (`` `respondToken(c, x)` を返して終わる ``), a failure its
 * root caught and answered with what it returns (`` 失敗 `TokenError(…)` →
 * `respondTokenError(c, e)` で応答して終わる ``; `answers` for the root of an
 * endpoint, else を返して終わる), or a failure that leaves it.
 */
export function wayEnding(walked: Pick<FlowWalk, 'stops' | 'outcome' | 'error'>, answers: boolean): { tone: 'end' | 'error' | 'caught'; text: string } {
  const failure = walked.stops.find((stop) => stop.event === 'throws' || stop.event === 'fails');
  if (walked.outcome === 'fails') {
    const error = walked.error ?? failure?.error;
    return { tone: 'error', text: `失敗${error === undefined ? '' : ` \`${error}\` `}が外へ出る` };
  }
  const roots = walked.stops.filter((stop) => stop.depth === 0);
  const last = [...roots].reverse().find((stop) => stop.event === 'returns' || stop.event === 'ends');
  const caught = roots.find((stop) => stop.event === 'catches');
  if (last === undefined || last.event === 'ends') return { tone: caught === undefined ? 'end' : 'caught', text: '最後まで進んで終わる' };
  if (caught !== undefined) {
    const error = caught.error ?? failure?.error;
    const value = returnedValue(last.node.code);
    const answer = answers ? 'で応答して終わる' : 'を返して終わる';
    return { tone: 'caught', text: `失敗${error === undefined ? '' : ` \`${error}\``} → ${value === '' ? answer.replace(/^[でを]/, '') : `\`${value}\` ${answer}`}` };
  }
  return { tone: 'end', text: returnLine(last.node.code) };
}
