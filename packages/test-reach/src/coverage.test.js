import { describe, expect, it } from 'vitest';
import { functionName, functionStart, originalPosition, sourcePath } from './coverage.js';
import { encodeMappings } from './source-map.js';

/**
 * A file coverage of /repo/src/token.ts whose generated line 1 maps column 0
 * to the original 10:2 and column 4 to 10:6, and line 2 nothing.
 * @returns {import('./coverage.js').FileCoverage}
 */
function mappedCoverage() {
  return {
    path: '/repo/src/token.ts',
    fnMap: {},
    f: {},
    inputSourceMap: { sources: ['token.ts'], mappings: encodeMappings([[[0, 0, 9, 2], [4, 0, 9, 6]], []]) },
  };
}

describe('sourcePath', () => {
  it('should resolve a relative source against the directory of the generated file', () => {
    expect(sourcePath('../lib/a.ts', '/repo/src/token.ts')).toBe('/repo/lib/a.ts');
    expect(sourcePath('./b.ts', '/repo/src/token.ts')).toBe('/repo/src/b.ts');
  });

  it('should keep an absolute source and decode a file URL', () => {
    expect(sourcePath('/repo/src/a.ts', '/elsewhere/x.js')).toBe('/repo/src/a.ts');
    expect(sourcePath('file:///repo/src/a%20b.ts', '/elsewhere/x.js')).toBe('/repo/src/a b.ts');
  });
});

describe('originalPosition', () => {
  it('should map a position back through the input source map', () => {
    expect(originalPosition(mappedCoverage(), { line: 1, column: 5 })).toEqual({ file: '/repo/src/token.ts', line: 10, column: 6 });
  });

  it('should give no position for a line the map does not map', () => {
    expect(originalPosition(mappedCoverage(), { line: 2, column: 0 })).toBeUndefined();
  });

  it('should keep the position of a file without a map', () => {
    const coverage = { ...mappedCoverage(), inputSourceMap: undefined };
    expect(originalPosition(coverage, { line: 3, column: 7 })).toEqual({ file: '/repo/src/token.ts', line: 3, column: 7 });
  });
});

describe('functionStart', () => {
  it('should take the declaration of a function before its start', () => {
    const entry = { name: 'handle', decl: { start: { line: 1, column: 4 } }, loc: { start: { line: 1, column: 0 } } };
    expect(functionStart(mappedCoverage(), entry)).toEqual({ file: '/repo/src/token.ts', line: 10 });
  });

  it('should fall back on the start when the declaration does not map', () => {
    const entry = { decl: { start: { line: 2, column: 0 } }, loc: { start: { line: 1, column: 0 } } };
    expect(functionStart(mappedCoverage(), entry)).toEqual({ file: '/repo/src/token.ts', line: 10 });
  });
});

describe('functionName', () => {
  it('should keep a name and drop the ones Istanbul makes up', () => {
    expect(functionName({ name: 'handle' })).toBe('handle');
    expect(functionName({ name: '(anonymous_5)' })).toBeUndefined();
    expect(functionName({})).toBeUndefined();
  });
});
