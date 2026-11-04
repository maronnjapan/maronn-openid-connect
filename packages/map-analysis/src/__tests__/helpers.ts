/**
 * Build the trees of small sources for the tests: the files go to a temporary
 * directory with a tsconfig.json, compiled as one root (`lib`) with the
 * compiler the analysis uses.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRevision, type EndpointSource, type Revision } from '../analyze.js';
import type { FlowTree, StepMark, TreeNode } from '../model.js';
import type { AnalysisRoot } from '../roots.js';
import type { BuiltTree } from '../tree.js';

/** Join comment lines the way the CLI does for Japanese and English alike (close enough for the tests). */
export function joinLines(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .reduce((text, line) => (text === '' ? line : /[。、]$/.test(text) || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line) ? `${text}${line}` : `${text} ${line}`), '');
}

export interface Fixture {
  revision: Revision;
  /** The tree of a function of `src/a.ts` (or another module) by name. */
  tree(name: string, module?: string): BuiltTree;
  dispose(): void;
}

/**
 * Compile files (path under src/ → text) as the root `lib` and read every
 * function of them; `endpoints` adds endpoint bodies, `steps` the steps of
 * functions.
 */
export function compile(files: Record<string, string>, options: { endpoints?: EndpointSource[]; steps?: Record<string, StepMark>; summaries?: Record<string, string> } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'map-analysis-'));
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] }, include: ['src/**/*'] }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, 'src', path)), { recursive: true });
    writeFileSync(join(directory, 'src', path), text);
  }
  const roots: AnalysisRoot[] = [{ name: 'lib', directory: 'src', exclude: [], project: '.' }];
  const revision = readRevision({
    repository: directory,
    roots,
    files: new Map([['lib', Object.keys(files)]]),
    endpoints: options.endpoints ?? [],
    summaryOf: (id) => options.summaries?.[id],
    stepOf: (id) => options.steps?.[id],
    joinLines,
    joinLinesFlat: joinLines,
  });
  return {
    revision,
    tree(name, module = 'a.ts') {
      const built = revision.trees.get(`lib:${module}#${name}`);
      if (built === undefined) throw new Error(`No tree for ${name} in ${module}: ${[...revision.trees.keys()].join(', ')}`);
      return built;
    },
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** The nodes of a tree as `id kind code`, one line each, indented by depth: a compact picture to assert on. */
export function outline(tree: FlowTree): string[] {
  const lines: string[] = [];
  const visit = (nodes: readonly TreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.pre !== undefined) visit(node.pre, depth + 1);
      lines.push(`${'  '.repeat(depth)}${node.id} ${node.kind} ${node.code}`);
      for (const branch of node.branches ?? []) {
        if (branch.nodes.length === 0) continue;
        lines.push(`${'  '.repeat(depth + 1)}[${branch.key}]`);
        visit(branch.nodes, depth + 2);
      }
    }
  };
  visit(tree.nodes, 0);
  return lines;
}

/** The function targets of the call nodes of a tree, in the order they run. */
export function callOrder(nodes: readonly TreeNode[]): string[] {
  const order: string[] = [];
  const visit = (list: readonly TreeNode[]) => {
    for (const node of list) {
      if (node.pre !== undefined) visit(node.pre);
      if (node.kind === 'call' && node.target?.kind === 'function') order.push(node.target.id.slice(node.target.id.indexOf('#') + 1));
      for (const branch of node.branches ?? []) visit(branch.nodes);
    }
  };
  visit(nodes);
  return order;
}
