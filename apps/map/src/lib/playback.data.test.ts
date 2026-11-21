// This test reads the built map from the disk: tsconfig.node.json checks it with Node's types, which the page's tsconfig leaves out.
/**
 * The playback of every ready-made choice of every endpoint of the built map
 * (public/data, which `pnpm run data` writes), every feature on, its frames
 * open as the choice opens them. It checks what the flow view relies on,
 * whatever code contributors write: the walk reaches the node each choice
 * leads to, every stop of it has a box (or a region) of its frame's diagram
 * to play on, and the diagram colors every stop when it is given the sides
 * the walk resolved. The flow view's chart (flowchart.ts) of each frame has
 * a node for every scene, a terminal for every way a box ends the frame, and
 * every scene that returns or throws ends at one; every chart (each frame the
 * playback goes through, and every endpoint's root as the flow view opens
 * it) lays out, top to bottom and left to right, with no node over another,
 * no arrow through a node but its two ends, no label over a node or another
 * label, and every exit beside its box. Without the built map (the unit tests
 * of CI) it is skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FlowEndpoint, FlowTree, FrameFile, MapData, TreeNode } from '../types';
import { boxOf, frameDiagram, type Diagram } from './diagram';
import { chartWay, flowChart, layoutChart, type Chart } from './flowchart';
import type { LayoutBox, LayoutPoint } from './graph';
import { scenesOf, stopKey, walkTrace } from './playback';
import { entryOf, foldsGuard, frameIds, nodesRun, stepCall, stepHolds } from './trace';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '../../public/data');

/** What the playback of the choices of the endpoints came to. */
interface Played {
  choices: number;
  scenes: number;
  /** The choices whose walk does not reach the node they lead to. */
  astray: string[];
  /** The stops no box and no region of their frame's diagram shows. */
  homeless: string[];
  /** The stops the diagram would leave grey with the sides the walk resolved. */
  grey: string[];
  /** The scenes whose shape is no node and no region of the chart of their frame. */
  unplayable: string[];
  /** The rows of a box or a region that end the frame with no terminal node in the chart. */
  exitless: string[];
  /** The scenes that return or throw neither at a terminal nor through an exit of their node. */
  unended: string[];
}

/** The chart of a frame, as the flow view draws it: the root of an endpoint starts at the endpoint and says what its steps hand on. */
function chartOf(diagram: Diagram, tree: FlowTree, frame: string, data: MapData, endpoint: FlowEndpoint | undefined): Chart {
  return flowChart(diagram, tree, { words: data, ...(frame === '' && endpoint !== undefined ? { steps: endpoint.steps, start: `${endpoint.methods.join(' | ')} ${endpoint.path}`, answers: true } : {}) });
}

/** The rows of the boxes and the regions of a diagram that end the frame and have no terminal node in its chart. */
function exitsMissing(diagram: Diagram, chart: Chart): string[] {
  const nodes = new Set(chart.nodes.map((node) => node.id));
  return [...diagram.nodes, ...diagram.groups].flatMap((shape) => shape.rows.flatMap((row, index) => (row.tone !== 'pass' && !nodes.has(`x:${shape.id}|${index}`) ? [`${diagram.key} ${shape.id}|${index}`] : [])));
}

/** What the layout of the charts came to. */
interface Placed {
  /** The charts laid out, each once: their nodes and their frame. */
  seen: Set<string>;
  /** Two nodes over one another. */
  overlapping: string[];
  /** An exit not beside its box: not wholly on one side of it across the flow, or further from it along the flow than its own size. */
  astray: string[];
  /** An arrow through a node that is not one of its two ends. */
  crossing: string[];
  /** The label of an arrow over a node or over another label. */
  covered: string[];
}

/** A rectangle of the layout. */
type Area = Pick<LayoutBox, 'x' | 'y' | 'width' | 'height'>;

/** Whether two rectangles overlap by more than `inset`. */
function overlap(a: Area, b: Area, inset = 0): boolean {
  return a.x < b.x + b.width - inset && b.x < a.x + a.width - inset && a.y < b.y + b.height - inset && b.y < a.y + a.height - inset;
}

/** Whether the segment from `a` to `b` runs through a rectangle shrunk by `inset` on every side (Liang–Barsky clipping), so an arrow that only meets its border does not count. */
function crosses(a: LayoutPoint, b: LayoutPoint, area: Area, inset = 2): boolean {
  const sides: Array<[number, number]> = [
    [a.x - b.x, a.x - (area.x + inset)],
    [b.x - a.x, area.x + area.width - inset - a.x],
    [a.y - b.y, a.y - (area.y + inset)],
    [b.y - a.y, area.y + area.height - inset - a.y],
  ];
  let enter = 0;
  let leave = 1;
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q <= 0) return false;
    } else if (p < 0) enter = Math.max(enter, q / p);
    else leave = Math.min(leave, q / p);
  }
  return leave - enter > 1e-6;
}

/** Lay out a chart once in each direction and check it (see Placed). */
function checkLayout(chart: Chart, name: string, into: Placed): void {
  const signature = `${chart.key} ${chart.nodes.map((node) => node.id).join(',')}`;
  if (into.seen.has(signature)) return;
  into.seen.add(signature);
  for (const direction of ['TB', 'LR'] as const) {
    const placed = layoutChart(chart, direction);
    const where = `${name} (${direction})`;
    const boxes = placed.boxes;
    boxes.forEach((a, index) => {
      for (const b of boxes.slice(index + 1)) if (overlap(a, b)) into.overlapping.push(`${where}: ${a.id} × ${b.id}`);
    });
    for (const arrow of placed.arrows) {
      const edge = chart.edges[arrow.index];
      if (edge === undefined) continue;
      for (const box of boxes) {
        if (box.id === edge.from || box.id === edge.to) continue;
        if (arrow.points.some((point, index) => index > 0 && crosses(arrow.points[index - 1] as LayoutPoint, point, box))) into.crossing.push(`${where}: ${edge.from} → ${edge.to} × ${box.id}`);
      }
    }
    const labels = placed.arrows.flatMap((arrow) => (arrow.label === undefined ? [] : [{ text: arrow.label.text, area: { x: arrow.label.x - arrow.label.width / 2, y: arrow.label.y - arrow.label.height / 2, width: arrow.label.width, height: arrow.label.height } }]));
    labels.forEach((label, index) => {
      for (const box of boxes) if (overlap(label.area, box, 1)) into.covered.push(`${where}: 「${label.text}」 × ${box.id}`);
      for (const other of labels.slice(index + 1)) if (overlap(label.area, other.area, 1)) into.covered.push(`${where}: 「${label.text}」 × 「${other.text}」`);
    });
    const at = new Map(boxes.map((box) => [box.id, box]));
    for (const node of chart.nodes) {
      const exit = at.get(node.id);
      const box = at.get(node.of);
      if (node.row === undefined || !node.of.startsWith('n:') || exit === undefined || box === undefined) continue;
      const tb = direction === 'TB';
      const beside = tb ? exit.x >= box.x + box.width || exit.x + exit.width <= box.x : exit.y >= box.y + box.height || exit.y + exit.height <= box.y;
      const apart = tb ? Math.max(0, exit.y - (box.y + box.height), box.y - (exit.y + exit.height)) : Math.max(0, exit.x - (box.x + box.width), box.x - (exit.x + exit.width));
      if (!beside || apart > (tb ? exit.height : exit.width)) into.astray.push(`${where}: ${node.id}`);
    }
  }
}

/** Lay out the chart of an endpoint's root as the flow view opens it (no choice), and check it. */
function placeRoot(file: FrameFile, data: MapData, hasFrame: (id: string) => boolean, endpoint: FlowEndpoint, into: Placed): void {
  const state = { open: [], choices: [] };
  const diagram = frameDiagram(file.tree, '', undefined, {
    hasFrame,
    words: data,
    stepOpen: (node: TreeNode) => stepHolds('', node, state, []),
    stepCall: (node: TreeNode) => stepCall(node, undefined, hasFrame),
    foldsGuard: (node: TreeNode) => foldsGuard(node, undefined, hasFrame, () => false),
  });
  checkLayout(chartOf(diagram, file.tree, '', data, endpoint), `${endpoint.methods.join(' | ')} ${endpoint.path}`, into);
}

/** Play every choice of an endpoint's root frame (see the module comment). */
function play(root: string, file: FrameFile, data: MapData, treeOf: (id: string) => FlowTree | undefined, hasFrame: (id: string) => boolean, endpoint: FlowEndpoint | undefined, into: Played, placed: Placed): void {
  for (const selection of file.selections) {
    const open = selection.frames ?? [];
    // The trees of the frames the choice opens, read level by level: a frame is known once the tree of the frame that calls it is.
    const trees = new Map<string, FlowTree>([[root, file.tree]]);
    for (let before = -1; before !== trees.size; ) {
      before = trees.size;
      for (const id of frameIds(root, open, trees).values()) {
        const tree = trees.has(id) ? undefined : treeOf(id);
        if (tree !== undefined) trees.set(id, tree);
      }
    }
    const walked = walkTrace(file.tree, selection.decisions, { open, trees });
    const state = { open, choices: [selection.decisions] };
    const diagrams = new Map<string, Diagram>();
    const diagramOf = (frame: string, tree: FlowTree): Diagram => {
      const known = diagrams.get(frame);
      if (known !== undefined) return known;
      const made = frameDiagram(tree, frame, undefined, {
        hasFrame,
        words: data,
        stepOpen: (node: TreeNode) => stepHolds(frame, node, state, []),
        stepCall: (node: TreeNode) => stepCall(node, undefined, hasFrame),
        foldsGuard: (node: TreeNode) => foldsGuard(node, undefined, hasFrame, () => false),
      });
      diagrams.set(frame, made);
      return made;
    };
    const name = `${root} «${selection.name}»`;
    into.choices += 1;
    if (!walked.stops.some((stop) => stopKey(stop) === selection.target)) into.astray.push(name);
    const ran = new Map<string, Set<string>>();
    const scenes = scenesOf(walked, (stop) => {
      const tree = trees.get(stop.tree);
      return tree === undefined ? undefined : boxOf(diagramOf(stop.frame, tree), stop.node.id)?.id;
    });
    into.scenes += scenes.length;
    for (const scene of scenes) if (scene.shape === undefined) into.homeless.push(`${name}: ${scene.frame}|${scene.node.id}`);
    for (const stop of walked.stops) {
      const tree = trees.get(stop.tree);
      if (tree === undefined) continue;
      if (!ran.has(stop.frame)) ran.set(stop.frame, nodesRun(tree, stop.frame, [walked.resolved], undefined));
      if (ran.get(stop.frame)?.has(stop.node.id) !== true) into.grey.push(`${name}: ${stop.frame}|${stop.node.id}`);
    }
    // The chart of every frame the playback goes through: a node to play every scene on, a terminal for every exit, and the exit every ending scene reaches.
    for (const frame of new Set(scenes.map((scene) => scene.frame))) {
      const tree = trees.get(scenes.find((scene) => scene.frame === frame)?.tree ?? '');
      if (tree === undefined) continue;
      const diagram = diagramOf(frame, tree);
      const chart = chartOf(diagram, tree, frame, data, endpoint);
      const drawn = new Set([...chart.nodes.map((node) => node.id), ...chart.groups.map((group) => group.id)]);
      const terminal = new Set(chart.nodes.filter((node) => node.shape === 'end' || node.shape === 'failure').map((node) => node.id));
      const way = chartWay(chart, scenes, frame);
      checkLayout(chart, `${name} ${frame}`, placed);
      for (const missing of exitsMissing(diagram, chart)) if (!into.exitless.includes(missing)) into.exitless.push(missing);
      for (const scene of scenes.filter((item) => item.frame === frame)) {
        if (scene.shape === undefined || !drawn.has(scene.shape)) into.unplayable.push(`${name}: ${frame}|${scene.node.id}`);
        const ends = scene.stops.some((stop) => stop.event === 'returns' || stop.event === 'throws');
        if (ends && scene.shape !== undefined && !terminal.has(scene.shape) && !way.exits.has(scene.index)) into.unended.push(`${name}: ${frame}|${scene.shape}`);
      }
    }
  }
}

describe.skipIf(!existsSync(join(DATA, 'map.json')))('the playback of every ready-made choice of the endpoints of the built map', () => {
  const played: Played = { choices: 0, scenes: 0, astray: [], homeless: [], grey: [], unplayable: [], exitless: [], unended: [] };
  const placed: Placed = { seen: new Set(), overlapping: [], astray: [], crossing: [], covered: [] };

  beforeAll(() => {
    const data = JSON.parse(readFileSync(join(DATA, 'map.json'), 'utf8')) as MapData;
    const hasFrame = (id: string) => (entryOf(data, id)?.frame ?? '') !== '';
    const files = new Map<string, FrameFile>();
    const fileOf = (id: string): FrameFile | undefined => {
      const known = files.get(id);
      if (known !== undefined) return known;
      const url = entryOf(data, id)?.frame;
      if (url === undefined || url === '') return undefined;
      const file = JSON.parse(readFileSync(join(DATA, url.replace(/^\.\/data\//, '')), 'utf8')) as FrameFile;
      files.set(id, file);
      return file;
    };
    const endpoints = new Map<string, FlowEndpoint>();
    for (const flow of Object.values(data.flows)) for (const endpoint of flow.endpoints) if (endpoint.root !== '' && !endpoints.has(endpoint.root)) endpoints.set(endpoint.root, endpoint);
    const roots = [...endpoints.keys()];
    for (const root of roots) {
      const file = fileOf(root);
      if (file === undefined) continue;
      play(root, file, data, (id) => fileOf(id)?.tree, hasFrame, endpoints.get(root), played, placed);
      placeRoot(file, data, hasFrame, endpoints.get(root) as FlowEndpoint, placed);
    }
    console.log(
      `The playback of ${played.choices} ready-made choices of ${roots.length} endpoint roots: ${played.scenes} scenes; ${played.astray.length} astray, ${played.homeless.length} stops without a box, ${played.grey.length} stops the diagram leaves grey; ` +
        `the chart: ${played.unplayable.length} scenes without a node, ${played.exitless.length} exits without a terminal, ${played.unended.length} endings without one; ${placed.seen.size} charts laid out in both directions, ${placed.overlapping.length} overlaps, ${placed.astray.length} exits not beside their box, ${placed.crossing.length} arrows through a node, ${placed.covered.length} labels over a node or a label`,
    );
  }, 300_000);

  it('should reach the node every ready-made choice leads to', () => {
    expect(played.choices).toBeGreaterThan(0);
    expect(played.astray).toEqual([]);
  });

  it('should have a box or a region of the diagram of its frame for every stop', () => {
    expect(played.homeless).toEqual([]);
  });

  it('should color every stop when the diagram is given the sides the walk resolved', () => {
    expect(played.grey).toEqual([]);
  });

  it('should have a node of the chart of its frame to play every scene on', () => {
    expect(played.unplayable).toEqual([]);
  });

  it('should draw every way a box or a region ends its frame as a terminal node of the chart', () => {
    expect(played.exitless).toEqual([]);
  });

  it('should end every scene that returns or throws at a terminal node of the chart', () => {
    expect(played.unended).toEqual([]);
  });

  it('should lay out every chart in both directions with no node over another and every exit beside its box', () => {
    expect(placed.seen.size).toBeGreaterThan(0);
    expect(placed.overlapping).toEqual([]);
    expect(placed.astray).toEqual([]);
  });

  it('should lay out every chart in both directions with no arrow through a node but its two ends, and no label over a node or another label', () => {
    expect(placed.crossing).toEqual([]);
    expect(placed.covered).toEqual([]);
  });
});
