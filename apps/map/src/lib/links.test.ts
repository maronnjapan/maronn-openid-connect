import { describe, expect, it } from 'vitest';
import type { CodeIndex, FunctionEntry, MapData, SourceDocument } from '../types';
import { codeIndexOf, currentOf, frameAt, linksByLine, locationOf, replace, segmentsOf, startAt, step, usesOf, visit } from './links';

/** A function of the catalog at some lines of a file. */
function card(id: string, file: string, start: number, end: number): FunctionEntry {
  return { id, name: id.slice(id.indexOf('#') + 1), package: 'core', module: 'a.ts', line: start, exported: true, kind: 'other', summary: '', calls: [], calledBy: [], sites: [], frame: '', source: { file, start, end } };
}

const map = {
  functions: { 'core:a.ts#outer': card('core:a.ts#outer', 'core:a.ts', 1, 20), 'core:a.ts#inner': card('core:a.ts#inner', 'core:a.ts', 5, 9) },
  bodies: { 'endpoint:token': { id: 'endpoint:token', endpoint: 'token', name: 'POST /token', package: 'hono', module: 'p.ts', line: 1, summary: 'Token', calls: [], sites: [], frame: '' } },
  members: { 'core:b.ts#Store.get': { id: 'core:b.ts#Store.get', type: 'Store', member: 'get', summary: '', package: 'core', module: 'b.ts', line: 4, implementedBy: ['core:a.ts#inner'] } },
  features: [],
  sources: { 'core:a.ts': { path: 'packages/core/src/a.ts', url: '' }, 'core:b.ts': { path: 'packages/core/src/b.ts', url: '' } },
} as unknown as MapData;
const data: CodeIndex = codeIndexOf(map);

describe('what following the code needs of the map', () => {
  it('should keep the frames by their lines, the members with their implementations, and the files', () => {
    expect([data.frames['core:a.ts#inner'], data.frames['endpoint:token'], data.members, data.sources]).toEqual([
      { name: 'inner', kind: 'function', source: { file: 'core:a.ts', start: 5, end: 9 } },
      { name: 'POST /token', kind: 'body', summary: 'Token' },
      { 'core:b.ts#Store.get': { type: 'Store', member: 'get', implementedBy: ['core:a.ts#inner'] } },
      map.sources,
    ]);
  });
});

describe('the names of a line with a link', () => {
  it('should read the links of each line in the order of their columns', () => {
    expect([...linksByLine({ targets: [], refs: [2, 9, 3, 1, 2, 0, 4, 0, 5, 1, 1, 0] })]).toEqual([
      [2, [{ column: 0, length: 4, target: 0 }, { column: 9, length: 3, target: 1 }]],
      [5, [{ column: 1, length: 1, target: 0 }]],
    ]);
  });

  it('should cut the tokens where a name starts and ends, and join the tokens of one name', () => {
    const tokens = [{ content: 'import { double } from ', color: 'a' }, { content: "'", color: 's' }, { content: './b', color: 's' }, { content: "';", color: 's' }];
    const links = [{ column: 9, length: 6, target: 0 }, { column: 23, length: 5, target: 1 }];
    expect(segmentsOf(tokens, links).map((segment) => [segment.link?.target ?? null, segment.pieces.map((piece) => piece.content).join('|')])).toEqual([
      [null, 'import { '],
      [0, 'double'],
      [null, ' } from '],
      [1, "'|./b|'"],
      [null, ';'],
    ]);
  });

  it('should leave out a link that does not fit the line or overlaps the one before', () => {
    const tokens = [{ content: 'abc' }];
    expect(segmentsOf(tokens, [{ column: 0, length: 2, target: 0 }, { column: 1, length: 1, target: 1 }, { column: 2, length: 5, target: 2 }]).map((segment) => segment.link?.target ?? null)).toEqual([0, null]);
  });
});

describe('where a link goes', () => {
  it('should open a function of the catalog as that function, and anything else as its file at the name', () => {
    expect([
      locationOf(data, { file: 'core:a.ts', line: 5, column: 16, name: 'inner', kind: 'function', function: 'core:a.ts#inner' }),
      locationOf(data, { file: 'core:b.ts', line: 3, column: 17, name: 'Store', kind: 'interface' }),
      locationOf(data, { file: 'core:b.ts', line: 1, column: 0, name: 'b.ts', kind: 'module' }),
    ]).toEqual([
      { id: 'core:a.ts#inner', line: 5, column: 16, length: 5 },
      { id: 'core:b.ts', line: 3, column: 17, length: 5 },
      { id: 'core:b.ts', line: 1, column: 0, length: 0 },
    ]);
  });

  it('should name a use by the innermost function around it', () => {
    expect([frameAt(data, 'core:a.ts', 7), frameAt(data, 'core:a.ts', 12), frameAt(data, 'core:b.ts', 2)]).toEqual([{ id: 'core:a.ts#inner', name: 'inner()' }, { id: 'core:a.ts#outer', name: 'outer()' }, undefined]);
  });

  it('should list the uses of a declaration by file and line, opening each in its function', () => {
    const document = { uses: { '3:17': [['core:b.ts', 9, 2], ['core:a.ts', 12, 4], ['core:a.ts', 6, 8]] } } as unknown as SourceDocument;
    expect(usesOf(data, document, 3, 17)).toEqual([
      { location: { id: 'core:a.ts#inner', line: 6, column: 8 }, label: 'inner()', path: 'packages/core/src/a.ts', line: 6 },
      { location: { id: 'core:a.ts#outer', line: 12, column: 4 }, label: 'outer()', path: 'packages/core/src/a.ts', line: 12 },
      { location: { id: 'core:b.ts', line: 9, column: 2 }, label: 'b.ts（関数の外）', path: 'packages/core/src/b.ts', line: 9 },
    ]);
  });
});

describe('the history of the places the reader went to', () => {
  it('should go back and forward, and drop the places ahead when the reader goes somewhere new', () => {
    let history = visit(visit(startAt({ id: 'a' }), { id: 'b' }), { id: 'c' });
    history = step(step(history, -1), -1);
    const atStart = currentOf(history).id;
    const beyond = currentOf(step(history, -1)).id;
    history = visit(step(history, 1), { id: 'd' });
    expect([atStart, beyond, history.entries.map((entry) => entry.id), currentOf(step(history, 1)).id]).toEqual(['a', 'a', ['a', 'b', 'd'], 'd']);
  });

  it('should not add a step for the place the reader is at, and replace the place without one', () => {
    const history = visit(startAt({ id: 'a', line: 3 }), { id: 'a', line: 3 });
    expect([history.entries.length, replace(history, { id: 'a', whole: true }).entries]).toEqual([1, [{ id: 'a', whole: true }]]);
  });
});
