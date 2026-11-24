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
export function sameChoice(a: Decisions, b: Decisions): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Identify a code path by the same fields its recorded requests use. */
export function selectionKey(selection: Pick<Selection, 'kind' | 'target' | 'name'>): string {
  return JSON.stringify([selection.kind, selection.target, selection.name]);
}

/** Find the chosen code path, or infer it from the decisions when they match exactly one path. */
export function scenarioOf(selections: readonly Selection[], choice: Decisions | undefined, way?: string): number {
  if (way !== undefined) return selections.findIndex((selection) => selectionKey(selection) === way && sameChoice(selection.decisions, choice ?? {}));
  if (choice === undefined) return -1;
  const first = selections.findIndex((selection) => sameChoice(selection.decisions, choice));
  return first !== -1 && !selections.some((selection, index) => index > first && sameChoice(selection.decisions, choice)) ? first : -1;
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

/** The speeds a playback offers (1 is the normal pace). */
export const SPEEDS = [0.5, 1, 2] as const;

/**
 * How long a scene stays before the playback moves on, in milliseconds, at
 * a speed: 2.6 s at the normal pace, time enough to read the card of the
 * scene and follow the token along its arrow (1.5 s was too quick to read).
 */
export function sceneDuration(speed: number): number {
  return Math.round(2600 / Math.max(0.25, speed));
}
