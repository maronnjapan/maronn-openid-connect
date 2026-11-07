/**
 * The helpers of a test as a tree: those the test calls itself (or, for a
 * scenario, its step definitions), each with the helpers it calls under it.
 * The card lists them depth first with their depth (model.ts HelperRef), so
 * a helper deeper than 1 is under the nearest helper before it one level up.
 */
import type { HelperRef } from '@maronn-openid-connect/test-catalog/model';

export interface HelperNode {
  helper: HelperRef;
  /** Its place in the card's list, a key that stays the same while the card does. */
  index: number;
  children: HelperNode[];
}

/** The helpers as a tree; a depth that skips a level (data the page cannot read) is taken as one level under the helper before. */
export function helperTree(helpers: readonly HelperRef[]): HelperNode[] {
  const roots: HelperNode[] = [];
  /** The last node at each depth, from 1. */
  const path: HelperNode[] = [];
  helpers.forEach((helper, index) => {
    const wanted = Number.isInteger(helper.depth) && (helper.depth as number) > 1 ? (helper.depth as number) : 1;
    const depth = Math.min(wanted, path.length + 1);
    const node: HelperNode = { helper, index, children: [] };
    if (depth === 1) roots.push(node);
    else path[depth - 2]?.children.push(node);
    path.length = depth - 1;
    path.push(node);
  });
  return roots;
}

/** How many helpers are under a node, at any depth. */
export function descendants(node: HelperNode): number {
  return node.children.reduce((sum, child) => sum + 1 + descendants(child), 0);
}

/** The helpers under a node in the order of the card, each with its depth below the node (1 for those it calls itself). */
export function flatten(node: HelperNode, depth = 1): Array<{ node: HelperNode; depth: number }> {
  return node.children.flatMap((child) => [{ node: child, depth }, ...flatten(child, depth + 1)]);
}
