// This test reads the built map from the disk: tsconfig.node.json checks it with Node's types, which the page's tsconfig leaves out.
/**
 * The playback of every ready-made choice of every endpoint of the built map
 * (public/data, which `pnpm run data` writes), every feature on, its frames
 * open as the choice opens them. It checks what the flow view relies on,
 * whatever code contributors write: the walk reaches the node each choice
 * leads to, every stop of it has a box (or a region) of its frame's diagram
 * to play on, and the diagram colors every stop when it is given the sides
 * the walk resolved. Without the built map (the unit tests of CI) it is
 * skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FlowTree, FrameFile, MapData, TreeNode } from '../types';
import { boxOf, frameDiagram, type Diagram } from './diagram';
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
}

/** Play every choice of an endpoint's root frame (see the module comment). */
function play(root: string, file: FrameFile, data: MapData, treeOf: (id: string) => FlowTree | undefined, hasFrame: (id: string) => boolean, into: Played): void {
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
  }
}

describe.skipIf(!existsSync(join(DATA, 'map.json')))('the playback of every ready-made choice of the endpoints of the built map', () => {
  const played: Played = { choices: 0, scenes: 0, astray: [], homeless: [], grey: [] };

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
    const roots = [...new Set(Object.values(data.flows).flatMap((flow) => flow.endpoints.map((endpoint) => endpoint.root)).filter((root) => root !== ''))];
    for (const root of roots) {
      const file = fileOf(root);
      if (file !== undefined) play(root, file, data, (id) => fileOf(id)?.tree, hasFrame, played);
    }
    console.log(`The playback of ${played.choices} ready-made choices of ${roots.length} endpoint roots: ${played.scenes} scenes; ${played.astray.length} astray, ${played.homeless.length} stops without a box, ${played.grey.length} stops the diagram leaves grey`);
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
});
