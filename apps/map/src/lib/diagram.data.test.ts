// This test reads the built map from the disk: tsconfig.node.json checks it with Node's types, which the page's tsconfig leaves out.
/**
 * The diagram of every frame of the built map (public/data, which
 * `pnpm run data` writes), every feature on. It checks what holds whatever
 * code contributors write: no decision and no way to end a frame is lost
 * from the diagram, and the frames stay legible when the diagram fits the
 * pane (a coarse floor that only a broken fold crosses). The rest it prints,
 * as scripts/check-map.mjs prints its metrics. Without the built map (the
 * unit tests of CI) it is skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FlowTree, FrameFile, MapData, TreeNode } from '../types';
import { LEGIBLE_SCALE } from './camera';
import { boxHeight, frameDiagram, type Diagram } from './diagram';
import { BOX_HEIGHT, compactArguments, layoutGraph, textColumns, wrapColumns } from './graph';
import { branchesOf, entryOf, isDecision, nodesOn } from './trace';

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
/** The pixels a column of a title and of a row takes, as FlowDiagram draws them (12.5px and 12px text). */
const TITLE_COLUMN = 7;
const ROW_COLUMN = 6.7;

/** A frame laid out: its size, what the diagram lost of it, and how many of its titles and rows show whole. */
interface Measured {
  id: string;
  width: number;
  height: number;
  boxWidth: number;
  lost: string[];
  titles: number;
  titlesWhole: number;
  rows: number;
  rowsWhole: number;
}

/** Whether a node ends the frame: a return outside a callback, or a throw. */
function isExit(node: TreeNode): boolean {
  return (node.kind === 'return' && node.local !== true) || node.kind === 'throw';
}

/** The decisions and the exits of a frame the diagram shows nowhere: neither a box, nor a row (its side, its ends), nor inside a folded step. */
function lostOf(tree: FlowTree, diagram: Diagram): string[] {
  const boxes = new Set(diagram.nodes.flatMap((box) => (box.node === undefined ? [] : [box.node])));
  const rows = diagram.nodes.flatMap((box) => box.rows);
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

/** Lay out the diagram of a frame as the page opens it (the start of a trace, nothing chosen) and measure it. */
function measure(id: string, tree: FlowTree, hasFrame: (fn: string) => boolean): Measured {
  const diagram = frameDiagram(tree, '', undefined, { hasFrame });
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]));
  const layout = layoutGraph(diagram.nodes, diagram.edges, new Set(diagram.edges.map((_, index) => index)), 'TB', {
    height: (box, width) => {
      const node = byId.get(box);
      return node === undefined ? BOX_HEIGHT : boxHeight(node, width);
    },
  });
  const titleColumns = Math.floor((layout.boxWidth - 24) / TITLE_COLUMN);
  const rowColumns = Math.floor((layout.boxWidth - 24) / ROW_COLUMN);
  const boxes = diagram.nodes.filter((node) => node.tone !== 'start');
  const rows = boxes.flatMap((node) => node.rows);
  const bare = (text: string) => text.replace(/\s/g, '');
  return {
    id,
    width: layout.width,
    height: layout.height,
    boxWidth: layout.boxWidth,
    lost: lostOf(tree, diagram),
    titles: boxes.length,
    titlesWhole: boxes.filter((node) => bare(wrapColumns(node.title, titleColumns, 2).join('')) === bare(node.title)).length,
    rows: rows.length,
    rowsWhole: rows.filter((row) => textColumns(row.text) <= rowColumns || textColumns(compactArguments(row.text)) <= rowColumns).length,
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
    `  titles whole in two lines ${share(sum((frame) => frame.titlesWhole), sum((frame) => frame.titles))}; rows whole (calls' arguments left out where needed) ${share(sum((frame) => frame.rowsWhole), sum((frame) => frame.rows))}`,
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
        return measure(entry.id, file.tree, hasFrame);
      });
    const roots = new Set(Object.values(data.flows).flatMap((flow) => flow.endpoints.map((endpoint) => endpoint.root)).filter((root) => root !== ''));
    console.log(report(frames, roots));
  }, 300_000);

  it('should show every decision and every way to end a frame as a box, a row or inside a folded step', () => {
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.flatMap((frame) => frame.lost)).toEqual([]);
  });

  it('should keep box titles at 11px or more in at least 90% of the frames when the diagram fits the pane at 1440x900', () => {
    expect(legibleShare(frames, DESKTOP_FIT)).toBeGreaterThanOrEqual(0.9);
  });
});
