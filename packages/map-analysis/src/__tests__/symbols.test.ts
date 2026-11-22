import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LinkTarget, SourceLinks } from '../model.js';
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
