/**
 * The data of the map (model.ts), written to a directory (apps/map/public/data):
 *
 * - map.json: the frameworks, the commands and the features, the flow of each
 *   framework with every feature on (each endpoint naming the frame its
 *   trace starts from), every function of the catalog and every endpoint
 *   body with what its tree calls and how it fails, the members of the
 *   interfaces (who implements each and what the implementations call),
 *   and in the map of a pull request its changes.
 * - functions/<hash>.json: one file a frame, with its tree and its
 *   ready-made choices, and for a changed frame its tree before and the diff.
 * - sources/<hash>.json: one file a source file, its code highlighted.
 * - changes.md: the changes in Markdown, for the comment on the pull request.
 *
 * With `base` (a git revision), the changes of the working tree since it
 * forked from it (changes.ts) come with it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { BodyEntry, Failure, FlowEndpoint, FrameFile, FunctionEntry, MapChanges, MapData, MemberDoc, OpFlow } from './model.js';
import { escapingFailures } from './failures.js';
import { featureOfPath, sourceFeatureRanges } from './features.js';
import { createSourceHighlighter, highlightSource } from './highlight.js';
import { readRepository, type Repository } from './repository.js';
import { failureSelections, frameSelections } from './selections.js';
import { nodesOf } from './tree.js';
import { collectChanges, changesMarkdown, type ChangeResult } from './changes.js';

/**
 * The page shows the text of a JSDoc as it is, so a `{@link Name}` of the
 * libraries becomes the name as code, and `{@link Name | text}` its text.
 */
export function plain(text: string): string {
  return text.replace(/\{@link(?:code|plain)?\s+([^}|\s]+)(?:\s*\|\s*([^}]+)|\s+([^}]+))?\}/g, (_match, name: string, piped?: string, spaced?: string) => {
    const label = (piped ?? spaced)?.trim();
    return label === undefined || label === '' ? `\`${name}\`` : label;
  });
}

/** A file name for some content: its hash, so a changed file gets a new name and a cache never serves an old one. */
function hashed(id: string, content: string): string {
  return `${createHash('sha256').update(id).update('\0').update(content).digest('hex')}.json`;
}

/**
 * Write a file of a directory under the name its content hashes to (see
 * hashed), unless the directory has it already whole (the same name holds
 * the same content), and note the name in `written`. The directory is made when
 * missing, never emptied first: a dev server serving it (vite) would stop
 * seeing the files written again into a directory it saw removed.
 */
export function writeHashed(directory: string, id: string, content: string, written: Set<string>): string {
  const name = hashed(id, content);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  if (!existsSync(path) || statSync(path).size !== Buffer.byteLength(content)) writeFileSync(path, content);
  written.add(name);
  return name;
}

/** Remove the files of a directory a build did not write (see writeHashed): those of an earlier build. */
export function removeStale(directory: string, written: ReadonlySet<string>): void {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) if (!written.has(name)) rmSync(join(directory, name), { recursive: true, force: true });
}

export interface BuildOptions {
  /** The root of the repository. */
  repository: string;
  /** The directory to write to (public/data of apps/map). */
  out: string;
  /** A git revision to show the changes since (origin/main). */
  base?: string;
  pullRequest?: MapChanges['pullRequest'];
  /** The built CLI (packages/cli/dist). */
  cliDist?: string;
  /**
   * More work on the analysis before map.json and changes.md are written
   * (the tests of packages/test-catalog): it may write files of its own (the
   * data of the tests viewer, apps/tests), add to the changes
   * (MapChanges.untested), and returns the sections it adds to changes.md.
   */
  extend?: (context: BuildContext) => Promise<BuildExtension | void> | BuildExtension | void;
}

/** What a build hands to its extension (BuildOptions.extend). */
export interface BuildContext {
  data: MapData;
  repository: Repository;
  changes?: ChangeResult;
  /** The directory the data is written to. */
  out: string;
  /** The failures that leave each frame of the working tree. */
  failures: ReadonlyMap<string, Failure[]>;
  log: string[];
}

/** What an extension adds to the build: sections of changes.md (each under its own `###` heading). */
export interface BuildExtension {
  sections?: string[];
}

export interface BuildResult {
  data: MapData;
  repository: Repository;
  changes?: ChangeResult;
  /** What the build says about itself, one line each. */
  log: string[];
  /** changes.md as written, in the map of a pull request. */
  markdown?: string;
}

/** Build the data of the map (see the module comment) and write it. */
export async function buildMap(options: BuildOptions): Promise<BuildResult> {
  const repository = await readRepository(options.repository, options.cliDist);
  const { cli, head, roots } = repository;
  const log: string[] = [];
  const trees = new Map([...head.trees].map(([id, built]) => [id, built.tree]));
  const failures = escapingFailures(trees);

  // The changes, before the files are written: a changed frame's file carries its diff.
  const changes = options.base === undefined ? undefined : collectChanges({ repository, base: options.base, ...(options.pullRequest === undefined ? {} : { pullRequest: options.pullRequest }), failures });

  // The files are written in place and the stale ones removed after (see writeHashed, removeStale): a dev server already serving the directory keeps seeing it.
  const written = { functions: new Set<string>(), sources: new Set<string>() };

  // One file a frame.
  const frameUrls = new Map<string, string>();
  for (const [id, built] of head.trees) {
    const selections = [...frameSelections(built.tree, built.uses), ...failureSelections(id, trees, failures, (callee) => cli.catalog[callee]?.name ?? trees.get(callee)?.name ?? callee)];
    const file: FrameFile = { version: 4, tree: built.tree, selections };
    const change = changes?.frames.get(id);
    if (change !== undefined) file.change = change;
    frameUrls.set(id, `./data/functions/${writeHashed(join(options.out, 'functions'), id, JSON.stringify(file), written.functions)}`);
  }
  // The frames of removed functions: their tree before, for the page of the changes.
  for (const [id, change] of changes?.frames ?? []) {
    if (frameUrls.has(id) || change.before === undefined) continue;
    const file: FrameFile = { version: 4, tree: change.before, selections: [], change };
    frameUrls.set(id, `./data/functions/${writeHashed(join(options.out, 'functions'), id, JSON.stringify(file), written.functions)}`);
  }

  /** What a tree calls: the functions (in the order of the first call, its own deferred calls after), the members, the call nodes, the untraceable calls. */
  const callsOf = (id: string) => {
    const tree = trees.get(id);
    const calls: string[] = [];
    const members: string[] = [];
    const sites: Array<[string, string]> = [];
    let untraceable = 0;
    for (const node of nodesOf(tree?.nodes ?? [])) {
      if (node.kind !== 'call' || node.target === undefined) continue;
      if (node.target.kind === 'untraceable') {
        untraceable += 1;
        continue;
      }
      sites.push([node.id, node.target.id]);
      const list = node.target.kind === 'function' ? calls : members;
      if (!list.includes(node.target.id) && node.target.id !== id) list.push(node.target.id);
    }
    for (const deferred of tree?.deferred ?? []) {
      const list = cli.catalog[deferred] !== undefined ? calls : head.members.has(deferred) ? members : undefined;
      if (list !== undefined && !list.includes(deferred) && deferred !== id) list.push(deferred);
    }
    return { calls, members, sites, untraceable };
  };

  // The source files the code drawer opens, each once.
  const sourceFiles = new Map<string, { path: string; code: string }>();
  const sourceOf = (root: string, module: string): string => {
    const id = `${root}:${module}`;
    if (!sourceFiles.has(id)) {
      const entry = roots.find((candidate) => candidate.name === root);
      const code = head.texts.get(id);
      if (entry === undefined || code === undefined) throw new Error(`Source missing: ${id}`);
      sourceFiles.set(id, { path: posix.join(entry.directory, module), code });
    }
    return id;
  };

  const functions: Record<string, FunctionEntry> = {};
  for (const card of Object.values(cli.catalog).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const frame = head.frames.get(card.id);
    const { calls, members, sites, untraceable } = callsOf(card.id);
    const entry: FunctionEntry = {
      id: card.id,
      name: card.name,
      package: card.package,
      module: card.module,
      line: card.line,
      exported: card.exported,
      kind: card.kind,
      summary: plain(card.summary),
      calls,
      calledBy: [],
      sites,
      frame: frameUrls.get(card.id) ?? '',
    };
    if (card.description !== undefined) entry.description = plain(card.description);
    if (card.spec !== undefined) entry.spec = card.spec;
    if (card.throws !== undefined) entry.throws = card.throws.map(plain);
    if (members.length > 0) entry.members = members;
    if (untraceable > 0) entry.untraceable = untraceable;
    const failed = failures.get(card.id) ?? [];
    if (failed.length > 0) entry.failures = failed;
    if (frame !== undefined) entry.source = { file: sourceOf(card.package, card.module), start: frame.start, end: frame.end };
    const path = entry.source === undefined ? undefined : sourceFiles.get(entry.source.file)?.path;
    const feature = path === undefined ? undefined : featureOfPath(path, cli.features);
    if (feature !== undefined) entry.feature = feature;
    functions[card.id] = entry;
  }
  const bodies: Record<string, BodyEntry> = {};
  for (const frame of head.frames.values()) {
    if (frame.kind !== 'body' || frame.endpoint === undefined) continue;
    const { calls, members, sites, untraceable } = callsOf(frame.id);
    const endpoint = repository.endpoints.find((source) => source.source === frame.source)?.endpoints.find((candidate) => candidate.id === frame.endpoint);
    const entry: BodyEntry = {
      id: frame.id,
      endpoint: frame.endpoint,
      name: frame.name,
      package: frame.root,
      module: frame.module,
      line: frame.line,
      summary: plain(endpoint?.summary ?? ''),
      calls,
      sites,
      frame: frameUrls.get(frame.id) ?? '',
    };
    if (members.length > 0) entry.members = members;
    if (untraceable > 0) entry.untraceable = untraceable;
    const failed = failures.get(frame.id) ?? [];
    if (failed.length > 0) entry.failures = failed;
    if (frame.synthetic === true) entry.synthetic = true;
    else entry.source = { file: sourceOf(frame.root, frame.module), start: frame.start, end: frame.end };
    const feature = endpoint?.feature === undefined ? undefined : (cli.featureIds[endpoint.feature] ?? endpoint.feature);
    if (feature !== undefined) entry.feature = feature;
    bodies[frame.id] = entry;
  }
  for (const entry of [...Object.values(functions), ...Object.values(bodies)]) {
    for (const callee of entry.calls) {
      const target = functions[callee];
      if (target !== undefined && !target.calledBy.includes(entry.id)) target.calledBy.push(entry.id);
    }
  }
  for (const entry of Object.values(functions)) entry.calledBy.sort();

  const members: Record<string, MemberDoc> = {};
  for (const [id, member] of [...head.members].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) members[id] = { ...member, summary: plain(member.summary) };
  // Who implements each member, and what the implementations call (the functions of the catalog and the members).
  for (const [id, tree] of trees) {
    for (const implementation of tree.implements ?? []) {
      const member = members[implementation.member];
      if (member === undefined) continue;
      member.implementedBy ??= [];
      if (!member.implementedBy.includes(id)) member.implementedBy.push(id);
      for (const callee of implementation.calls ?? []) {
        if (callee === implementation.member || (cli.catalog[callee] === undefined && members[callee] === undefined)) continue;
        member.calls ??= [];
        if (!member.calls.includes(callee)) member.calls.push(callee);
      }
    }
  }

  const flows: Record<string, OpFlow> = {};
  for (const framework of cli.frameworks) {
    const flow = cli.flows[framework];
    const definition = cli.definition.frameworks[framework];
    if (flow === undefined || definition === undefined) continue;
    flows[framework] = {
      ...flow,
      endpoints: flow.endpoints.map((endpoint): FlowEndpoint => {
        const root = head.endpointRoots.get(`${definition.source}:${endpoint.id}`) ?? '';
        const withRoot: FlowEndpoint = { ...endpoint, root, ...(endpoint.summary === undefined ? {} : { summary: plain(endpoint.summary) }) };
        if (endpoint.module !== undefined && head.texts.has(`${definition.source}:${definition.root}/${endpoint.module}`)) withRoot.source = sourceOf(definition.source, `${definition.root}/${endpoint.module}`);
        return withRoot;
      }),
    };
  }

  // The code, highlighted, one file each.
  for (const entry of head.wiring) {
    const colon = entry.file.indexOf(':');
    sourceOf(entry.file.slice(0, colon), entry.file.slice(colon + 1));
  }
  const highlighter = await createSourceHighlighter();
  const sources: MapData['sources'] = {};
  // Endpoint metadata also owns route files outside feature directories.
  const endpointOwners = new Map<string, string>();
  for (const source of repository.endpoints) {
    for (const endpoint of source.endpoints) {
      if (endpoint.feature === undefined) continue;
      const id = head.endpointRoots.get(`${source.source}:${endpoint.id}`);
      const frame = id === undefined ? undefined : head.frames.get(id);
      if (frame !== undefined) endpointOwners.set(`${frame.root}:${frame.module}`, cli.featureIds[endpoint.feature] ?? endpoint.feature);
    }
  }
  for (const [id, source] of [...sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const features = sourceFeatureRanges(source.path, source.code, cli.features, cli.parseOwnerBlocks, endpointOwners.get(id) ?? featureOfPath(source.path, cli.features));
    const ownership = features.length === 0 ? {} : { features };
    const name = writeHashed(join(options.out, 'sources'), id, JSON.stringify({ ...highlightSource(highlighter, source), ...ownership }), written.sources);
    sources[id] = { path: source.path, url: `./data/sources/${name}`, ...ownership };
  }
  highlighter.dispose();
  removeStale(join(options.out, 'functions'), written.functions);
  removeStale(join(options.out, 'sources'), written.sources);

  const data: MapData = {
    version: 4,
    frameworks: cli.frameworks,
    commands: cli.commands,
    features: cli.features,
    flows,
    functions,
    bodies,
    members,
    wiring: head.wiring,
    sources,
    ...(changes === undefined ? {} : { changes: changes.changes }),
  };
  const extension = (await options.extend?.({ data, repository, ...(changes === undefined ? {} : { changes }), out: options.out, failures, log })) ?? {};
  writeFileSync(join(options.out, 'map.json'), JSON.stringify(data));
  const changesFile = join(options.out, 'changes.md');
  const markdown = changes === undefined ? undefined : changesMarkdown(changes.changes, { sections: extension.sections ?? [] });
  if (markdown === undefined) rmSync(changesFile, { force: true });
  else writeFileSync(changesFile, markdown);

  const steps = Object.values(flows).reduce((count, flow) => count + flow.endpoints.reduce((sum, endpoint) => sum + endpoint.steps.length, 0), 0);
  const untraceable = [...Object.values(functions), ...Object.values(bodies)].reduce((count, entry) => count + (entry.untraceable ?? 0), 0);
  log.push(
    `${cli.frameworks.length} frameworks, ${steps} steps, ${Object.keys(functions).length} functions, ${Object.keys(bodies).length} endpoint bodies, ` +
      `${Object.keys(members).length} interface members, ${untraceable} untraceable calls, ${head.wiring.length} wiring diagnostics, ${Object.keys(sources).length} source files`,
  );
  return { data, repository, ...(changes === undefined ? {} : { changes }), log, ...(markdown === undefined ? {} : { markdown }) };
}
