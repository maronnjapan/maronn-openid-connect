/**
 * Where the request the editor shows parts from the request it was written
 * from, as the request panel says it: the replay of an edited request is
 * read against the request before the edits (map-analysis traced.ts
 * followTrace `against`, Parting), and each frame where their ways part is
 * a line here: the function, the decision (or the call) the ways part at,
 * the side each request takes there, and the scene of the playback that
 * shows it. Nothing here touches the DOM.
 */
import type { Parting } from '@maronn-openid-connect/map-analysis/traced';
import { FAILS, SKIPS } from '@maronn-openid-connect/map-analysis/walk';
import type { FlowTree, MapData, TreeNode } from '../types';
import type { Scene } from './playback';
import { entryOf, findNode } from './trace';
import { nodeWords, sideLabel, splitPre } from './words';

/** One place where the edited request's way parts from the way of the request before the edits (see partingLines). */
export interface PartingLine {
  /** The key of the frame, and the node of it the ways part at. */
  frame: string;
  node: string;
  /** The frame in words: the function (`describeIntrospectedToken()`), or the endpoint for its root. */
  name: string;
  /** What the node says: the words of its condition or its call; its code where there are none (`code`). */
  text: string;
  code: boolean;
  /** The side the request takes there, and the side the request before the edits took, in words. */
  side: string;
  other: string;
  /** The scene of the playback that shows the node; undefined while the playback does not go there (its frame is not open yet, or the reader closed it). */
  scene?: number;
}

/** A side of a node in words: the label of a decision's side; for a call, whether it fails, is not evaluated, or neither. */
function sideOf(node: TreeNode, side: string | undefined, counterpart: string | undefined): string {
  if (side === FAILS) return '失敗する';
  if (side === SKIPS) return '評価しない';
  if (side === undefined) return counterpart === SKIPS ? '評価する' : counterpart === FAILS ? '失敗しない' : 'ここを通らない';
  const branch = node.branches?.find((candidate) => candidate.key === side);
  return branch === undefined ? side : sideLabel(node, branch);
}

/**
 * The partings of a replay as lines (PartingLine), in the order the walk
 * comes to them: `trees` are the trees loaded by frame id, `scenes` the
 * scenes of the playback. A parting whose tree or node is not there is left
 * out.
 */
export function partingLines(apart: readonly Parting[], scenes: readonly Scene[], trees: ReadonlyMap<string, FlowTree>, data: Pick<MapData, 'functions' | 'bodies' | 'members'>): PartingLine[] {
  const lines: PartingLine[] = [];
  for (const parting of apart) {
    const tree = trees.get(parting.tree);
    const node = tree === undefined ? undefined : findNode(tree.nodes, parting.at.node);
    if (node === undefined) continue;
    const entry = entryOf(data, parting.tree);
    const said = nodeWords(node, data, splitPre(node).call);
    const scene = scenes.findIndex((candidate) => candidate.frame === parting.frame && candidate.stops.some((stop) => stop.node.id === node.id));
    lines.push({
      frame: parting.frame,
      node: node.id,
      name: entry === undefined ? parting.tree : 'endpoint' in entry ? entry.name : `${entry.name}()`,
      text: said.text,
      code: said.code,
      side: sideOf(node, parting.at.side, parting.at.other),
      other: sideOf(node, parting.at.other, parting.at.side),
      ...(scene === -1 ? {} : { scene }),
    });
  }
  return lines;
}

/** What the request panel says above the partings: how many places the edited request's way parts at, or that it takes the way of the request before the edits. */
export function partingWords(count: number): string {
  return count === 0
    ? '書き換える前のリクエストと同じ道筋を通ります（地図が読む分岐の側は、どれも同じです。違うのは値だけです）。'
    : `書き換える前のリクエストとは、次の ${count} か所で道筋が分かれます（関数の名前を押すと、その場面へ移ります）。`;
}
