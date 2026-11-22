import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLinks } from '../check.js';
import type { LinkTarget, SourceDocument, SourceLinks } from '../model.js';
import { usesOf } from '../symbols.js';
import { compile, type Fixture } from './helpers.js';

const files = {
  'types.ts': ['/** A store of values. */', 'export interface Store {', '  /** Read a value. */', '  get(key: string): string | undefined;', '}', ''].join('\n'),
  'b.ts': ['/** Double a number. */', 'export function double(value: number): number {', '  return value * 2;', '}', ''].join('\n'),
  'a.ts': [
    "import { double } from './b';",
    "import type { Store } from './types';",
    '',
    '/** Read a key and double its length. */',
    'export function run(store: Store, key: string): number {',
    '  const value = store.get(key) ?? "";',
    '  const box = { value };',
    '  return double(Math.max(box.value.length, 0));',
    '}',
    '',
  ].join('\n'),
};

let fixture: Fixture;
beforeAll(() => {
  fixture = compile(files, { links: true });
});
afterAll(() => fixture.dispose());

/** The links of a module of the fixture. */
function linksOf(module: string): SourceLinks {
  const links = fixture.revision.links.get(`lib:${module}`);
  if (links === undefined) throw new Error(`No links for ${module}`);
  return links;
}

/** The target of the name at a line and column (1-based line, 0-based column) of a module, or undefined when the name has no link. */
function targetAt(module: string, line: number, column: number): LinkTarget | undefined {
  const links = linksOf(module);
  for (let index = 0; index < links.refs.length; index += 4) {
    if (links.refs[index] === line && links.refs[index + 1] === column) return links.targets[links.refs[index + 3] as number];
  }
  return undefined;
}

describe('the links of the names of a file', () => {
  it('should send an imported function, in the import and at the call, to its declaration with its catalog id', () => {
    const declaration = { file: 'lib:b.ts', line: 2, column: 16, name: 'double', kind: 'function', function: 'lib:b.ts#double' };
    expect([targetAt('a.ts', 1, 9), targetAt('a.ts', 8, 9)]).toEqual([declaration, declaration]);
  });

  it('should send a module specifier to the first line of the module', () => {
    expect(targetAt('a.ts', 1, 23)).toEqual({ file: 'lib:b.ts', line: 1, column: 0, name: 'b.ts', kind: 'module' });
  });

  it('should send a method called through an interface to the member, named as the trees name members', () => {
    expect(targetAt('a.ts', 6, 22)).toEqual({ file: 'lib:types.ts', line: 4, column: 2, name: 'get', kind: 'method', member: 'lib:types.ts#Store.get' });
  });

  it('should send a parameter, a variable and a shorthand property to their declarations in the file', () => {
    expect([targetAt('a.ts', 6, 16)?.kind, targetAt('a.ts', 6, 16)?.line, targetAt('a.ts', 7, 16)]).toEqual(['parameter', 5, { file: 'lib:a.ts', line: 6, column: 8, name: 'value', kind: 'variable' }]);
  });

  it('should give no link to a name declared outside the roots', () => {
    expect(targetAt('a.ts', 8, 16)).toBeUndefined();
  });

  it('should list the uses of each declaration across the files, its own name left out', () => {
    const uses = usesOf(fixture.revision.links);
    expect(uses.get('lib:b.ts')?.get('2:16')).toEqual([
      ['lib:a.ts', 1, 9],
      ['lib:a.ts', 8, 9],
    ]);
  });
});

const edges = {
  'edge.ts': [
    "export interface Claims { 'acr': string; sub: string }",
    "export const KEY = 'k';",
    'export interface Keyed { [KEY]: number }',
    "export const literal = { 'quoted': 1 };",
    '/** One. */',
    'export function f(): number {',
    '  return 1;',
    '}',
    'f.extra = 1;',
    '',
  ].join('\n'),
  'anon.ts': ['export default function () {', '  return 1;', '}', ''].join('\n'),
  'obj.ts': ['export default { a: 1 };', ''].join('\n'),
  'use.ts': [
    "import run from './anon';",
    "import obj from './obj';",
    "import { f, literal, KEY, type Claims, type Keyed } from './edge';",
    '/** Read them. */',
    'export function read(c: Claims, k: Keyed): number {',
    '  const { sub } = c;',
    '  return run() + obj.a + f.extra + literal.quoted + k[KEY] + c.acr.length + sub.length + take({ sub, acr: "y" });',
    '}',
    '/** Take a context. */',
    'export function take(c: Claims): number {',
    '  return c.sub.length;',
    '}',
    '',
  ].join('\n'),
  'jsx.ts': ['declare global {', '  namespace JSX {', '    interface Element {}', '    interface IntrinsicElements { form: { method?: string } }', '  }', '}', 'export {};', ''].join('\n'),
  'view.tsx': [
    '/** Lay a page out. */',
    'export function Layout(props: { title: string }) {',
    '  return <form method="post">{props.title}</form>;',
    '}',
    '/** A page. */',
    'export function Page() {',
    '  return <Layout title="Sign in" />;',
    '}',
    '',
  ].join('\n'),
};

describe('the links of names the checker reads in their context', () => {
  let edge: Fixture;
  beforeAll(() => {
    edge = compile(edges, { links: true, compilerOptions: { jsx: 'preserve' } });
  });
  afterAll(() => edge.dispose());

  /** The target of the n-th occurrence (from 0) of a word on a line (1-based) of a module of the fixture. */
  const targetOf = (module: string, line: number, word: string, nth = 0): LinkTarget | undefined => {
    const text = edge.revision.texts.get(`lib:${module}`)?.split('\n')[line - 1] ?? '';
    let column = -1;
    for (let count = 0; count <= nth; count += 1) column = text.indexOf(word, column + 1);
    const links = edge.revision.links.get(`lib:${module}`);
    for (let index = 0; index < (links?.refs.length ?? 0); index += 4) {
      if (links?.refs[index] === line && links.refs[index + 1] === column) return links.targets[links.refs[index + 3] as number];
    }
    return undefined;
  };

  it('should pass the check of the links: quoted, computed and anonymous names are where their links say', () => {
    const documents = new Map<string, SourceDocument>([...edge.revision.links].map(([id, links]) => [id, { code: edge.revision.texts.get(id) ?? '', foreground: '', background: '', tokens: [], links }]));
    expect(checkLinks(documents).broken).toEqual([]);
  });

  it('should send a default import to the `default` of the export, and its module specifier to the module', () => {
    expect([targetOf('use.ts', 1, 'run'), targetOf('use.ts', 2, "'./obj'"), targetOf('use.ts', 2, 'obj')]).toEqual([
      { file: 'lib:anon.ts', line: 1, column: 7, name: 'default', kind: 'function', function: 'lib:anon.ts#default' },
      { file: 'lib:obj.ts', line: 1, column: 0, name: 'obj.ts', kind: 'module' },
      { file: 'lib:obj.ts', line: 1, column: 7, name: 'default', kind: 'other' },
    ]);
  });

  it('should send a quoted, a computed and an added property to the name as written', () => {
    expect([targetOf('use.ts', 7, 'quoted'), targetOf('use.ts', 7, 'acr'), targetOf('use.ts', 7, 'extra')]).toEqual([
      { file: 'lib:edge.ts', line: 4, column: 25, name: "'quoted'", kind: 'property' },
      { file: 'lib:edge.ts', line: 1, column: 26, name: "'acr'", kind: 'property', member: 'lib:edge.ts#Claims.acr' },
      { file: 'lib:edge.ts', line: 9, column: 2, name: 'extra', kind: 'other' },
    ]);
  });

  it('should send a destructured name, a property of an object literal passed on, and a prop of JSX to the property they stand for', () => {
    const sub = { file: 'lib:edge.ts', line: 1, column: 41, name: 'sub', kind: 'property', member: 'lib:edge.ts#Claims.sub' };
    expect([targetOf('use.ts', 6, 'sub'), targetOf('use.ts', 7, 'acr', 1), targetOf('view.tsx', 7, 'title')]).toEqual([
      sub,
      { file: 'lib:edge.ts', line: 1, column: 26, name: "'acr'", kind: 'property', member: 'lib:edge.ts#Claims.acr' },
      { file: 'lib:view.tsx', line: 2, column: 32, name: 'title', kind: 'property' },
    ]);
  });

  it('should count those as uses of the property', () => {
    expect(usesOf(edge.revision.links).get('lib:edge.ts')?.get('1:41')).toEqual([
      ['lib:use.ts', 6, 10],
      ['lib:use.ts', 11, 11],
    ]);
  });
});
