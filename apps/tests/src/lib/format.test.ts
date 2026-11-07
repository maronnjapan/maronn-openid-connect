import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration, share, targetLabel } from './format';

describe('format', () => {
  it('should group the digits of a count', () => {
    expect(formatCount(5893)).toBe('5,893');
  });

  it('should write a duration in the unit that reads best', () => {
    expect(formatDuration(202.7)).toBe('203 ms');
    expect(formatDuration(1234)).toBe('1.2 s');
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(125_000)).toBe('2 分 5 秒');
    expect(formatDuration(Number.NaN)).toBe('');
  });

  it('should name the target of a Vitest result', () => {
    expect(targetLabel('')).toBe('Vitest');
    expect(targetLabel('nextjs')).toBe('Next.js');
  });

  it('should keep a part above zero visible and a part at zero empty', () => {
    expect(share(0, 10)).toBe(0);
    expect(share(1, 10_000)).toBe(0.5);
    expect(share(5, 10)).toBe(50);
    expect(share(1, 0)).toBe(0);
  });
});
