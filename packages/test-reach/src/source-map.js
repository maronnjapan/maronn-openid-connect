/**
 * A small reader of source maps (version 3): it decodes the Base64 VLQ of
 * `mappings` and finds the original position of a generated one. Plain
 * JavaScript with no import, so it runs in the edge-runtime environment of
 * the Vitest workers as well as in Node.
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** @type {Int8Array} */
const DIGITS = new Int8Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) DIGITS[BASE64.charCodeAt(index)] = index;

/**
 * A segment of a decoded line: the generated column, then (when it maps)
 * the index of the source, the original line and the original column, all
 * from 0.
 * @typedef {number[]} Segment
 */

/**
 * Decode the `mappings` of a source map into its lines of segments, the
 * segments of a line in the order of their generated columns.
 * @param {string} mappings
 * @returns {Segment[][]}
 */
export function decodeMappings(mappings) {
  /** @type {Segment[][]} */
  const lines = [];
  /** @type {Segment[]} */
  let line = [];
  /** @type {number[]} */
  let segment = [];
  // The fields of a segment are relative: the column to the previous segment
  // of the line, the others to the previous segment of the map.
  let column = 0;
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let name = 0;
  let value = 0;
  let shift = 0;
  /** Add the segment read so far to the line, with its fields made absolute. */
  function endSegment() {
    if (segment.length === 0) return;
    column += segment[0] ?? 0;
    if (segment.length >= 4) {
      source += segment[1] ?? 0;
      originalLine += segment[2] ?? 0;
      originalColumn += segment[3] ?? 0;
      if (segment.length >= 5) {
        name += segment[4] ?? 0;
        line.push([column, source, originalLine, originalColumn, name]);
      } else {
        line.push([column, source, originalLine, originalColumn]);
      }
    } else {
      line.push([column]);
    }
    segment = [];
  }
  for (let index = 0; index < mappings.length; index += 1) {
    const code = mappings.charCodeAt(index);
    if (code === 59 /* ; */) {
      endSegment();
      lines.push(line.sort((a, b) => a[0] - b[0]));
      line = [];
      column = 0;
      continue;
    }
    if (code === 44 /* , */) {
      endSegment();
      continue;
    }
    const digit = code < 128 ? (DIGITS[code] ?? -1) : -1;
    if (digit < 0) throw new Error(`Invalid character in source map mappings at ${index}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    segment.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  endSegment();
  lines.push(line.sort((a, b) => a[0] - b[0]));
  return lines;
}

/**
 * The Base64 VLQ of one number.
 * @param {number} value
 * @returns {string}
 */
function encodeValue(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let encoded = '';
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    encoded += BASE64[digit];
  } while (rest > 0);
  return encoded;
}

/**
 * Encode lines of segments (absolute fields, as decodeMappings gives them)
 * back into the `mappings` of a source map.
 * @param {Segment[][]} lines
 * @returns {string}
 */
export function encodeMappings(lines) {
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let name = 0;
  return lines.map((segments) => {
    let column = 0;
    return [...segments].sort((a, b) => a[0] - b[0]).map((segment) => {
      let encoded = encodeValue(segment[0] - column);
      column = segment[0];
      if (segment.length >= 4) {
        encoded += encodeValue(segment[1] - source) + encodeValue(segment[2] - originalLine) + encodeValue(segment[3] - originalColumn);
        source = segment[1];
        originalLine = segment[2];
        originalColumn = segment[3];
        if (segment.length >= 5) {
          encoded += encodeValue(segment[4] - name);
          name = segment[4];
        }
      }
      return encoded;
    }).join(',');
  }).join(';');
}

/**
 * A source map as one map: the sections of an index map (Turbopack writes
 * them) laid into a single `mappings`, their sources and names appended.
 * A map without sections is returned as it is.
 * @param {{ sections?: Array<{ offset: { line: number, column: number }, map: any }>, [key: string]: any }} map
 * @returns {{ version: number, sources: Array<string | null>, sourcesContent?: Array<string | null>, names: string[], mappings: string, sourceRoot?: string, file?: string }}
 */
export function flattenSourceMap(map) {
  if (!Array.isArray(map.sections)) return /** @type {any} */ (map);
  /** @type {Array<string | null>} */
  const sources = [];
  /** @type {Array<string | null>} */
  const sourcesContent = [];
  /** @type {string[]} */
  const names = [];
  /** @type {Segment[][]} */
  const lines = [];
  for (const section of map.sections) {
    const inner = flattenSourceMap(section.map);
    const sourceBase = sources.length;
    const nameBase = names.length;
    const root = inner.sourceRoot && !inner.sourceRoot.endsWith('/') ? `${inner.sourceRoot}/` : (inner.sourceRoot ?? '');
    for (const [index, source] of inner.sources.entries()) {
      sources.push(source === null ? null : `${root}${source}`);
      sourcesContent.push(inner.sourcesContent?.[index] ?? null);
    }
    names.push(...(inner.names ?? []));
    for (const [index, segments] of decodeMappings(inner.mappings ?? '').entries()) {
      const line = section.offset.line + index;
      while (lines.length <= line) lines.push([]);
      const column = index === 0 ? section.offset.column : 0;
      for (const segment of segments) {
        /** @type {Segment} */
        const moved = segment.length === 1 ? [segment[0] + column]
          : segment.length === 4 ? [segment[0] + column, segment[1] + sourceBase, segment[2], segment[3]]
            : [segment[0] + column, segment[1] + sourceBase, segment[2], segment[3], segment[4] + nameBase];
        lines[line]?.push(moved);
      }
    }
  }
  return { version: 3, sources, sourcesContent, names, mappings: encodeMappings(lines) };
}

/**
 * A source map with its mappings decoded once.
 * @typedef {{ sources: Array<string | null>, sourceRoot?: string, names?: string[], lines: Segment[][] }} DecodedSourceMap
 */

/**
 * Decode a source map object (the JSON of a `.map` file, or the
 * `inputSourceMap` Istanbul keeps) for originalPositionFor.
 * @param {{ sources?: Array<string | null>, sourceRoot?: string, names?: string[], mappings?: string }} map
 * @returns {DecodedSourceMap}
 */
export function decodeSourceMap(map) {
  return {
    sources: map.sources ?? [],
    ...(map.sourceRoot ? { sourceRoot: map.sourceRoot } : {}),
    names: map.names ?? [],
    lines: decodeMappings(map.mappings ?? ''),
  };
}

/**
 * The original position of the first mapped segment inside a generated range
 * (lines from 1, columns from 0, the end excluded): where a function of a
 * bundle starts in its source, even when the bundler wrote no mapping at
 * its very first character, without falling back on a mapping before it
 * (a comment, or the end of another module). None when the range maps nothing.
 * @param {DecodedSourceMap} map
 * @param {{ line: number, column: number }} start
 * @param {{ line: number, column: number }} end
 * @returns {{ source: string, line: number, column: number } | undefined}
 */
export function firstOriginalPositionIn(map, start, end) {
  for (let line = start.line; line <= end.line && line <= map.lines.length; line += 1) {
    for (const segment of map.lines[line - 1] ?? []) {
      if (segment.length < 4) continue;
      if (line === start.line && segment[0] < start.column) continue;
      if (line === end.line && segment[0] >= end.column) break;
      const source = map.sources[segment[1]];
      if (source === undefined || source === null) continue;
      const root = map.sourceRoot && !map.sourceRoot.endsWith('/') ? `${map.sourceRoot}/` : (map.sourceRoot ?? '');
      return { source: `${root}${source}`, line: segment[2] + 1, column: segment[3] };
    }
  }
  return undefined;
}

/**
 * The original position of a generated one (line from 1, column from 0, as
 * Istanbul writes them): the last mapped segment of that line at or before
 * the column, else the first mapped segment after it on the same line. None
 * when the line maps nothing.
 * @param {DecodedSourceMap} map
 * @param {number} line From 1.
 * @param {number} column From 0.
 * @returns {{ source: string, line: number, column: number } | undefined} The source as the map names it, the line from 1 and the column from 0.
 */
export function originalPositionFor(map, line, column) {
  const segments = map.lines[line - 1];
  if (segments === undefined) return undefined;
  /** @type {Segment | undefined} */
  let found;
  for (const segment of segments) {
    if (segment.length < 4) continue;
    if (segment[0] <= column) found = segment;
    else {
      found ??= segment;
      break;
    }
  }
  if (found === undefined || found.length < 4) return undefined;
  const source = map.sources[found[1]];
  if (source === undefined || source === null) return undefined;
  const root = map.sourceRoot && !map.sourceRoot.endsWith('/') ? `${map.sourceRoot}/` : (map.sourceRoot ?? '');
  return { source: `${root}${source}`, line: found[2] + 1, column: found[3] };
}
