import { describe, expect, it } from 'vitest';
import { calledFunctions, followCall } from './calls';
import { buildDb } from './data';
import { fn, index, outline } from './fixture';

describe('browsing the functions some code calls', () => {
  const a = fn('core:a.ts#read');
  const b = fn('hono:b.ts#read');
  const db = buildDb(index([]), outline([], { [a.id]: a, [b.id]: b }));

  it('should preserve the order and distinct definitions, leaving out duplicate and unknown ids', () => {
    expect(calledFunctions(db, [b.id, a.id, b.id, 'missing'])).toEqual([b, a]);
  });

  it('should leave older data without call information usable', () => {
    expect(calledFunctions(db)).toEqual([]);
  });

  it('should follow more than one level and return along a cycle without growing the path', () => {
    const path = followCall(followCall([], a.id), b.id);
    expect(path).toEqual([a.id, b.id]);
    expect(followCall(path, a.id)).toEqual([a.id]);
    expect(followCall(path, b.id)).toEqual(path);
    expect(followCall(path, 'root', 'root')).toEqual([]);
  });
});
