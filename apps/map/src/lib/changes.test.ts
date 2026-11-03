import { describe, expect, it } from 'vitest';
import type { FrameChange, FrameChangeEntry, MapData } from '../types';
import { allHunks, belowCounts, changeName, countWords, diffStat, endpointMark, frameMark, groupChanges, indexChanges, inlineParts, markOf, nodeMark, noteBlocks, numberHunk, strongest } from './changes';

const entry = (id: string, name: string, kind: FrameChangeEntry['kind'], extra: Partial<FrameChangeEntry> = {}): FrameChangeEntry => ({
  id,
  name,
  package: id.slice(0, id.indexOf(':')),
  module: id.slice(id.indexOf(':') + 1, id.includes('#') ? id.indexOf('#') : undefined),
  line: 1,
  kind,
  summary: [],
  counts: {},
  reach: [],
  documented: false,
  required: false,
  ...extra,
});

/** /token calls top, top calls mid, mid calls leaf and a member of a store whose implementation the change added. */
const data = {
  functions: {
    'core:a.ts#top': { id: 'core:a.ts#top', name: 'top', sites: [['s0', 'core:a.ts#mid']], frame: 'f1' },
    'core:a.ts#mid': { id: 'core:a.ts#mid', name: 'mid', sites: [['s0', 'core:a.ts#leaf'], ['s1', 'core:store.ts#Store.get']], frame: 'f2' },
    'core:a.ts#leaf': { id: 'core:a.ts#leaf', name: 'leaf', sites: [], frame: 'f3' },
    'core:impl.ts#get': { id: 'core:impl.ts#get', name: 'get', sites: [], frame: 'f4' },
    'core:a.ts#described': { id: 'core:a.ts#described', name: 'described', sites: [], frame: 'f5' },
  },
  bodies: { 'endpoint:token': { id: 'endpoint:token', name: 'POST /token', sites: [['s1', 'core:a.ts#top']], frame: 'f6' } },
  changes: {
    base: { ref: 'origin/main', commit: 'abc' },
    head: { commit: 'def', dirty: false },
    notes: [],
    frames: [
      entry('core:a.ts#leaf', 'leaf', 'modified', { counts: { 'condition~': 1 } }),
      entry('core:impl.ts#get', 'get', 'added', { counts: { 'call+': 2 }, members: ['core:store.ts#Store.get'] }),
      entry('core:a.ts#described', 'described', 'docs'),
      entry('endpoint:token', 'token', 'modified', { body: true, counts: { 'condition+': 1 } }),
    ],
    unmatched: [],
    unknown: [],
    ambiguous: [],
    undocumented: [],
    outside: [],
    otherFiles: 0,
  },
} as unknown as MapData;
const index = indexChanges(data);

describe('the badges of the changes', () => {
  it('should mark a frame by its own change of code, else by a change below it, else by its other change', () => {
    expect(frameMark(index, 'core:a.ts#leaf')?.kind).toBe('modified');
    expect(frameMark(index, 'core:a.ts#top')?.kind).toBe('inside');
    expect(frameMark(index, 'core:a.ts#described')?.kind).toBe('docs');
    expect(frameMark(index, 'core:a.ts#unknown')).toBeUndefined();
    expect(frameMark(undefined, 'core:a.ts#leaf')).toBeUndefined();
  });

  it('should mark an endpoint by the frame its trace starts from', () => {
    expect(endpointMark(index, { root: 'endpoint:token' })?.kind).toBe('modified');
  });

  it('should mark a node added or modified by the diff of its frame', () => {
    const change = { marks: { s0: 'added', s1: 'modified' } } as unknown as FrameChange;
    expect(nodeMark(change, 's0')?.label).toBe('追加');
    expect(nodeMark(change, 's1')?.kind).toBe('line');
    expect(nodeMark(change, 's2')).toBeUndefined();
  });

  it('should let a change of the code win over a change below it, and that over the others', () => {
    expect(strongest([markOf('inside'), undefined, markOf('modified'), markOf('docs')])?.kind).toBe('modified');
    expect(strongest([markOf('noted'), markOf('inside')])?.kind).toBe('inside');
  });
});

describe('the changes below a call', () => {
  it('should sum the changes of the frames a call leads to, the implementation of a member it calls among them', () => {
    expect(belowCounts(index, 'core:a.ts#mid')).toEqual({ frames: ['core:a.ts#leaf', 'core:impl.ts#get'], counts: { 'condition~': 1, 'call+': 2 } });
    expect(belowCounts(index, 'endpoint:token').frames).toEqual(['endpoint:token', 'core:a.ts#leaf', 'core:impl.ts#get']);
    expect(countWords({ 'condition~': 1, 'call+': 2, 'exit-': 1 })).toBe('条件 変更 1、呼び出し +2、終わり -1');
  });
});

describe('the list of the changes', () => {
  it('should group the frames by how they changed, in the order of the page', () => {
    expect(groupChanges(data.changes!).map((group) => [group.kind, group.frames.map((frame) => frame.name)])).toEqual([
      ['added', ['get']],
      ['modified', ['leaf', 'token']],
      ['docs', ['described']],
    ]);
  });

  it('should name a body by its endpoint and a function by its call', () => {
    expect(changeName(data, data.changes!.frames[3] as FrameChangeEntry)).toBe('POST /token');
    expect(changeName(data, data.changes!.frames[0] as FrameChangeEntry)).toBe('leaf()');
  });
});

describe('the hunks', () => {
  const hunk = { base: 10, head: 20, lines: [' a', '-b', '+B', '+C', ' d'] };

  it('should number the lines of a hunk in the base and in the head', () => {
    expect(numberHunk(hunk)).toEqual([
      { op: ' ', text: 'a', base: 10, head: 20 },
      { op: '-', text: 'b', base: 11 },
      { op: '+', text: 'B', head: 21 },
      { op: '+', text: 'C', head: 22 },
      { op: ' ', text: 'd', base: 12, head: 23 },
    ]);
    expect(diffStat([hunk])).toEqual({ added: 2, removed: 1 });
  });

  it('should put the hunks of the nodes of a change in the order of their lines', () => {
    const later = { base: 30, head: 40, lines: ['+x'] };
    const change = { hunks: { s1: [later], s0: [hunk] } } as unknown as FrameChange;
    expect(allHunks(change)).toEqual([hunk, later]);
    expect(allHunks(undefined)).toEqual([]);
  });
});

describe('the text of a note', () => {
  it('should read paragraphs with their line breaks, lists with their continued lines, and fenced code', () => {
    const text = ['なぜ変えたか。', '次の文。', '', '- 一つ目', '  続き', '* 二つ目', '', '```ts', 'const a = 1;', '```', '最後。'].join('\n');
    expect(noteBlocks(text)).toEqual([
      { type: 'paragraph', text: 'なぜ変えたか。\n次の文。' },
      { type: 'list', items: ['一つ目 続き', '二つ目'] },
      { type: 'code', text: 'const a = 1;' },
      { type: 'paragraph', text: '最後。' },
    ]);
  });

  it('should split a line into text and code', () => {
    expect(inlineParts('a `b` c')).toEqual([
      { code: false, text: 'a ' },
      { code: true, text: 'b' },
      { code: false, text: ' c' },
    ]);
  });
});
