import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countWords, diffTrees, expressionChanges, placeHunks, tokens } from '../diff.js';
import { diffLines, hunksOf } from '../changes.js';
import { compile, type Fixture } from './helpers.js';

describe('expressionChanges', () => {
  it('should name an operator, a literal or a name that changed', () => {
    expect(expressionChanges('if (expiresAt < now)', 'if (expiresAt <= now)')).toEqual([{ text: '`<` を `<=` に変えた', before: '<', after: '<=' }]);
    expect(expressionChanges("const a = 'x'", "const a = 'y'")).toEqual([{ text: "`'x'` を `'y'` に変えた", before: "'x'", after: "'y'" }]);
  });

  it('should name an argument added or removed, and a callee replaced', () => {
    expect(expressionChanges('const t = issue(c, { a })', 'const t = issue(c, { a }, issuedAt)').map((change) => change.text)).toEqual(['引数 `issuedAt` を足した']);
    expect(expressionChanges('await persist(c, x, y)', 'await persist(c, y)').map((change) => change.text)).toEqual(['引数 `x` を消した']);
    expect(expressionChanges('return a(x)', 'return b(x)').map((change) => change.text)).toEqual(['`a()` を `b()` に置き換えた']);
  });

  it('should call a rewrite a rewrite, with the code before and after', () => {
    const [change] = expressionChanges('if (a && b && c(d))', 'if (!ready || isExpired(token, now) && retries > 3)');
    expect(change?.text).toBe('式を書き換えた');
    expect(change?.before).toBe('if (a && b && c(d))');
  });

  it('should read the tokens of code', () => {
    expect(tokens("a?.b ?? 'x y' <= 3")).toEqual(['a', '?.', 'b', '??', "'x y'", '<=', '3']);
  });
});

describe('diffTrees', () => {
  const BEFORE = `
export function verify(x: number, now: number) { return x > now; }
export function audit() {}
export function check(secret: string, expiresAt: number, now: number) {
  if (expiresAt < now) throw new Error('expired');
  audit();
  return verify(secret.length, now);
}
`;
  const AFTER = `
export function verify(x: number, now: number, margin = 0) { return x + margin > now; }
export function audit() {}
export function check(secret: string, expiresAt: number, now: number) {
  if (expiresAt <= now) throw new Error('expired');
  if (secret.length < 8) throw new Error('short');
  return verify(secret.length, now);
}
`;
  const MOVED = `
export function verify(x: number, now: number, margin = 0) { return x + margin > now; }
export function audit() {}
export function check(secret: string, expiresAt: number, now: number) {
  if (expiresAt <= now) throw new Error('expired');
  audit();
  return verify(secret.length, now, 1);
}
`;
  let before: Fixture;
  let after: Fixture;
  let moved: Fixture;
  beforeAll(() => {
    before = compile({ 'a.ts': BEFORE });
    after = compile({ 'a.ts': AFTER });
    moved = compile({ 'a.ts': MOVED });
  });
  afterAll(() => {
    before.dispose();
    after.dispose();
    moved.dispose();
  });

  it('should mark the nodes added and modified, place the removed ones, and say what changed', () => {
    const was = before.tree('check');
    const now = after.tree('check');
    const diff = diffTrees(was.tree, now.tree, { before: was.own, after: now.own }, { signature: false, docs: false });
    expect(diff.marks).toEqual({ s0: 'modified', s1: 'added' });
    expect(diff.exprs['s0']?.map((change) => change.text)).toEqual(['`<` を `<=` に変えた']);
    expect(diff.removed.map((removed) => [removed.node.code, removed.after])).toEqual([['audit()', 's0']]);
    expect(diff.summary).toEqual(['条件 `expiresAt <= now`: `<` を `<=` に変えた', '条件 `secret.length < 8` を足した（早期リターン）', '`audit()` の呼び出し を消した']);
    expect(countWords(diff.counts)).toBe('条件 変更1、条件 +1、呼び出し -1');
  });

  it('should name an argument added to a call, and put each hunk on the smallest node whose lines hold it', () => {
    const was = before.tree('check');
    const now = moved.tree('check');
    const diff = diffTrees(was.tree, now.tree, { before: was.own, after: now.own }, { signature: false, docs: false });
    expect(diff.marks).toEqual({ s0: 'modified', s2: 'modified', s2i0: 'modified' });
    expect(diff.exprs['s2i0']?.map((change) => change.text)).toEqual(['引数 `1` を足した']);
    const a = BEFORE.split('\n').slice(was.tree.lines[0] - 1, was.tree.lines[1]);
    const b = MOVED.split('\n').slice(now.tree.lines[0] - 1, now.tree.lines[1]);
    const { hunks } = hunksOf(diffLines(a, b), a, b, was.tree.lines[0], now.tree.lines[0], 0);
    const placed = placeHunks(now.tree, hunks, diff.marks);
    expect(Object.keys(placed).sort()).toEqual(['s0', 's2']);
    expect(placed['s0']?.[0]?.lines).toEqual(["-  if (expiresAt < now) throw new Error('expired');", "+  if (expiresAt <= now) throw new Error('expired');"]);
  });

  it('should put a hunk over two nodes on the node that holds both', () => {
    const was = before.tree('check');
    const now = after.tree('check');
    const a = BEFORE.split('\n').slice(was.tree.lines[0] - 1, was.tree.lines[1]);
    const b = AFTER.split('\n').slice(now.tree.lines[0] - 1, now.tree.lines[1]);
    const { hunks } = hunksOf(diffLines(a, b), a, b, was.tree.lines[0], now.tree.lines[0], 0);
    expect(Object.keys(placeHunks(now.tree, hunks, {}))).toEqual(['']);
  });
});
