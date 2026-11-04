/**
 * What the code drawer can show: a whole file, or the lines of a function or
 * an endpoint body, and the functions those call (down to core), so the
 * reader can follow the code without leaving the trace. Nothing here touches
 * the DOM.
 */
import type { FlowEndpoint, FunctionEntry, MapData } from '../types';
import { entryOf } from './trace';

/** A whole file or the inclusive lines of a frame, selectable in the drawer. */
export interface SourceTarget {
  id: string;
  label: string;
  file: string;
  start?: number;
  end?: number;
}

/** The lines of a frame, when this version of the map carries them. */
export function frameSource(data: MapData, id: string): SourceTarget | undefined {
  const entry = entryOf(data, id);
  if (entry?.source === undefined) return undefined;
  const label = 'endpoint' in entry ? `${entry.name}（エンドポイントの処理） · ${entry.package}:${entry.module}` : `${entry.name}() · ${entry.package}:${entry.module}`;
  return { id, label, ...entry.source };
}

/** A function's source, when this version of the map carries it. */
export function functionSource(card: FunctionEntry): SourceTarget | undefined {
  return card.source === undefined ? undefined : { id: card.id, label: `${card.name}() · ${card.package}:${card.module}`, ...card.source };
}

/** The frames reachable from some roots (themselves included), once each even when calls form a cycle. */
function reachedSources(data: MapData, roots: readonly string[]): SourceTarget[] {
  const seen = new Set<string>();
  const targets: SourceTarget[] = [];
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = entryOf(data, id);
    if (entry === undefined) continue;
    const target = frameSource(data, id);
    if (target !== undefined) targets.push(target);
    queue.push(...entry.calls);
  }
  return targets;
}

/** The file of an endpoint, the frame its trace starts from and every function that calls. */
export function endpointSources(data: MapData, endpoint: FlowEndpoint): SourceTarget[] {
  const targets: SourceTarget[] = endpoint.source === undefined ? [] : [{ id: endpoint.source, label: 'エンドポイントのファイル全体', file: endpoint.source }];
  return [...targets, ...reachedSources(data, [endpoint.root])];
}

/** A frame and all of its callees. */
export function frameSources(data: MapData, id: string): SourceTarget[] {
  return reachedSources(data, [id]);
}

/** Source lines with their original file numbers; a whole file leaves the range unspecified. */
export function sourceLines(code: string, start = 1, end?: number): Array<{ number: number; text: string }> {
  const lines = code.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(start - 1, end).map((text, index) => ({ number: start + index, text }));
}
