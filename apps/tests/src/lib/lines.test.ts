import { describe, expect, it } from 'vitest';
import { inRange, lineWindow } from './lines';

describe('lineWindow', () => {
  it('should show the lines of a test with three lines around them', () => {
    expect(lineWindow([22, 29], 100)).toEqual({ start: 19, end: 32 });
  });

  it('should stop at the first and the last line of the file', () => {
    expect(lineWindow([2, 4], 5)).toEqual({ start: 1, end: 5 });
    expect(lineWindow([1, 1], 1, 10)).toEqual({ start: 1, end: 1 });
  });

  it('should show the whole file when the test has no lines', () => {
    expect(lineWindow(undefined, 40)).toEqual({ start: 1, end: 40 });
  });

  it('should read lines given in the wrong order and lines past the end', () => {
    expect(lineWindow([10, 8], 100, 0)).toEqual({ start: 8, end: 10 });
    expect(lineWindow([120, 130], 100)).toEqual({ start: 100, end: 100 });
  });
});

describe('inRange', () => {
  it('should tell the lines of a test', () => {
    expect(inRange(22, [22, 29])).toBe(true);
    expect(inRange(29, [22, 29])).toBe(true);
    expect(inRange(30, [22, 29])).toBe(false);
    expect(inRange(1, undefined)).toBe(false);
  });
});
