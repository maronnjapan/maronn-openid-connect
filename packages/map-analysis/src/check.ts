/**
 * The checks of the map's own output (not of the code it reads): what the
 * build of the map measures and fails on.
 *
 * - The ready-made choices of every frame are named, and the names of one
 *   frame are distinct without the number the selections add as a last
 *   resort (`… (2)`): no choice falls back to a nameless or numbered "exit
 *   case".
 * - Every line of the body of every frame is inside a node of its tree (the
 *   lines of the nodes cover the body), and every line a pull request
 *   changes in a frame is inside one.
 * - /token with every feature on offers named choices for refresh_token and
 *   authorization_code (the example the map has always given).
 * - In the map of a pull request, every change that needs a note has one.
 * - Wiring outside ordinary call paths retains its source and a reason when
 *   unresolved; claiming a destination requires a target and destinations.
 * - Every unresolved call node explains why it cannot be followed.
 */
import type { FlowTree, FrameFile, MapData, TreeNode } from './model.js';

export interface MapMetrics {
  frames: number;
  selections: number;
  /** Choices named by nothing but a number or empty, and names repeated in a frame (or told apart by a number only). */
  unnamed: number;
  duplicateNames: Array<{ frame: string; name: string }>;
  /** Lines of the bodies outside every node, by frame. */
  uncovered: Array<{ frame: string; lines: number[] }>;
  /** Changed lines of the frames outside every node. */
  changedOutside: Array<{ frame: string; lines: number[] }>;
  /** The names of the steps and the exits of /token of each source (its failures left out). */
  token: Record<string, string[]>;
  /** The changes that need a note and have none. */
  undocumented: string[];
  /** Wiring inventory entries, their unresolved count, and malformed output entries. */
  wiring: { entries: number; untraceable: number; invalid: number };
}

export interface CheckResult {
  metrics: MapMetrics;
  /** What fails, one line each; empty when the map is sound. */
  failures: string[];
}

/** The lines of the body of a tree that no node holds (blank lines left out). */
export function uncoveredLines(tree: FlowTree, text: string | undefined): number[] {
  if (tree.synthetic === true) return [];
  const lines = text?.split('\n');
  const covered = new Set<number>();
  for (const node of tree.nodes) for (let line = node.lines[0]; line <= node.lines[1]; line += 1) covered.add(line);
  const missing: number[] = [];
  // The lines between the brace that opens the body and the one that closes it.
  const last = tree.nodes.reduce((max, node) => Math.max(max, node.lines[1]), tree.head[1]);
  for (let line = tree.head[1] + 1; line <= last; line += 1) {
    if (covered.has(line)) continue;
    if (lines !== undefined && (lines[line - 1] ?? '').trim() === '') continue;
    missing.push(line);
  }
  return missing;
}

/**
 * Whether a line is inside a node of a tree, in its head (JSDoc and
 * declaration), or on the last line of the frame (the brace that closes the
 * body, which no node holds when the body ends in a return: every line of an
 * added function is a changed one, that brace included).
 */
function inTree(tree: FlowTree, line: number): boolean {
  if (line >= tree.lines[0] && line <= tree.head[1]) return true;
  if (line === tree.lines[1]) return true;
  const visit = (nodes: readonly TreeNode[]): boolean => nodes.some((node) => line >= node.lines[0] && line <= node.lines[1]);
  return visit(tree.nodes);
}

/** Keep an unresolved call visible by requiring a reason, including in callbacks and branches. */
function checkTargets(nodes: readonly TreeNode[], frame: string, failures: string[]): void {
  for (const node of nodes) {
    if (node.target?.kind === 'untraceable' && (typeof node.target.why !== 'string' || node.target.why.trim() === '')) failures.push(`${frame}:${node.id}: an untraceable call has no reason`);
    checkTargets(node.pre ?? [], frame, failures);
    for (const branch of node.branches ?? []) checkTargets(branch.nodes, frame, failures);
  }
}

/**
 * Measure the map (see the module comment): the index, a reader of the
 * frame files by url, and of the text of the source files by id.
 */
export async function checkMap(data: MapData, readFrame: (url: string) => Promise<FrameFile>, readSource: (id: string) => Promise<string | undefined>): Promise<CheckResult> {
  const metrics: MapMetrics = { frames: 0, selections: 0, unnamed: 0, duplicateNames: [], uncovered: [], changedOutside: [], token: {}, undocumented: data.changes?.undocumented ?? [], wiring: { entries: data.wiring?.length ?? 0, untraceable: 0, invalid: 0 } };
  const failures: string[] = [];
  for (const wiring of data.wiring ?? []) {
    const invalid: string[] = [];
    if (wiring.file.trim() === '') invalid.push('has no source file');
    if (wiring.lines.length !== 2 || !wiring.lines.every((line) => Number.isSafeInteger(line) && line >= 1) || wiring.lines[0] > wiring.lines[1]) invalid.push('has invalid source lines');
    if (wiring.status === 'untraceable') {
      metrics.wiring.untraceable += 1;
      if (wiring.why === undefined || wiring.why.trim() === '') invalid.push('is untraceable but has no reason');
    } else if (wiring.status === 'resolved') {
      if (wiring.target === undefined || wiring.target.trim() === '') invalid.push('claims a destination but has no target');
      else if (data.functions[wiring.target] === undefined && data.bodies[wiring.target] === undefined && data.members[wiring.target] === undefined) invalid.push('claims a target absent from the map');
      if ((wiring.destinations?.length ?? 0) === 0 || wiring.destinations?.some((destination) => destination.trim() === '')) invalid.push('claims a destination but names no endpoints');
      else if (wiring.destinations?.some((destination) => {
        const colon = destination.indexOf(':');
        const flow = data.flows[destination.slice(0, colon)];
        return colon < 1 || !flow?.endpoints.some((endpoint) => endpoint.id === destination.slice(colon + 1));
      })) invalid.push('claims an endpoint absent from the map');
    } else invalid.push('has no resolution status');
    if (invalid.length > 0) metrics.wiring.invalid += 1;
    for (const reason of invalid) failures.push(`${wiring.id}: wiring ${reason}`);
  }
  const entries = [...Object.values(data.functions), ...Object.values(data.bodies)];
  const texts = new Map<string, string | undefined>();
  const changed = new Map((data.changes?.frames ?? []).map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (entry.frame === '') continue;
    const file = await readFrame(entry.frame);
    checkTargets(file.tree.nodes, entry.id, failures);
    metrics.frames += 1;
    metrics.selections += file.selections.length;
    const names = new Set<string>();
    for (const selection of file.selections) {
      if (selection.name.trim() === '' || /^\(?\d+\)?$/.test(selection.name.trim())) metrics.unnamed += 1;
      const name = selection.name.replace(/ \(\d+\)$/, '');
      if (names.has(name)) metrics.duplicateNames.push({ frame: entry.id, name });
      names.add(name);
    }
    const source = entry.source?.file;
    if (source !== undefined && !texts.has(source)) texts.set(source, await readSource(source));
    const lines = uncoveredLines(file.tree, source === undefined ? undefined : texts.get(source));
    if (lines.length > 0) metrics.uncovered.push({ frame: entry.id, lines });
    const change = changed.get(entry.id);
    const outside = (change?.changedLines ?? []).filter((line) => !inTree(file.tree, line));
    if (outside.length > 0) metrics.changedOutside.push({ frame: entry.id, lines: outside });
  }
  for (const [framework, flow] of Object.entries(data.flows)) {
    const token = flow.endpoints.find((endpoint) => endpoint.id === 'token');
    if (token === undefined) continue;
    const root = data.bodies[token.root] ?? data.functions[token.root];
    if (root === undefined || root.frame === '') continue;
    const file = await readFrame(root.frame);
    metrics.token[framework] = file.selections.filter((selection) => selection.kind === 'step' || selection.kind === 'exit').map((selection) => selection.name);
  }
  if (metrics.unnamed > 0) failures.push(`${metrics.unnamed} ready-made choices have no name`);
  for (const duplicate of metrics.duplicateNames.slice(0, 10)) failures.push(`${duplicate.frame}: two choices are named "${duplicate.name}"`);
  for (const frame of metrics.uncovered.slice(0, 10)) failures.push(`${frame.frame}: lines ${frame.lines.join(', ')} of the body are in no node`);
  for (const frame of metrics.changedOutside.slice(0, 10)) failures.push(`${frame.frame}: changed lines ${frame.lines.join(', ')} are in no node`);
  for (const [framework, names] of Object.entries(metrics.token)) {
    for (const grant of ['refresh_token', 'authorization_code']) {
      if (!names.some((name) => name.includes(grant))) failures.push(`${framework} /token offers no choice named for ${grant} (${names.join(' | ')})`);
    }
  }
  for (const id of metrics.undocumented) {
    const entry = changed.get(id);
    failures.push(`${entry?.body === true ? `the endpoint body ${entry.name}` : `${entry?.name ?? id}()`} (${entry?.package} ${entry?.module}) changed and reaches an endpoint, but no change note explains it: add a section to apps/map/changes/*.md (pnpm --filter @maronn-openid-connect/map changes:draft writes one)`);
  }
  return { metrics, failures };
}
