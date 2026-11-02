/**
 * The owner blocks of a Route Handler (apps/nextjs), and the functions each
 * block calls.
 *
 * A Next.js endpoint writes its steps as blocks of one route.ts, each opened
 * by a marker line (`// [step-id] Label — Spec`, or
 * `// [step-id] (feature: <id>) Label — Spec` for a block of a feature), and
 * its endpoint.ts lists the same ids. A block is not a function of its own,
 * so the function catalog has no card for it; its calls are read from the
 * code between its marker and the next marker (or the end of the handler
 * the block is in), through the imports of the route.ts.
 *
 * `maronn-oidc explain` and the flow of the Next.js output show them as the
 * calls of the step. The published package carries them baked beside the
 * function catalog (templates/<source>/<root>.blocks.json).
 */
import type { FunctionProject } from './functions.js';

/** A marker line: `// [id] (feature: f) Label — Spec`. */
const MARKER = /^[ \t]*\/\/ \[([a-z0-9-]+)\](?: \(feature: ([a-z0-9-]+)\))? ([^\n]*)$/gm;

/** The functions a Route Handler's blocks call: module (relative to the root) → step id → function ids. */
export type RouteBlockCalls = Record<string, Record<string, string[]>>;

export interface RouteBlock {
  id: string;
  feature?: string;
  /** The offset of the marker line in the file. */
  index: number;
  /** The offset where the block's code starts (after the marker line). */
  start: number;
}

/** The marker lines of a source, in order. */
export function readRouteBlocks(source: string): RouteBlock[] {
  const blocks: RouteBlock[] = [];
  for (const match of source.matchAll(MARKER)) {
    const index = match.index as number;
    const block: RouteBlock = { id: match[1] as string, index, start: index + match[0].length };
    if (match[2] !== undefined) block.feature = match[2];
    blocks.push(block);
  }
  return blocks;
}

/**
 * The calls of every block of the files with markers under a root of a
 * source (the Route Handlers of the Next.js output). `files` are the files of
 * the source (path relative to the source directory → text); the result is
 * keyed by the path relative to `root`.
 */
export function readRouteBlockCalls(
  project: FunctionProject,
  sourceName: string,
  root: string,
  files: ReadonlyMap<string, string>,
): RouteBlockCalls {
  const result: RouteBlockCalls = {};
  const prefix = `${root}/`;
  for (const [path, source] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!path.startsWith(prefix) || !/\.tsx?$/.test(path)) continue;
    const blocks = readRouteBlocks(source);
    if (blocks.length === 0) continue;
    const calls: Record<string, string[]> = {};
    blocks.forEach((block, position) => {
      const body = project.enclosingBody(sourceName, path, block.index);
      const next = blocks[position + 1];
      // The block ends at the next marker of the same handler, or where the handler ends.
      let end = body === undefined ? source.length : body.end - 1;
      if (next !== undefined && next.index < end) end = next.index;
      const found = project.callsIn(sourceName, path, block.start, end);
      calls[block.id] = [...(calls[block.id] ?? []), ...found.filter((id) => !(calls[block.id] ?? []).includes(id))];
    });
    result[path.slice(prefix.length)] = calls;
  }
  return result;
}
