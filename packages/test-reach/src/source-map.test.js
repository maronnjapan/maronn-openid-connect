import { describe, expect, it } from 'vitest';
import { decodeMappings, decodeSourceMap, encodeMappings, firstOriginalPositionIn, flattenSourceMap, originalPositionFor } from './source-map.js';

// Two generated lines: `AAAA,EAAE` maps column 0 to 0:0 and column 2 to 0:2;
// `AACA,IAAI` maps line 2 to source line 1 (from 0), its original columns
// going on from the 2 of the line before.
const MAPPINGS = 'AAAA,EAAE;AACA,IAAI';

describe('decodeMappings', () => {
  it('should decode the segments of each line with absolute fields', () => {
    expect(decodeMappings(MAPPINGS)).toEqual([
      [[0, 0, 0, 0], [2, 0, 0, 2]],
      [[0, 0, 1, 2], [4, 0, 1, 6]],
    ]);
  });

  it('should decode a negative field and a name', () => {
    // `KAGDA`: column 5, source 0, line 3, original column -1, name 0.
    expect(decodeMappings('KAGDA')).toEqual([[[5, 0, 3, -1, 0]]]);
  });
});

describe('encodeMappings', () => {
  it('should encode what decodeMappings decodes back to the same mappings', () => {
    expect(encodeMappings(decodeMappings(MAPPINGS))).toBe(MAPPINGS);
    expect(decodeMappings(encodeMappings([[[0, 1, 120, 7, 3]], [], [[12, 0, 2, 0]]]))).toEqual([[[0, 1, 120, 7, 3]], [], [[12, 0, 2, 0]]]);
  });
});

describe('originalPositionFor', () => {
  const map = decodeSourceMap({ sources: ['a.ts'], mappings: MAPPINGS });

  it('should take the last segment at or before the column', () => {
    expect(originalPositionFor(map, 2, 9)).toEqual({ source: 'a.ts', line: 2, column: 6 });
  });

  it('should take the first segment after the column when none is before it', () => {
    const later = decodeSourceMap({ sources: ['a.ts'], mappings: 'IAAI' });
    expect(originalPositionFor(later, 1, 0)).toEqual({ source: 'a.ts', line: 1, column: 4 });
  });

  it('should find nothing on a line that maps nothing, and join the source root', () => {
    expect(originalPositionFor(map, 3, 0)).toBeUndefined();
    expect(originalPositionFor(decodeSourceMap({ sources: ['a.ts'], sourceRoot: '/src', mappings: 'AAAA' }), 1, 0)?.source).toBe('/src/a.ts');
  });
});

describe('firstOriginalPositionIn', () => {
  it('should take the first mapped segment inside the range, not one before it', () => {
    // Line 1 maps column 0 (to line 1) and column 10 (to line 5); line 2 column 0 to line 7.
    const map = decodeSourceMap({ sources: ['a.ts'], mappings: encodeMappings([[[0, 0, 0, 0], [10, 0, 4, 0]], [[0, 0, 6, 0]]]) });
    expect(firstOriginalPositionIn(map, { line: 1, column: 3 }, { line: 2, column: 5 })).toEqual({ source: 'a.ts', line: 5, column: 0 });
    expect(firstOriginalPositionIn(map, { line: 1, column: 11 }, { line: 2, column: 5 })).toEqual({ source: 'a.ts', line: 7, column: 0 });
    expect(firstOriginalPositionIn(map, { line: 1, column: 11 }, { line: 2, column: 0 })).toBeUndefined();
  });
});

describe('flattenSourceMap', () => {
  it('should lay the sections of an index map into one map', () => {
    const flat = flattenSourceMap({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], sourcesContent: ['a'], names: [], mappings: 'AAAA' } },
        { offset: { line: 2, column: 4 }, map: { version: 3, sources: ['b.ts'], names: ['x'], mappings: 'AAAAA;AACA' } },
      ],
    });
    expect(flat.sources).toEqual(['a.ts', 'b.ts']);
    expect(flat.sourcesContent).toEqual(['a', null]);
    expect(flat.names).toEqual(['x']);
    expect(decodeMappings(flat.mappings)).toEqual([[[0, 0, 0, 0]], [], [[4, 1, 0, 0, 0]], [[0, 1, 1, 0]]]);
  });

  it('should return a map without sections as it is', () => {
    const map = { version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA' };
    expect(flattenSourceMap(map)).toBe(map);
  });
});
