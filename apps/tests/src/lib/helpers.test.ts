import type { HelperRef } from '@maronn-openid-connect/test-catalog/model';
import { describe, expect, it } from 'vitest';
import { descendants, flatten, helperTree, type HelperNode } from './helpers';

const helper = (name: string, depth?: number): HelperRef => ({ name, file: `apps/hono/src/test-support/${name}.ts`, lines: [1, 2], ...(depth === undefined ? {} : { depth }) });

/** A tree as names: `name` or `name(children...)`. */
function shape(nodes: readonly HelperNode[]): string[] {
  return nodes.map((node) => (node.children.length === 0 ? node.helper.name : `${node.helper.name}(${shape(node.children).join(' ')})`));
}

describe('helperTree', () => {
  // A unit test of the token endpoint: providerContext and the helpers it calls, then those the test calls itself.
  const helpers = [
    helper('providerContext', 1),
    helper('rs256Key', 2),
    helper('generateRs256Key', 3),
    helper('contextOf', 2),
    helper('requestTo', 3),
    helper('staticKeyProvider', 2),
    helper('confidentialClient', 1),
    helper('paramsOf', 1),
    helper('basicAuthorization', 1),
  ];

  it('should put each helper under the nearest helper before it one level up', () => {
    const roots = helperTree(helpers);
    expect(shape(roots)).toEqual(['providerContext(rs256Key(generateRs256Key) contextOf(requestTo) staticKeyProvider)', 'confidentialClient', 'paramsOf', 'basicAuthorization']);
    expect(roots.map((node) => node.index)).toEqual([0, 6, 7, 8]);
  });

  it('should count and list the helpers under a helper in the order of the card, with their depth below it', () => {
    const [context] = helperTree(helpers);
    expect(context && descendants(context)).toBe(5);
    expect(context && flatten(context).map(({ node, depth }) => [node.helper.name, depth])).toEqual([
      ['rs256Key', 1],
      ['generateRs256Key', 2],
      ['contextOf', 1],
      ['requestTo', 2],
      ['staticKeyProvider', 1],
    ]);
  });

  it('should read a helper without a depth as one the test calls, and a depth that skips a level as one level under', () => {
    expect(shape(helperTree([helper('a'), helper('b')]))).toEqual(['a', 'b']);
    expect(shape(helperTree([helper('a', 1), helper('b', 3), helper('c', 2)]))).toEqual(['a(b c)']);
    expect(shape(helperTree([helper('orphan', 2)]))).toEqual(['orphan']);
    expect(helperTree([])).toEqual([]);
  });
});
