// This test reads the built map from the disk: tsconfig.node.json checks it with Node's types, which the page's tsconfig leaves out.
/**
 * The diagram of every frame of the built map (public/data, which
 * `pnpm run data` writes), every feature on, its words read from the map,
 * folded by the outline's rules as the trace draws it. It checks what holds
 * whatever code contributors write: no decision and no way to end a frame is
 * lost from the diagram, every region (the boxes a `try` guards) encloses its
 * boxes and no other, the diagram folds every step and every guard the way
 * the outline does, and the frames stay legible when the diagram fits the
 * pane (a coarse floor that only a broken fold crosses). The rest it prints,
 * as scripts/check-map.mjs prints its metrics. Without the built map (the
 * unit tests of CI) it is skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FlowTree, FrameChange, FrameFile, MapData, TreeNode } from '../types';
import { LEGIBLE_SCALE } from './camera';
import { boxLine, frameDiagram, layoutDiagram, type Diagram, type DiagramOptions } from './diagram';
import type { LayoutBox, LayoutGroup } from './graph';
import { branchesOf, changedIdsOf, EMPTY_TRACE, entryOf, findNode, foldsGuard, isDecision, nodesOn, stepCall, stepHolds, traceRows, type Row } from './trace';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '../../public/data');

/** The gesture areas the diagram is drawn in, by screen: it fits their width less 12px a side. */
const ROOMS = [
  { name: '1440x900', width: 472 },
  { name: '1280x800', width: 405 },
  { name: "a phone's drawer", width: 389 },
] as const;
/** The width the diagram fits into in the pane at 1440x900. */
const DESKTOP_FIT = ROOMS[0].width - 24;
/** The height of the gesture area at 1440x900, the unit the length of a root is measured in. */
const PANE_HEIGHT = 631;

/** A frame laid out: its size, what the diagram lost of it, how its regions sit, and how many of its titles show whole on their one line. */
interface Measured {
  id: string;
  width: number;
  height: number;
  boxWidth: number;
  lost: string[];
  /** The regions that leave out a box of theirs or take in another, in words. */
  misplaced: string[];
  /** The steps and guards the diagram folds otherwise than the outline, in words: as the page opens the frame, and with a change at every ninth node. */
  unlike: string[];
  regions: number;
  titles: number;
  titlesCut: number;
}

/** Whether a node ends the frame: a return outside a callback, or a throw. */
function isExit(node: TreeNode): boolean {
  return (node.kind === 'return' && node.local !== true) || node.kind === 'throw';
}

/** The decisions and the exits of a frame the diagram shows nowhere: neither a box, nor a region (a try), nor a row of either (its side, its ends), nor inside a folded step. */
function lostOf(tree: FlowTree, diagram: Diagram): string[] {
  const boxes = new Set([...diagram.nodes.flatMap((box) => (box.node === undefined ? [] : [box.node])), ...diagram.groups.map((group) => group.node)]);
  const rows = [...diagram.nodes, ...diagram.groups].flatMap((shape) => shape.rows);
  const sides = new Set(rows.flatMap((row) => (row.side === undefined ? [] : [row.side.node])));
  const ends = new Set(rows.flatMap((row) => row.ends));
  const folded = new Set([...diagram.nodes.flatMap((box) => (box.step !== undefined && !box.step.open ? [box.step.id] : [])), ...rows.flatMap((row) => (row.step === undefined ? [] : [row.step]))]);
  const lost: string[] = [];
  const walk = (nodes: readonly TreeNode[], inStep: boolean) => {
    for (const node of nodesOn(nodes, undefined)) {
      if (isDecision(node) && !inStep && !boxes.has(node.id) && !sides.has(node.id)) lost.push(`${tree.id} decision ${node.id}: ${node.code}`);
      if (isExit(node) && !inStep && !boxes.has(node.id) && !ends.has(node.id)) lost.push(`${tree.id} exit ${node.id}: ${node.code}`);
      const inside = inStep || folded.has(node.id);
      walk(node.pre ?? [], inside);
      for (const branch of branchesOf(node, undefined)) walk(branch.nodes, inside);
    }
  };
  walk(tree.nodes, false);
  return lost;
}

/** Whether two rectangles overlap (touching edges do not). */
function overlaps(a: LayoutBox | LayoutGroup, b: LayoutBox | LayoutGroup): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Whether a rectangle lies inside another with at least a margin around it. */
function encloses(outer: LayoutBox | LayoutGroup, inner: LayoutBox | LayoutGroup, margin: number): boolean {
  return inner.x - outer.x >= margin && inner.y - outer.y >= margin && outer.x + outer.width - (inner.x + inner.width) >= margin && outer.y + outer.height - (inner.y + inner.height) >= margin;
}

/** The options the trace gives the diagram of its root frame with nothing chosen, nothing opened and nothing toggled (Trace.tsx): the outline's rules. */
function outlineOptions(data: MapData, hasFrame: (fn: string) => boolean, change: FrameChange | undefined): DiagramOptions {
  const changedIds = changedIdsOf(change);
  return {
    changed: (node) => change?.marks[node] !== undefined,
    hasFrame,
    words: data,
    stepOpen: (node) => stepHolds('', node, EMPTY_TRACE, changedIds),
    stepCall: (node) => stepCall(node, undefined, hasFrame),
    foldsGuard: (node) => foldsGuard(node, undefined, hasFrame, (changed) => changedIds.includes(changed)),
  };
}

/** Whether a node is a guard or an optional item. */
function isGuard(node: TreeNode): boolean {
  return node.kind === 'if' && (node.form === 'guard' || node.form === 'optional');
}

/** How the outline and the diagram fold each step and each guard of the root frame: merged with its one call, open or folded; a guard on one line (folded) or in full. */
function folds(tree: FlowTree, rows: readonly Row[], diagram: Diagram): { outline: Map<string, string>; diagram: Map<string, string> } {
  const outline = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'node' || row.frame !== '') continue;
    if (row.step !== undefined) outline.set(row.node.id, row.step.merged ? 'merged' : row.step.open ? 'open' : 'folded');
    else if (isGuard(row.node)) outline.set(row.node.id, row.exit !== undefined ? 'folded' : 'full');
  }
  const drawn = new Map<string, string>();
  for (const box of diagram.nodes) {
    const node = box.node === undefined ? undefined : findNode(tree.nodes, box.node);
    if (node === undefined) continue;
    if (box.step !== undefined) drawn.set(node.id, box.step.open ? 'open' : box.step.toggles ? 'folded' : 'merged');
    else if (isGuard(node)) drawn.set(node.id, (node.branches?.find((branch) => branch.key === 'true')?.nodes ?? []).every((child) => box.holds.includes(child.id)) ? 'folded' : 'full');
  }
  return { outline, diagram: drawn };
}

/** The steps and guards of a frame the diagram folds otherwise than the outline, given the diff of the frame. */
function unlikeOutline(tree: FlowTree, data: MapData, hasFrame: (fn: string) => boolean, change: FrameChange | undefined, diagram = frameDiagram(tree, '', undefined, outlineOptions(data, hasFrame, change))): string[] {
  const rows = traceRows({ rootId: tree.id, hasFrame, trees: new Map([[tree.id, tree]]), changes: new Map(change === undefined ? [] : [[tree.id, change]]), state: EMPTY_TRACE });
  const both = folds(tree, rows, diagram);
  return [...new Set([...both.outline.keys(), ...both.diagram.keys()])]
    .filter((node) => both.outline.get(node) !== both.diagram.get(node))
    .map((node) => `${tree.id} ${node}${change === undefined ? '' : ' (changed)'}: outline ${both.outline.get(node) ?? 'none'}, diagram ${both.diagram.get(node) ?? 'none'}`);
}

/** A diff that marks every ninth node of a frame modified: what a pull request might change, to fold by. */
function everyNinth(tree: FlowTree): FrameChange {
  const marks: FrameChange['marks'] = {};
  let count = 0;
  const walk = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      count += 1;
      if (count % 9 === 0) marks[node.id] = 'modified';
      walk(node.pre ?? []);
      for (const branch of node.branches ?? []) walk(branch.nodes);
    }
  };
  walk(tree.nodes);
  return { kind: 'modified', marks, removed: [], exprs: {}, hunks: {}, summary: [] };
}

/** Lay out the diagram of a frame as the page opens it (the start of a trace, nothing chosen, the outline's rules) and measure it. */
function measure(id: string, tree: FlowTree, data: MapData, hasFrame: (fn: string) => boolean): Measured {
  const diagram = frameDiagram(tree, '', undefined, outlineOptions(data, hasFrame, undefined));
  const layout = layoutDiagram(diagram, new Set(diagram.edges.map((_, index) => index)), 'TB');
  const rect = new Map<string, LayoutBox | LayoutGroup>([...layout.boxes, ...layout.groups].map((placed) => [placed.id, placed]));
  const misplaced = diagram.groups.flatMap((group) => {
    const region = rect.get(group.id);
    if (region === undefined) return [`${id} ${group.id}: no rectangle`];
    const out = group.members.filter((member) => !encloses(region, rect.get(member) as LayoutBox, 8));
    const inside = diagram.nodes.filter((node) => !group.members.includes(node.id) && overlaps(region, rect.get(node.id) as LayoutBox));
    return [...out.map((member) => `${id} ${group.id}: ${member} outside`), ...inside.map((node) => `${id} ${group.id}: ${node.id} inside`)];
  });
  const boxes = diagram.nodes.filter((node) => node.tone !== 'start');
  return {
    id,
    width: layout.width,
    height: layout.height,
    boxWidth: layout.boxWidth,
    lost: lostOf(tree, diagram),
    misplaced,
    unlike: [...unlikeOutline(tree, data, hasFrame, undefined, diagram), ...unlikeOutline(tree, data, hasFrame, everyNinth(tree))],
    regions: diagram.groups.length,
    titles: boxes.length,
    titlesCut: boxes.filter((node) => boxLine(node, layout.boxWidth).cut).length,
  };
}

/** The scale the diagram of a frame fits a width at: never above 100%. */
function fitScale(frame: Measured, width: number): number {
  return Math.min(1, width / frame.width);
}

/** Whether box titles (12.5px) read 11px or more when the diagram fits a width. */
function legibleAt(frame: Measured, width: number): boolean {
  return fitScale(frame, width) >= LEGIBLE_SCALE - 1e-9;
}

/** The share of the frames whose titles read 11px or more when the diagram fits a width. */
function legibleShare(frames: readonly Measured[], width: number): number {
  return frames.filter((frame) => legibleAt(frame, width)).length / frames.length;
}

/** The scale the diagram of a frame opens at in a gesture area (see openingCamera): it fits the width, but never under LEGIBLE_SCALE. */
function openingScale(frame: Measured, room: number): number {
  return Math.max(LEGIBLE_SCALE, fitScale(frame, room - 24));
}

/** A count and its share, for the report. */
function share(part: number, whole: number): string {
  return `${part}/${whole} (${((part / whole) * 100).toFixed(1)}%)`;
}

/** The measures in words, printed with the result. */
function report(frames: readonly Measured[], roots: ReadonlySet<string>): string {
  const rootFrames = frames.filter((frame) => roots.has(frame.id));
  const panes = (frame: Measured) => (frame.height * openingScale(frame, ROOMS[0].width)) / PANE_HEIGHT;
  const count = (test: (frame: Measured) => boolean) => share(frames.filter(test).length, frames.length);
  const tallest = rootFrames.reduce<Measured | undefined>((best, frame) => (best === undefined || panes(frame) > panes(best) ? frame : best), undefined);
  const sum = (pick: (frame: Measured) => number) => frames.reduce((total, frame) => total + pick(frame), 0);
  const widths = [...new Set(frames.map((frame) => frame.boxWidth))].sort((a, b) => b - a).map((width) => `${width}px ${frames.filter((frame) => frame.boxWidth === width).length}`);
  return [
    `The diagram of ${frames.length} frames, every feature on: ${sum((frame) => frame.lost.length)} decisions or exits lost; boxes ${widths.join(', ')}`,
    ...ROOMS.map(
      ({ name, width }) =>
        `  ${name}, fit to ${width - 24}px: titles at 11px or more ${count((frame) => legibleAt(frame, width - 24))}, under 9px ${count((frame) => 12.5 * fitScale(frame, width - 24) < 9)}, ` +
        `at 100% ${count((frame) => fitScale(frame, width - 24) >= 1)}; wider than the ${width}px area at the opening scale ${count((frame) => frame.width * openingScale(frame, width) > width + 0.5)}`,
    ),
    `  endpoint roots at 11px or more at ${DESKTOP_FIT}px: ${rootFrames.filter((frame) => legibleAt(frame, DESKTOP_FIT)).length}/${rootFrames.length}; the tallest ${tallest === undefined ? '-' : `${tallest.id}, ${panes(tallest).toFixed(2)} panes of ${PANE_HEIGHT}px`}`,
    `  titles cut by the ellipsis on their one line ${share(sum((frame) => frame.titlesCut), sum((frame) => frame.titles))}, at 320px ${share(sum((frame) => (frame.boxWidth === 320 ? frame.titlesCut : 0)), sum((frame) => (frame.boxWidth === 320 ? frame.titles : 0)))}, at 200px ${share(sum((frame) => (frame.boxWidth === 200 ? frame.titlesCut : 0)), sum((frame) => (frame.boxWidth === 200 ? frame.titles : 0)))}`,
    `  regions (tries) ${sum((frame) => frame.regions)} in ${frames.filter((frame) => frame.regions > 0).length} frames; misplaced ${sum((frame) => frame.misplaced.length)}`,
  ].join('\n');
}

describe.skipIf(!existsSync(join(DATA, 'map.json')))('the diagram of every frame of the built map, every feature on', () => {
  let frames: Measured[] = [];

  beforeAll(() => {
    const data = JSON.parse(readFileSync(join(DATA, 'map.json'), 'utf8')) as MapData;
    const hasFrame = (id: string) => (entryOf(data, id)?.frame ?? '') !== '';
    const entries = new Map([...Object.values(data.functions), ...Object.values(data.bodies)].map((entry) => [entry.id, entry]));
    frames = [...entries.values()]
      .filter((entry) => entry.frame !== '')
      .map((entry) => {
        const file = JSON.parse(readFileSync(join(DATA, entry.frame.replace(/^\.\/data\//, '')), 'utf8')) as FrameFile;
        return measure(entry.id, file.tree, data, hasFrame);
      });
    const roots = new Set(Object.values(data.flows).flatMap((flow) => flow.endpoints.map((endpoint) => endpoint.root)).filter((root) => root !== ''));
    console.log(report(frames, roots));
  }, 300_000);

  it('should show every decision and every way to end a frame as a box, a region, a row or inside a folded step', () => {
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.flatMap((frame) => frame.lost)).toEqual([]);
  });

  it('should fold every step and every guard the way the outline does, as the page opens a frame and where a pull request changed it', () => {
    expect(frames.flatMap((frame) => frame.unlike)).toEqual([]);
  });

  it('should enclose the boxes of every region, and no other box, in its rectangle', () => {
    expect(frames.reduce((count, frame) => count + frame.regions, 0)).toBeGreaterThan(0);
    expect(frames.flatMap((frame) => frame.misplaced)).toEqual([]);
  });

  it('should keep box titles at 11px or more in at least 90% of the frames when the diagram fits the pane at 1440x900', () => {
    expect(legibleShare(frames, DESKTOP_FIT)).toBeGreaterThanOrEqual(0.9);
  });
});
