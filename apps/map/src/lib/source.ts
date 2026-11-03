import type { FlowEndpoint, FunctionCard, MapData } from '../types';

/** A whole file or a function's inclusive source range, selectable in the drawer. */
export interface SourceTarget {
  id: string;
  label: string;
  file: string;
  start?: number;
  end?: number;
}

/** A function's source, when this version of the map carries it. */
export function functionSource(card: FunctionCard): SourceTarget | undefined {
  return card.source === undefined ? undefined : { id: card.id, label: `${card.name}() · ${card.package}:${card.module}`, ...card.source };
}

/** Functions reachable from the given roots, once each even when calls form a cycle. */
function reachedSources(data: MapData, roots: string[]): SourceTarget[] {
  const seen = new Set<string>();
  const targets: SourceTarget[] = [];
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index] as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const card = data.functions[id];
    if (card === undefined) continue;
    const target = functionSource(card);
    if (target !== undefined) targets.push(target);
    queue.push(...card.calls, ...(card.flow?.nodes.flatMap((node) => node.callee === undefined ? [] : [node.callee]) ?? []));
  }
  return targets;
}

/** The endpoint file, its step functions and every function they call, including unmarked Route Handlers. */
export function endpointSources(data: MapData, endpoint: FlowEndpoint): SourceTarget[] {
  const targets: SourceTarget[] = endpoint.source === undefined ? [] : [{ id: endpoint.source, label: 'エンドポイント全体', file: endpoint.source }];
  const own = Object.values(data.functions).filter((card) => card.source?.file === endpoint.source && endpoint.source !== undefined);
  const roots = [...endpoint.steps.flatMap((step) => [...(step.functionId === undefined ? [] : [step.functionId]), ...step.calls]), ...own.map((card) => card.id)];
  return [...targets, ...reachedSources(data, roots)];
}

/** A function and all of its callees, so the reader can follow code without leaving the diagram. */
export function functionSources(data: MapData, card: FunctionCard): SourceTarget[] {
  return reachedSources(data, [card.id]);
}

/** Source lines with their original file numbers; a whole file leaves the range unspecified. */
export function sourceLines(code: string, start = 1, end?: number): Array<{ number: number; text: string }> {
  const lines = code.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(start - 1, end).map((text, index) => ({ number: start + index, text }));
}
