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
 * - In the map of a pull request, every change that needs a note has one,
 *   and a related test was added or changed for it, or its note says why
 *   not (MapChanges.untested, from packages/test-catalog).
 * - Wiring outside ordinary call paths retains its source and a reason when
 *   unresolved; claiming a destination requires a target and destinations.
 * - Every unresolved call node explains why it cannot be followed.
 * - With the requests of a measured run or of the OP of the map
 *   (MapData.requests): every way they name is a ready-made choice of its
 *   root (its kind and target), so the flow view finds the request of the
 *   way chosen, and every request of a test says the line of its test that
 *   sent it and the code of that line.
 */
import type { FlowTree, FrameFile, MapData, RootRequests, SourceDocument, TreeNode } from './model.js';

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
  /** The changes that need a note whose related tests the pull request did not touch, with no reason given (MapChanges.untested). */
  untested: string[];
  /** Wiring inventory entries, their unresolved count, and malformed output entries. */
  wiring: { entries: number; untraceable: number; invalid: number };
  /** The requests of the measured run (MapData.requests): the roots, the ways and the requests, and the ways no choice of their root is. */
  requests: { roots: number; ways: number; examples: number; samples: number; unmatched: number };
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
 * declaration), or on its closing line. The brace that closes the body is no
 * part of it (`uncoveredLines` stops before it), yet an added function counts
 * every line of its span as changed, the closing line among them.
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
 * Check the requests of a measured run and of the OP of the map against the frames of their roots
 * (see the module comment), adding to the metrics and the failures.
 */
async function checkRequests(data: MapData, readFrame: (url: string) => Promise<FrameFile>, readRequests: (url: string) => Promise<RootRequests>, metrics: MapMetrics, failures: string[]): Promise<void> {
  for (const [root, url] of Object.entries(data.requests ?? {})) {
    const entry = data.bodies[root] ?? data.functions[root];
    if (entry === undefined || entry.frame === '') {
      failures.push(`${root}: the requests name a root the map has no frame of`);
      continue;
    }
    const [file, requests] = await Promise.all([readFrame(entry.frame), readRequests(url)]);
    metrics.requests.roots += 1;
    if (requests.root !== root) failures.push(`${root}: its requests file is of ${requests.root}`);
    for (const way of requests.ways) {
      metrics.requests.ways += 1;
      metrics.requests.examples += way.examples.length;
      if (way.sample !== undefined) metrics.requests.samples += 1;
      if (!file.selections.some((selection) => selection.kind === way.kind && selection.target === way.target)) {
        metrics.requests.unmatched += 1;
        failures.push(`${root}: the requests name the way ${way.kind} "${way.name}" (${way.target}), which no ready-made choice of the root is: the flow view would not show them`);
      }
      for (const example of way.examples) {
        if (!Number.isSafeInteger(example.test.line) || example.test.line < 1 || example.test.code.trim() === '' || example.test.file.trim() === '') failures.push(`${root}: a request of the way "${way.name}" names no line of the code of its test ${example.test.id}`);
      }
    }
  }
}

/**
 * Measure the map (see the module comment): the index, a reader of the
 * frame files by url, of the text of the source files by id, and of the
 * requests files by url (MapData.requests).
 */
export async function checkMap(
  data: MapData,
  readFrame: (url: string) => Promise<FrameFile>,
  readSource: (id: string) => Promise<string | undefined>,
  readRequests: (url: string) => Promise<RootRequests> = async (url) => {
    throw new Error(`no reader of the requests file ${url}`);
  },
): Promise<CheckResult> {
  const metrics: MapMetrics = {
    frames: 0,
    selections: 0,
    unnamed: 0,
    duplicateNames: [],
    uncovered: [],
    changedOutside: [],
    token: {},
    undocumented: data.changes?.undocumented ?? [],
    untested: data.changes?.untested ?? [],
    wiring: { entries: data.wiring?.length ?? 0, untraceable: 0, invalid: 0 },
    requests: { roots: 0, ways: 0, examples: 0, samples: 0, unmatched: 0 },
  };
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
  const features = new Set(data.features.map((feature) => feature.id));
  for (const [id, source] of Object.entries(data.sources)) {
    if (source.features === undefined) continue;
    const text = await readSource(id);
    texts.set(id, text);
    const last = text === undefined ? undefined : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    for (const range of source.features) {
      if (!features.has(range.feature)) failures.push(`${id}: source range names unknown feature ${range.feature}`);
      if (range.lines.length !== 2 || !range.lines.every((line) => Number.isSafeInteger(line) && line >= 1) || range.lines[0] > range.lines[1] || (last !== undefined && range.lines[1] > last)) failures.push(`${id}: feature ${range.feature} has invalid source lines`);
    }
  }
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
  await checkRequests(data, readFrame, readRequests, metrics, failures);
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
  for (const id of metrics.untested) {
    const entry = data.changes?.frames.find((frame) => frame.id === id);
    failures.push(
      `${entry?.body === true ? `the endpoint body ${entry.name}` : `${entry?.name ?? id}()`} (${entry?.package} ${entry?.module}) changed and reaches an endpoint, but this pull request adds or changes none of its related tests: ` +
        `change a test that names or reaches it, or write why the tests stay as they are on a line \`テストを変えない理由: …\` in its section of apps/map/changes/*.md`,
    );
  }
  return { metrics, failures };
}

/** What the check of the links of the code measures and fails on. */
export interface LinkCheck {
  /** The names with a link, over all the files. */
  links: number;
  /** One line each: a link whose file the map has no source of, or whose name or declaration is not where it says. */
  broken: string[];
}

/**
 * Check the links of the code (SourceDocument.links): every declaration they
 * go to is a file the map carries, and the declaration's name is at its line
 * and column; every name with a link is a name (an identifier or a module
 * specifier) at its line and column. A link that points beside its name
 * would open the code view at the wrong place without anyone noticing.
 */
export function checkLinks(documents: ReadonlyMap<string, SourceDocument>): LinkCheck {
  const result: LinkCheck = { links: 0, broken: [] };
  const lines = new Map<string, string[]>([...documents].map(([id, document]) => [id, document.code.split('\n')]));
  for (const [id, document] of documents) {
    const own = lines.get(id) ?? [];
    const table = document.links;
    if (table === undefined) continue;
    for (const target of table.targets) {
      const text = lines.get(target.file);
      if (text === undefined) result.broken.push(`${id}: ${target.name} goes to ${target.file}, which the map has no source of`);
      else if (target.kind !== 'module' && text[target.line - 1]?.startsWith(target.name, target.column) !== true) result.broken.push(`${id}: ${target.name} is not at ${target.file}:${target.line}:${target.column}`);
    }
    for (let index = 0; index < table.refs.length; index += 4) {
      const [line, column, length] = table.refs.slice(index, index + 3) as [number, number, number];
      const name = own[line - 1]?.slice(column, column + length) ?? '';
      result.links += 1;
      // A name of JSX (`aria-label`) may hold a hyphen.
      if (!/^(?:[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$-]*|(['"]).*\1)$/u.test(name) || table.targets[table.refs[index + 3] as number] === undefined) result.broken.push(`${id}:${line}:${column}: the link of ${length} characters is on "${name}", not a name`);
    }
  }
  return result;
}
