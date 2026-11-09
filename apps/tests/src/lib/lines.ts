/**
 * Which lines of a file the code view shows: the lines of one test with a
 * little context ("このテストだけ"), the range of a function, an endpoint or
 * a helper ("この範囲だけ"), or the whole file with the lines marked
 * ("ファイル全体").
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

/** Whether the code view shows a range of a file or the whole file. */
export type CodeMode = 'range' | 'file';

/** What the code view shows of a file: the lines, which of them it marks, and whether the range is past the end of the file. */
export interface CodeWindow extends LineRange {
  /** The marked lines, or undefined to mark none. */
  mark?: [number, number];
  /** The range starts past the last line (the file changed after the data was made): the whole file is shown unmarked. */
  outside: boolean;
}

/**
 * The window of the code view on a file of `total` lines for a range:
 *
 * - `range` shows the range with `context` lines around it, and marks it
 *   only when `markRange` (a test among its describe; a function shown alone
 *   needs no mark);
 * - `file` shows every line and marks the range.
 *
 * A range given in the wrong order is read the right way round, one past
 * the end of the file is cut to it, and one that starts past the end shows
 * the whole file.
 */
export function codeWindow(lines: readonly [number, number] | undefined, total: number, mode: CodeMode, options: { context?: number; markRange?: boolean } = {}): CodeWindow {
  const last = Math.max(total, 1);
  if (lines === undefined) return { start: 1, end: last, outside: false };
  const from = Math.min(lines[0], lines[1]);
  const to = Math.max(lines[0], lines[1]);
  if (from > last) return { start: 1, end: last, outside: true };
  const mark: [number, number] = [Math.max(from, 1), Math.min(to, last)];
  if (mode === 'file') return { start: 1, end: last, mark, outside: false };
  const range = lineWindow(mark, last, options.context ?? 0);
  return options.markRange === true ? { ...range, mark, outside: false } : { ...range, outside: false };
}
