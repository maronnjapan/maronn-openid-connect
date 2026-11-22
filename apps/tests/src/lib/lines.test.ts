import { describe, expect, it } from 'vitest';
import { codePageHref, codeWindow, inRange, lineWindow } from './lines';

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

describe('codeWindow', () => {
  it('should show a range of code alone, unmarked, or with context and marked for a test', () => {
    expect(codeWindow([12, 48], 200, 'range')).toEqual({ start: 12, end: 48, outside: false });
    expect(codeWindow([12, 48], 200, 'range', { context: 3, markRange: true })).toEqual({ start: 9, end: 51, mark: [12, 48], outside: false });
  });

  it('should show the whole file with the range marked', () => {
    expect(codeWindow([12, 48], 200, 'file')).toEqual({ start: 1, end: 200, mark: [12, 48], outside: false });
  });

  it('should read a range in the wrong order and cut one past the end of the file', () => {
    expect(codeWindow([48, 12], 200, 'range')).toEqual({ start: 12, end: 48, outside: false });
    expect(codeWindow([190, 230], 200, 'file')).toEqual({ start: 1, end: 200, mark: [190, 200], outside: false });
    expect(codeWindow([190, 230], 200, 'range')).toEqual({ start: 190, end: 200, outside: false });
  });

  it('should show the whole file unmarked when the range starts past its end (the file changed)', () => {
    expect(codeWindow([250, 260], 200, 'range')).toEqual({ start: 1, end: 200, outside: true });
    expect(codeWindow([250, 260], 200, 'file')).toEqual({ start: 1, end: 200, outside: true });
  });

  it('should show the whole file without a range', () => {
    expect(codeWindow(undefined, 40, 'range')).toEqual({ start: 1, end: 40, outside: false });
    expect(codeWindow(undefined, 0, 'file')).toEqual({ start: 1, end: 1, outside: false });
  });
});

describe('codePageHref', () => {
  it('should open a file of the provider on the code page of the map at its lines', () => {
    expect([codePageHref('packages/core/src/client-auth.ts', [190, 167]), codePageHref('apps/nextjs/src/app/(par)/par/route.ts', [3, 3]), codePageHref('apps/hono/src/oidc-provider/views.tsx')]).toEqual([
      '../code/#packages/core/src/client-auth.ts:L167-L190',
      '../code/#apps/nextjs/src/app/(par)/par/route.ts:L3',
      '../code/#apps/hono/src/oidc-provider/views.tsx',
    ]);
  });

  it('should give no link to a test, a helper of the tests or a fixture, which the map does not carry', () => {
    expect(['apps/hono/src/oidc-provider/endpoints/token/pipeline.test.ts', 'tests/steps/token.steps.ts', 'apps/hono/src/test-support/app.ts', 'packages/core/src/__fixtures__/keys.ts', 'tests/features/authorize.feature'].map((path) => codePageHref(path, [1, 2]))).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
