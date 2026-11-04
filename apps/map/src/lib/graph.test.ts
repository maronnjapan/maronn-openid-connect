import { describe, expect, it } from 'vitest';
import { compactArguments, layoutGraph, textColumns, truncateColumns, wrapColumns, type GraphEdge, type GraphGroup, type GraphNode, type LayoutBox, type LayoutGroup } from './graph';

const nodes = (...ids: string[]): GraphNode[] => ids.map((id) => ({ id }));

/** A token endpoint in small: two grants after a fork, a dispatch that answers itself, and an error step. */
const tokenNodes = nodes('parse', 'dispatch', 'grant', 'code', 'refresh', 'issue', 'respond', 'error');
const tokenEdges: GraphEdge[] = [
  { from: 'parse', to: 'dispatch', kind: 'flow' },
  { from: 'dispatch', to: 'grant', kind: 'flow' },
  { from: 'grant', to: 'code', kind: 'branch', label: 'authorization_code' },
  { from: 'code', to: 'issue', kind: 'flow' },
  { from: 'grant', to: 'refresh', kind: 'branch', label: 'refresh_token' },
  { from: 'refresh', to: 'issue', kind: 'flow' },
  { from: 'issue', to: 'respond', kind: 'flow' },
  { from: 'dispatch', to: 'respond', kind: 'branch', label: 'answered' },
  { from: 'parse', to: 'error', kind: 'error' },
  { from: 'code', to: 'error', kind: 'error' },
  { from: 'refresh', to: 'error', kind: 'error' },
];

describe('layoutGraph', () => {
  const forkNodes = nodes('start', 'left', 'right', 'join');
  const forkEdges: GraphEdge[] = [
    { from: 'start', to: 'left', kind: 'branch', label: 'yes' },
    { from: 'start', to: 'right', kind: 'branch', label: 'no' },
    { from: 'left', to: 'join', kind: 'flow' },
    { from: 'right', to: 'join', kind: 'flow' },
  ];

  it('should place sibling branches side by side before their shared continuation', () => {
    const layout = layoutGraph(forkNodes, forkEdges, new Set([0, 1, 2, 3]));
    const [start, left, right, join] = layout.boxes;
    expect(left!.y).toBe(right!.y);
    expect(left!.x + left!.width <= right!.x || right!.x + right!.width <= left!.x).toBe(true);
    expect(start!.y + start!.height < left!.y).toBe(true);
    expect(left!.y + left!.height < join!.y).toBe(true);
    expect(layout.arrows.map((arrow) => arrow.label?.text)).toEqual(['yes', 'no', undefined, undefined]);
  });

  it('should keep positions and dimensions stable when the choice changes and draw only the requested arrows', () => {
    const first = layoutGraph(tokenNodes, tokenEdges, new Set([0, 7]));
    const all = layoutGraph(tokenNodes, tokenEdges, new Set(tokenEdges.map((_, index) => index)));
    expect(first.boxes).toEqual(all.boxes);
    expect([first.width, first.height]).toEqual([all.width, all.height]);
    expect(first.arrows.map((arrow) => arrow.index)).toEqual([0, 7]);
  });

  it('should keep a sequence aligned when every step can reach the same error response', () => {
    const sequence = Array.from({ length: 10 }, (_, index) => `n${index}`);
    const edges: GraphEdge[] = sequence.slice(0, -1).flatMap((id, index) => [
      { from: id, to: sequence[index + 1]!, kind: 'flow' },
      { from: id, to: 'error', kind: 'error' },
    ]);
    const layout = layoutGraph(nodes(...sequence, 'error'), edges, new Set());
    expect(new Set(layout.boxes.slice(0, -1).map((box) => box.x)).size).toBe(1);
  });

  it('should order horizontal flows from left to right with branches above one another', () => {
    const layout = layoutGraph(forkNodes, forkEdges, new Set([0, 1, 2, 3]), 'LR');
    const [start, left, right, join] = layout.boxes;
    expect(left!.x).toBe(right!.x);
    expect(left!.y + left!.height <= right!.y || right!.y + right!.height <= left!.y).toBe(true);
    expect(start!.x + start!.width < left!.x).toBe(true);
    expect(left!.x + left!.width < join!.x).toBe(true);
  });

  it.each(['TB', 'LR'] as const)('should route skips, errors, cycles and parallel edges without crossing unrelated boxes in %s', (direction) => {
    const edges: GraphEdge[] = [
      ...forkEdges,
      { from: 'start', to: 'join', kind: 'branch', label: 'skip' },
      { from: 'left', to: 'error', kind: 'error' },
      { from: 'right', to: 'error', kind: 'error' },
      { from: 'join', to: 'start', kind: 'branch', label: 'retry' },
      { from: 'right', to: 'right', kind: 'branch', label: 'again' },
      { from: 'start', to: 'left', kind: 'branch', label: 'another condition' },
    ];
    const layout = layoutGraph(nodes('start', 'left', 'right', 'join', 'error', 'isolated'), edges, new Set(edges.map((_, index) => index)), direction);
    expect(layout.arrows.map((arrow) => arrow.index)).toEqual(edges.map((_, index) => index));
    expect(new Set(layout.arrows.map((arrow) => arrow.d)).size).toBe(edges.length);
    const invalidPoints = layout.arrows.flatMap((arrow) => arrow.points).filter((point) =>
      !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > layout.width || point.y > layout.height,
    );
    expect(invalidPoints).toEqual([]);
    const collisions = layout.arrows.flatMap((arrow) => {
      const edge = edges[arrow.index]!;
      return layout.boxes.filter((box) => box.id !== edge.from && box.id !== edge.to).flatMap((box) =>
        arrow.points.slice(1).filter((point, index) => {
          const previous = arrow.points[index]!;
          // Sample each segment, including its interior, to catch a skip routed through a box.
          return Array.from({ length: 21 }, (_, sample) => sample / 20).some((t) => {
            const x = previous.x + (point.x - previous.x) * t;
            const y = previous.y + (point.y - previous.y) * t;
            return x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height;
          });
        }),
      );
    });
    expect(collisions).toEqual([]);
    expect(layout.arrows.filter((arrow) => arrow.kind === 'error').map((arrow) => arrow.index)).toEqual([5, 6]);
  });

  it('should ignore unknown endpoints and unknown edge indexes without introducing extra boxes', () => {
    const layout = layoutGraph(nodes('only'), [{ from: 'only', to: 'missing', kind: 'flow' }], new Set([0, 99]));
    expect(layout.boxes.map((box) => box.id)).toEqual(['only']);
    expect(layout.arrows).toEqual([]);
    expect(layoutGraph([], [], new Set()).boxes).toEqual([]);
  });

  it('should lay out a straight column with 320px boxes of their own heights, 20px apart inside 12px margins', () => {
    const heights: Record<string, number> = { a: 36, b: 80, c: 48, d: 50 };
    const chain: GraphEdge[] = [
      { from: 'a', to: 'b', kind: 'flow' },
      { from: 'b', to: 'c', kind: 'flow' },
      { from: 'c', to: 'd', kind: 'flow' },
    ];
    const layout = layoutGraph(nodes('a', 'b', 'c', 'd'), chain, new Set([0, 1, 2]), 'TB', { height: (id) => heights[id] as number });
    expect(layout.boxWidth).toBe(320);
    expect(layout.boxes.map((box) => [box.x, box.width, box.height])).toEqual([[12, 320, 36], [12, 320, 80], [12, 320, 48], [12, 320, 50]]);
    expect(layout.boxes.map((box) => box.y)).toEqual([12, 68, 168, 236]);
    expect([layout.width, layout.height]).toEqual([344, 298]);
  });

  it('should narrow every box to 200px when the sides of a fork share a rank', () => {
    const layout = layoutGraph(forkNodes, forkEdges, new Set([0, 1, 2, 3]));
    expect(layout.boxWidth).toBe(200);
    expect(layout.boxes.map((box) => [box.width, box.height])).toEqual([[200, 48], [200, 48], [200, 48], [200, 48]]);
    expect(layout.width).toBe(440);
  });

  it('should keep 320px boxes for the same fork from left to right', () => {
    const layout = layoutGraph(forkNodes, forkEdges, new Set([0, 1, 2, 3]), 'LR');
    expect(layout.boxWidth).toBe(320);
    expect(layout.boxes.map((box) => box.width)).toEqual([320, 320, 320, 320]);
  });

  it('should ask options.height for the final width and give each box that height', () => {
    const asked: Array<[string, number]> = [];
    const height = (id: string, width: number): number => {
      asked.push([id, width]);
      return 30 + id.length * 4 + width / 20;
    };
    const layout = layoutGraph(forkNodes, forkEdges, new Set(), 'TB', { height });
    expect(layout.boxWidth).toBe(200);
    expect(layout.boxes.map((box) => [box.id, box.height])).toEqual([['start', 60], ['left', 56], ['right', 60], ['join', 56]]);
    expect(Object.fromEntries(asked)).toEqual({ start: 200, left: 200, right: 200, join: 200 });
  });

  it('should keep boxes, width and height identical for every subset of shown arrows when the boxes have their own heights', () => {
    const guardNodes = nodes('start', 'check', 'yes', 'no', 'join', 'error');
    const guardEdges: GraphEdge[] = [
      { from: 'start', to: 'check', kind: 'flow' },
      { from: 'check', to: 'yes', kind: 'branch', label: 'ある' },
      { from: 'check', to: 'no', kind: 'branch', label: 'ない' },
      { from: 'yes', to: 'join', kind: 'flow' },
      { from: 'no', to: 'join', kind: 'flow' },
      { from: 'check', to: 'error', kind: 'error' },
    ];
    const heights: Record<string, number> = { start: 36, check: 80, yes: 48, no: 64, join: 48, error: 36 };
    // A title wraps onto more lines in a narrower box.
    const height = (id: string, width: number): number => (heights[id] as number) + 3200 / width;
    const subsets = guardEdges.reduce<number[][]>((sets, _, index) => [...sets, ...sets.map((set) => [...set, index])], [[]]);
    const layouts = subsets.map((shown) => layoutGraph(guardNodes, guardEdges, new Set(shown), 'TB', { height }));
    const placements = layouts.map(({ boxes, width, height: tall, boxWidth }) => ({ boxes, width, height: tall, boxWidth }));
    expect(subsets).toHaveLength(64);
    expect(placements).toEqual(placements.map(() => placements[0]));
    expect(placements[0]!.boxWidth).toBe(200);
    expect(placements[0]!.boxes.map((box) => box.height)).toEqual([52, 96, 64, 80, 64, 52]);
    expect(layouts.map((layout) => layout.arrows.map((arrow) => arrow.index))).toEqual(subsets);
  });
});

/**
 * A try in small: a region around three boxes with a region around the middle one, its error arrow to a
 * handler, and beside it the other side of a fork before it.
 */
const regionNodes = nodes('start', 'a', 'b', 'c', 'other', 'handler', 'end');
const regionEdges: GraphEdge[] = [
  { from: 'start', to: 'a', kind: 'branch', label: '成立' },
  { from: 'a', to: 'b', kind: 'flow' },
  { from: 'b', to: 'c', kind: 'flow' },
  { from: 'c', to: 'end', kind: 'flow' },
  { from: 'start', to: 'other', kind: 'branch', label: '不成立' },
  { from: 'other', to: 'end', kind: 'flow' },
  { from: 'outer', to: 'handler', kind: 'error', label: '例外が起きたとき' },
  { from: 'handler', to: 'end', kind: 'flow' },
];
const regionGroups: GraphGroup[] = [
  { id: 'outer', members: ['a', 'b', 'c'] },
  { id: 'inner', parent: 'outer', members: ['b'] },
];
const headers: Record<string, number> = { outer: 30, inner: 30 };

/** Whether two rectangles overlap (touching edges do not). */
const overlaps = (a: LayoutBox | LayoutGroup, b: LayoutBox | LayoutGroup) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Whether a rectangle lies inside another with at least a margin around it. */
const encloses = (outer: LayoutBox | LayoutGroup, inner: LayoutBox | LayoutGroup, margin: number) =>
  inner.x - outer.x >= margin && inner.y - outer.y >= margin && outer.x + outer.width - (inner.x + inner.width) >= margin && outer.y + outer.height - (inner.y + inner.height) >= margin;

describe('layoutGraph with regions', () => {
  const layoutOf = (direction: 'TB' | 'LR', shown: ReadonlySet<number> = new Set(regionEdges.map((_, index) => index))) =>
    layoutGraph(regionNodes, regionEdges, shown, direction, { height: () => 34, groups: regionGroups, header: (id) => headers[id] as number });

  it.each(['TB', 'LR'] as const)('should enclose the boxes of each region and the region inside it, keep every other box outside, and make the room of its label at the top in %s', (direction) => {
    const layout = layoutOf(direction);
    const box = (id: string) => layout.boxes.find((candidate) => candidate.id === id) as LayoutBox;
    const [outer, inner] = layout.groups as [LayoutGroup, LayoutGroup];
    expect(layout.groups.map((group) => group.id)).toEqual(['outer', 'inner']);
    expect(['a', 'b', 'c'].map((id) => encloses(outer, box(id), 8))).toEqual([true, true, true]);
    expect(encloses(outer, inner, 8)).toBe(true);
    expect(encloses(inner, box('b'), 8)).toBe(true);
    expect(['start', 'other', 'handler', 'end'].filter((id) => overlaps(outer, box(id)))).toEqual([]);
    expect(['a', 'c'].filter((id) => overlaps(inner, box(id)))).toEqual([]);
    expect(Math.min(box('a').y, inner.y) - outer.y).toBeGreaterThanOrEqual(30);
    expect(box('b').y - inner.y).toBeGreaterThanOrEqual(30);
    expect([...layout.boxes, ...layout.groups].every((rect) => rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= layout.width && rect.y + rect.height <= layout.height)).toBe(true);
  });

  it.each(['TB', 'LR'] as const)('should draw an arrow from a region from its border, laid out from its last box, in %s', (direction) => {
    const layout = layoutOf(direction);
    const outer = layout.groups[0] as LayoutGroup;
    const error = layout.arrows.find((arrow) => arrow.index === 6)!;
    const first = error.points[0]!;
    const label = error.label!;
    const distances = [first.x - outer.x, outer.x + outer.width - first.x, first.y - outer.y, outer.y + outer.height - first.y];
    expect(Math.min(...distances.map(Math.abs))).toBeLessThan(0.5);
    expect(Math.min(...distances)).toBeGreaterThan(-0.5);
    expect(label.text).toBe('例外が起きたとき');
    expect(overlaps(outer, { id: 'label', x: label.x - label.width / 2, y: label.y - label.height / 2, width: label.width, height: label.height })).toBe(false);
  });

  it.each(['TB', 'LR'] as const)('should keep boxes, regions, width and height identical whichever arrows are shown in %s', (direction) => {
    const subsets = [[], regionEdges.map((_, index) => index), ...regionEdges.map((_, index) => [index])];
    const placements = subsets.map((shown) => {
      const { boxes, groups, width, height, boxWidth } = layoutOf(direction, new Set(shown));
      return { boxes, groups, width, height, boxWidth };
    });
    expect(placements).toEqual(placements.map(() => placements[0]));
    expect(subsets.map((shown) => layoutOf(direction, new Set(shown)).arrows.map((arrow) => arrow.index))).toEqual(subsets);
  });

  it('should keep 200px boxes when the sides of a fork share a rank, and leave a graph without regions as it was', () => {
    expect(layoutOf('TB').boxWidth).toBe(200);
    const plain = layoutGraph(regionNodes, regionEdges.slice(0, 6), new Set([0, 1, 2]), 'TB', { height: () => 34 });
    const grouped = layoutGraph(regionNodes, regionEdges.slice(0, 6), new Set([0, 1, 2]), 'TB', { height: () => 34, groups: [] });
    expect(grouped).toEqual(plain);
    expect(plain.groups).toEqual([]);
  });

  it('should leave out a region that encloses no box and lay out an arrow to it nowhere', () => {
    const layout = layoutGraph(nodes('a', 'b'), [{ from: 'a', to: 'b', kind: 'flow' }, { from: 'empty', to: 'b', kind: 'error' }], new Set([0, 1]), 'TB', { groups: [{ id: 'empty', members: ['missing'] }] });
    expect(layout.groups).toEqual([]);
    expect(layout.arrows.map((arrow) => arrow.index)).toEqual([0]);
  });
});

describe('truncateColumns', () => {
  it('should count a wide character as two columns', () => {
    expect(textColumns('ab認可')).toBe(6);
    expect(truncateColumns('認可コードを発行する', 9)).toBe('認可コー…');
    expect(truncateColumns('short', 9)).toBe('short');
  });
});

describe('wrapColumns', () => {
  it('should count a wide character as two columns', () => {
    expect(wrapColumns('認可コードを発行', 8, 2)).toEqual(['認可コー', 'ドを発行']);
  });

  it('should break after 、 in the last 40% of a line', () => {
    expect(wrapColumns('トークンを検証し、署名を確かめる', 20, 2)).toEqual(['トークンを検証し、', '署名を確かめる']);
  });

  it('should break at a space in the last 40% of a line and drop it', () => {
    expect(wrapColumns('const client = await findClient(id)', 24, 2)).toEqual(['const client = await', 'findClient(id)']);
  });

  it('should break before an upper-case letter that follows a lower-case one', () => {
    expect(wrapColumns('verifyIdJagAssertion()', 14, 2)).toEqual(['verifyIdJag', 'Assertion()']);
  });

  it('should prefer a space to a later camelCase boundary when both keep the whole text', () => {
    expect(wrapColumns('return signJwt(header, payload, privateKey)', 40, 2)).toEqual(['return signJwt(header, payload,', 'privateKey)']);
  });

  it('should keep a text on one line when only its closing punctuation runs past the end', () => {
    expect(wrapColumns('buildAccessTokenAudience()', 25, 2)).toEqual(['buildAccessTokenAudience()']);
    expect(wrapColumns('return { name, namedCurve }', 25, 2)).toEqual(['return { name, namedCurve }']);
    expect(wrapColumns('デバイス認可レスポンスで応答する（no-store）', 42, 2)).toEqual(['デバイス認可レスポンスで応答する（no-store）']);
    expect(wrapColumns('return signJwt(header, payload, privateKey)', 42, 2)).toEqual(['return signJwt(header, payload, privateKey)']);
  });

  it('should keep closing punctuation at the end of a line rather than start the next line with it', () => {
    expect(wrapColumns('▾ サブジェクト、auth_time、nonce を取り出す', 25, 2)).toEqual(['▾ サブジェクト、auth_time、', 'nonce を取り出す']);
    expect(wrapColumns('return createFormPostResponseMode({ issuer })', 42, 2)).toEqual(['return createFormPostResponseMode({', 'issuer })']);
    expect(wrapColumns('return info ? { tokenType, accessToken } : null', 25, 2)).toEqual(['return info ? { tokenType,', 'accessToken } : null']);
    expect(wrapColumns('「認可」を確かめる', 4, 3)).toEqual(['「認', '可」', 'を…']);
  });

  it('should end a line a character early when the closing punctuation after it takes more than two columns', () => {
    expect(wrapColumns('abcdefghij)))', 10, 2)).toEqual(['abcdefghi', 'j)))']);
  });

  it('should break at the limit when a line has no good break', () => {
    expect(wrapColumns('abcdefghijklmnopqrstuvwxyz', 10, 3)).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxyz']);
  });

  it('should end a line at an earlier good break when the whole text still fits', () => {
    expect(wrapColumns('return AUTHORIZATION_CODE_TTL', 24, 2)).toEqual(['return', 'AUTHORIZATION_CODE_TTL']);
    expect(wrapColumns('認可、コードを発行する', 16, 2)).toEqual(['認可、', 'コードを発行する']);
  });

  it('should break at the limit when only that shows the whole text', () => {
    expect(wrapColumns('c.req.header(name)', 10, 2)).toEqual(['c.req.head', 'er(name)']);
  });

  it('should fill the lines of a text too long for them, taking a good break only in the last 40% of a line', () => {
    expect(wrapColumns('return AUTHORIZATION_CODE_TTL_IN_SECONDS_FOR_REFRESH', 24, 2)).toEqual(['return AUTHORIZATION_COD', 'E_TTL_IN_SECONDS_FOR_RE…']);
  });

  it('should end only a last line that cuts the text with an ellipsis', () => {
    expect(wrapColumns('トークンを検証し、署名と有効期限と発行者を確かめる', 20, 2)).toEqual(['トークンを検証し、', '署名と有効期限と発…']);
    expect(wrapColumns('aaaa bbbb cccc', 10, 2)).toEqual(['aaaa bbbb', 'cccc']);
    expect(wrapColumns('認可コードを発行する', 9, 1)).toEqual([truncateColumns('認可コードを発行する', 9)]);
  });

  it('should keep a short text on one line', () => {
    expect(wrapColumns('issueToken()', 42, 2)).toEqual(['issueToken()']);
    expect(wrapColumns('', 42, 2)).toEqual(['']);
  });
});

describe('compactArguments', () => {
  it('should replace the arguments of a call with (…)', () => {
    expect(compactArguments("return oauthError('invalid_request', `…`)")).toBe('return oauthError(…)');
    expect(compactArguments("例外 → throw new OAuthError('invalid_client', 'unknown client')")).toBe('例外 → throw new OAuthError(…)');
  });

  it('should replace nested parentheses with the arguments around them', () => {
    expect(compactArguments('return c.json(toBody(error, { status: (code ?? 400) }), 400)')).toBe('return c.json(…)');
  });

  it('should not end the arguments at a parenthesis inside a string or a template literal', () => {
    expect(compactArguments("throw new OAuthError(`client ${clientId(request)} (unknown)`, ')')")).toBe('throw new OAuthError(…)');
    expect(compactArguments("throw new OAuthError(`unknown: ${names.map((name, index) => `${index + 1}) ${name}`).join(', ')}`)")).toBe('throw new OAuthError(…)');
  });

  it('should compact each call of a chain and an optional call', () => {
    expect(compactArguments("c.req.header('Authorization')?.split(' ')")).toBe('c.req.header(…)?.split(…)');
    expect(compactArguments('handlers[name](request) ?? callback?.(value)')).toBe('handlers[name](…) ?? callback?.(…)');
  });

  it('should compact an argument list the text cuts off', () => {
    expect(compactArguments('return buildRefreshTokenRequest(refreshTokenInfo, authenticatedClientI…')).toBe('return buildRefreshTokenRequest(…)');
  });

  it('should leave text without a call unchanged', () => {
    expect(compactArguments('if (!client && (grant || scope))')).toBe('if (!client && (grant || scope))');
    expect(compactArguments("if(typeof(value) !== 'string')")).toBe("if(typeof(value) !== 'string')");
    expect(compactArguments("return '(none)'")).toBe("return '(none)'");
    expect(compactArguments('→ 2 通りで終わる')).toBe('→ 2 通りで終わる');
    expect(compactArguments('await next()')).toBe('await next()');
  });
});
