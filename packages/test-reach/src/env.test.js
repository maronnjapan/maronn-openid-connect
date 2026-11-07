import { describe, expect, it } from 'vitest';
import { reachEnabled } from './env.js';

describe('reachEnabled', () => {
  it('should measure only when MARONN_REACH is 1', () => {
    expect([reachEnabled({ MARONN_REACH: '1' }), reachEnabled({ MARONN_REACH: '0' }), reachEnabled({})]).toEqual([true, false, false]);
  });
});
