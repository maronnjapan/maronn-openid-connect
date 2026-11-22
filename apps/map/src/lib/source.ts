/**
 * What the code drawer shows: a whole file, or the lines of a function or an
 * endpoint body, with their original line numbers and the features that own
 * them. Nothing here touches the DOM.
 */
import type { FeatureRange } from '../types';

/** A whole file or the inclusive lines of a frame, selectable in the drawer. */
export interface SourceTarget {
  id: string;
  label: string;
  file: string;
  start?: number;
  end?: number;
}

/** Source lines with their original file numbers; a whole file leaves the range unspecified. */
export function sourceLines(code: string, start = 1, end?: number): Array<{ number: number; text: string }> {
  const lines = code.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(start - 1, end).map((text, index) => ({ number: start + index, text }));
}

/** Keep feature ranges at their original line numbers, naming each visible range at its first shown line. */
export function featureSourceLines(code: string, ranges: readonly FeatureRange[] = [], start = 1, end?: number): Array<{ number: number; text: string; features: string[]; starts: string[] }> {
  let previous = new Set<string>();
  return sourceLines(code, start, end).map((line) => {
    const features = [...new Set(ranges.filter((range) => range.lines[0] <= line.number && line.number <= range.lines[1]).map((range) => range.feature))];
    const starts = features.filter((feature) => !previous.has(feature));
    previous = new Set(features);
    return { ...line, features, starts };
  });
}
