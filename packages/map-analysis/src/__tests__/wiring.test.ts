import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Resolver } from '../resolve.js';
import type { AnalysisRoot } from '../roots.js';
import { Compiler, SyntaxKind } from '../ts.js';
import { endLine, is, startLine } from '../ast.js';
import { scanWiring } from '../wiring.js';

/** Scan files as one compiler project without depending on any catalog function being present. */
function scan(files: Record<string, string>, module = 'a.ts') {
  const directory = mkdtempSync(join(tmpdir(), 'map-wiring-'));
  const config = join(directory, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] }, include: ['src/**/*'] }));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, 'src', path)), { recursive: true });
    writeFileSync(join(directory, 'src', path), source);
  }
  const compiler = new Compiler(directory, new Map([[config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, types: [] }, include: ['src/**/*'] })]]));
  try {
    const project = compiler.project(config);
    const file = project.program.getSourceFile(join(directory, 'src', module));
    if (file === undefined) throw new Error(`No source for ${module}`);
    const roots: AnalysisRoot[] = [{ name: 'lib', directory: 'src', exclude: [], project: '.' }];
    const resolver = new Resolver(project, { repository: directory, roots, isFunction: () => true, paragraph: (text) => text });
    const tracedRanges = file.statements.flatMap((node) => is(node, SyntaxKind.FunctionDeclaration) && node['body'] !== undefined && !(node['modifiers'] as { kind: SyntaxKind }[] | undefined)?.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword) ? [[startLine(file, node), endLine(file, node)] as [number, number]] : []);
    return scanWiring({ file, fileId: `lib:${module}`, resolver, checker: project.checker, resolution: resolver.resolve([file]), tracedRanges });
  } finally {
    compiler.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('wiring outside ordinary call paths', () => {
  it('should retain module startup with no catalog function and exclude deferred arrow bodies from startup', () => {
    const entries = scan({ 'a.ts': `
declare const factory: () => unknown;
export const current = factory();
export const later = () => factory();
` });
    expect(entries.filter((entry) => entry.kind === 'initialization').map((entry) => entry.code)).toEqual(['current = factory()']);
    expect(entries.find((entry) => entry.code.startsWith('later ='))).toMatchObject({ kind: 'callback', status: 'untraceable' });
  });

  it('should retain default-export startup even when no named variable or catalog function exists', () => {
    const entries = scan({ 'a.ts': 'declare const build: () => unknown; export default build();' });
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'initialization', code: 'export default build();', status: 'untraceable' }));
  });

  it('should identify aliased named callback references while preserving the unknown destination and invocation time', () => {
    const entries = scan({
      'a.ts': `
import { callback as registered } from './b';
declare const subscribe: (callback: () => void) => void;
export function setup() { subscribe(registered); }
`,
      'b.ts': 'export function callback() {}',
    });
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'callback', code: 'registered', target: 'lib:b.ts#callback', status: 'untraceable' }));
    expect(entries.find((entry) => entry.code === 'registered')?.why).toContain('呼び出し時点');
  });

  it('should inventory inline, named, and shorthand hooks kept in objects without treating them as startup calls', () => {
    const entries = scan({ 'a.ts': `
export function hook() {}
export const feature = { inline() { hook(); }, named: hook, hook };
` });
    expect(entries.filter((entry) => entry.kind === 'initialization')).toEqual([]);
    expect(entries.filter((entry) => entry.kind === 'callback').map((entry) => entry.code)).toEqual(['inline() { hook(); }', 'named: hook', 'hook']);
    expect(entries.filter((entry) => entry.target === 'lib:a.ts#hook')).toHaveLength(2);
  });

  // An optional function value typed with a type query, such as the
  // outboundFetch the Next.js provider passes on: `typeof fetch | undefined`.
  it('should inventory a hook whose declared type is a type query of a function, optional or not', () => {
    const entries = scan({ 'a.ts': `
declare function send(input: string): Promise<string>;
declare function use(options: { send?: typeof send }): void;
export const optional: typeof send | undefined = undefined;
export const required: typeof send = send;
export function setup() { use(optional === undefined ? {} : { send: optional }); use({ send: required }); }
` });
    expect(entries.filter((entry) => entry.kind === 'callback').map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['send: optional', 'send: required']),
    );
  });

  it('should not inventory a value whose type query names a value that is not a function', () => {
    const entries = scan({ 'a.ts': `
declare const limit: number;
declare function use(options: { limit?: typeof limit }): void;
export const current: typeof limit | undefined = undefined;
export function setup() { use({ limit: current }); }
` });
    expect(entries.filter((entry) => entry.code === 'limit: current')).toEqual([]);
  });

  it('should keep dynamic request-context writes and middleware separate from typed Map writes', () => {
    const entries = scan({ 'a.ts': `
declare const router: { use(path: string, handler: () => void): void };
export function handler() {}
export function setup(c: any, key: string, values: Map<string, unknown>) {
  c.set(key, handler);
  values.set(key, handler);
  router.use('/token/*', handler);
}
` });
    expect(entries.filter((entry) => entry.kind === 'context').map((entry) => entry.code)).toEqual(['c.set(key, handler)']);
    expect(entries.find((entry) => entry.kind === 'middleware')).toMatchObject({ code: "router.use('/token/*', handler)", target: 'lib:a.ts#handler', status: 'untraceable' });
  });

  it('should omit array iteration represented in the tree but retain a custom API with the same method name', () => {
    const entries = scan({ 'a.ts': `
export function callback(value: number) { return value; }
export function run(items: number[], custom: { map(fn: (value: number) => number): void }) {
  items.map(callback);
  custom.map(callback);
}
` });
    expect(entries.filter((entry) => entry.kind === 'callback' && entry.code === 'callback')).toHaveLength(1);
  });

  it('should retain an unbound returned callable bundle including shorthand methods, while recognizing typed implementations', () => {
    const entries = scan({ 'a.ts': `
interface Hook { run(): void }
export function callback() {}
export function known(): Hook { return { run() { callback(); } }; }
export function unknown() { return { callback }; }
` });
    expect(entries.filter((entry) => entry.code.startsWith('return '))).toEqual([
      expect.objectContaining({ kind: 'callback', code: 'return { callback };', status: 'untraceable', why: expect.stringContaining('結び付かない') }),
    ]);
  });

  it('should retain router mounts and module aliases of callable factories', () => {
    const entries = scan({ 'a.ts': `
declare const app: { route(path: string, router: unknown): void };
export function build() { return {}; }
export const createDatabase = build;
app.route('/', build());
` });
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'middleware', code: "app.route('/', build())", target: 'lib:a.ts#build', status: 'untraceable' }));
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'callback', code: 'createDatabase = build', target: 'lib:a.ts#build', status: 'untraceable' }));
  });

  it('should retain native iteration callbacks in class methods and default-export functions without a flow frame', () => {
    const entries = scan({ 'a.ts': `
export class Registry { run(items: string[]) { return items.map((item) => item); } }
export default function Page() { return ['x'].map((value) => value); }
` });
    expect(entries.filter((entry) => entry.kind === 'callback').map((entry) => entry.code).sort()).toEqual(['(item) => item', "export default function Page() { return ['x'].map((value) => value); }", '(value) => value'].sort());
    expect(entries.every((entry) => entry.status === 'untraceable')).toBe(true);
  });

  it('should retain returned function values and anonymous default exports without inventing an immediate call', () => {
    const entries = scan({ 'a.ts': `
export function helper() {}
export function makeHook() { return () => helper(); }
export default () => helper();
` });
    expect(entries.filter((entry) => entry.kind === 'callback').map((entry) => entry.code)).toEqual(['() => helper()', '() => helper()']);
    expect(entries.every((entry) => entry.status === 'untraceable')).toBe(true);
    expect(entries.filter((entry) => entry.kind === 'initialization')).toEqual([]);
  });
});
