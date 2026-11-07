/**
 * Which lines of a file the code view shows: the lines of one test with a
 * little context ("このテストだけ"), or the whole file with the test's lines
 * marked ("ファイル全体").
 */

/** Inclusive line numbers, from 1. */
export interface LineRange {
  start: number;
  end: number;
}

/** The lines the code view shows of a file of `total` lines for a test on `lines`, with `context` lines around it. */
export function lineWindow(lines: readonly [number, number] | undefined, total: number, context = 3): LineRange {
  const last = Math.max(total, 1);
  if (lines === undefined) return { start: 1, end: last };
  const [from, to] = lines[0] <= lines[1] ? lines : [lines[1], lines[0]];
  const start = Math.min(Math.max(from - context, 1), last);
  const end = Math.max(Math.min(to + context, last), start);
  return { start, end };
}

/** Whether a line is one of a test's lines. */
export function inRange(line: number, lines: readonly [number, number] | undefined): boolean {
  return lines !== undefined && line >= Math.min(lines[0], lines[1]) && line <= Math.max(lines[0], lines[1]);
}
