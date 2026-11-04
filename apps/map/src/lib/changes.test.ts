import { describe, expect, it } from 'vitest';
import type { FrameChange, FrameChangeEntry, MapData, Reach } from '../types';
import { allHunks, belowCounts, callsBelow, catchWords, changeName, countWords, diffStat, endpointMark, failureCatchers, frameMark, groupChanges, heldMarks, hunksWithin, indexChanges, inlineParts, markOf, memberChanges, narrowing, nodeMark, noteBlocks, numberHunk, startWords, strongest, wayGroups, wayLabel, waySelections } from './changes';

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

describe('the badges of a row and of its box', () => {
  const change = { marks: { s0: 'added' } } as unknown as FrameChange;

  it('should give a row the strongest badge of its own nodes and of what its calls reach, as a box gets', () => {
    expect(heldMarks(index, change, ['s0', 's1'], ['core:a.ts#mid']).mark?.kind).toBe('added');
    expect(heldMarks(index, change, ['s1'], ['core:a.ts#leaf']).mark?.kind).toBe('modified');
    expect(heldMarks(index, change, ['s1'], ['core:a.ts#top']).mark?.kind).toBe('inside');
    expect(heldMarks(index, change, ['s1'], ['core:a.ts#described'])).toEqual({ mark: markOf('docs'), calls: markOf('docs') });
  });

  it('should give a call of a member the badge of the changes its implementations lead to', () => {
    expect(frameMark(index, 'core:store.ts#Store.get')?.kind).toBe('inside');
    expect(belowCounts(index, 'core:store.ts#Store.get')).toEqual({ frames: ['core:impl.ts#get'], counts: { 'call+': 2 } });
  });

  it('should sum the changes below several calls, each changed frame once', () => {
    expect(callsBelow(index, ['core:a.ts#mid', 'core:a.ts#leaf', 'core:store.ts#Store.get'])).toEqual({ frames: ['core:a.ts#leaf', 'core:impl.ts#get'], counts: { 'condition~': 1, 'call+': 2 } });
  });
});

describe('the implementations an app root has', () => {
  const twins = {
    ...data,
    changes: { ...data.changes, frames: [entry('hono:impl.ts#get', 'get', 'modified', { counts: { 'call+': 1 }, members: ['core:store.ts#Store.get'] }), entry('nextjs:impl.ts#get', 'get', 'modified', { counts: { 'call~': 1 }, members: ['core:store.ts#Store.get'] })] },
  } as unknown as MapData;

  it('should reach the implementation of the source shown alone, and both without a source', () => {
    expect([...(indexChanges(twins, 'hono')?.reach.below('core:a.ts#mid') ?? [])]).toEqual(['hono:impl.ts#get']);
    expect([...(indexChanges(twins, 'nextjs')?.reach.below('core:a.ts#mid') ?? [])]).toEqual(['nextjs:impl.ts#get']);
    expect(indexChanges(twins)?.reach.below('core:a.ts#mid').size).toBe(2);
  });

  it('should name the members implemented on the way to each changed frame below a member', () => {
    expect(memberChanges(indexChanges(twins, 'hono'), 'core:store.ts#Store.get')).toEqual([{ id: 'hono:impl.ts#get', members: ['core:store.ts#Store.get'] }]);
  });
});

describe('the changes below a call of a member', () => {
  // A store whose consume and get both changed, and a resolver whose revoke calls the store's consume.
  const stores = {
    functions: {
      'core:a.ts#read': { id: 'core:a.ts#read', name: 'read', sites: [['s0', 'core:store.ts#Store.get']], frame: 'f1' },
      'core:a.ts#revoke': { id: 'core:a.ts#revoke', name: 'revoke', sites: [['s0', 'core:resolver.ts#Resolver.revoke'], ['s1', 'core:a.ts#read']], frame: 'f2' },
      'hono:stores.ts#createStores': { id: 'hono:stores.ts#createStores', name: 'createStores', sites: [], frame: 'f3' },
      'hono:resolvers.ts#createResolvers': { id: 'hono:resolvers.ts#createResolvers', name: 'createResolvers', sites: [], frame: 'f4' },
    },
    bodies: {},
    members: {
      'core:store.ts#Store.get': { id: 'core:store.ts#Store.get', implementedBy: ['hono:stores.ts#createStores'] },
      'core:store.ts#Store.consume': { id: 'core:store.ts#Store.consume', implementedBy: ['hono:stores.ts#createStores'] },
      'core:resolver.ts#Resolver.revoke': { id: 'core:resolver.ts#Resolver.revoke', implementedBy: ['hono:resolvers.ts#createResolvers'], calls: ['core:store.ts#Store.consume'] },
    },
    changes: {
      ...data.changes,
      frames: [
        entry('hono:stores.ts#createStores', 'createStores', 'modified', {
          counts: { 'action~': 2 },
          members: ['core:store.ts#Store.consume', 'core:store.ts#Store.get'],
          memberCounts: { 'core:store.ts#Store.consume': { 'action~': 1 }, 'core:store.ts#Store.get': { 'action~': 1 } },
        }),
      ],
    },
  } as unknown as MapData;
  const reach = indexChanges(stores, 'hono');

  it('should count only the changes inside the implementation of the member called', () => {
    expect(belowCounts(reach, 'core:store.ts#Store.get')).toEqual({ frames: ['hono:stores.ts#createStores'], counts: { 'action~': 1 } });
    expect(belowCounts(reach, 'core:resolver.ts#Resolver.revoke')).toEqual({ frames: ['hono:stores.ts#createStores'], counts: { 'action~': 1 } });
    expect(memberChanges(reach, 'core:resolver.ts#Resolver.revoke')).toEqual([{ id: 'hono:stores.ts#createStores', members: ['core:store.ts#Store.consume'] }]);
  });

  it('should count the members of every way to an implementation, each once', () => {
    expect(belowCounts(reach, 'core:a.ts#revoke')).toEqual({ frames: ['hono:stores.ts#createStores'], counts: { 'action~': 2 } });
    expect(callsBelow(reach, ['core:store.ts#Store.get', 'core:store.ts#Store.get'])).toEqual({ frames: ['hono:stores.ts#createStores'], counts: { 'action~': 1 } });
  });

  it('should count every change of an implementer reached whole by a call of it', () => {
    expect(callsBelow(reach, ['core:store.ts#Store.get', 'hono:stores.ts#createStores']).counts).toEqual({ 'action~': 2 });
  });
});

describe('the ways to a change', () => {
  const way = (extra: Partial<Reach>): Reach => ({ source: 'hono', frameworks: ['hono', 'express'], endpoint: 'token', frames: ['s1'], decisions: {}, via: ['core:a.ts#sign'], features: [], target: 's1.s3t0', ...extra });
  const signed = entry('core:a.ts#sign', 'sign', 'modified', {
    summary: ['処理 `a`: `hash` を足した', '処理 `b`: `hash` を足した'],
    reach: [
      way({ step: 'issue', decisions: { 's1.s3': 'true' }, label: 'RSA: `hash` を足した' }),
      way({ step: 'issue', decisions: { 's1.s3': 'false', 's1.s3e0': 'true' }, target: 's1.s3e0t2', label: 'ECDSA: `hash` を足した' }),
      way({ step: 'device', frames: ['s2'], decisions: { 's2.s3': 'true' }, target: 's2.s3t0', features: ['device-authorization-grant'], label: 'RSA: `hash` を足した' }),
      way({ endpoint: 'userinfo', label: 'RSA: `hash` を足した' }),
    ],
  });
  const signData = {
    ...data,
    flows: { hono: { endpoints: [{ id: 'token', steps: [{ id: 'issue', label: 'ID トークンを発行する' }, { id: 'device', label: 'device_code を引き換える', feature: 'deviceAuthorizationGrant' }] }] } },
    changes: { ...data.changes, frames: [signed] },
  } as unknown as MapData;
  const signIndex = indexChanges(signData);

  it('should offer one choice per change a way leads to, noted by that change and named by the label of its step', () => {
    expect(waySelections(signData, signIndex, 'hono', 'token', new Set()).map((selection) => [selection.name, selection.note, selection.target])).toEqual([
      ['sign()（ID トークンを発行する から）', 'RSA: `hash` を足した', 's1.s3t0'],
      ['sign()（ID トークンを発行する から）', 'ECDSA: `hash` を足した', 's1.s3e0t2'],
    ]);
  });

  it('should name a step of a feature by its label and offer its way only while the feature is on', () => {
    expect(waySelections(signData, signIndex, 'hono', 'token', new Set(['device-authorization-grant'])).map((selection) => selection.name)).toContain('sign()（device_code を引き換える から）');
    expect(waySelections(signData, signIndex, 'nextjs', 'token', new Set())).toEqual([]);
  });

  it('should make one choice of the ways to two changes that choose the same sides, noting both', () => {
    const same = { ...signData, changes: { ...signData.changes, frames: [{ ...signed, reach: [way({ label: 'a を変えた' }), way({ target: 's1.s4', label: 'b を変えた' })] }] } } as unknown as MapData;
    expect(waySelections(same, indexChanges(same), 'hono', 'token', new Set()).map((selection) => selection.note)).toEqual(['a を変えた / b を変えた']);
  });

  it('should note a way to a frame changed in one place by its diff, and one that reaches every change by the diff in a phrase', () => {
    const once = { ...signData, changes: { ...signData.changes, frames: [{ ...signed, summary: ['処理 `a`: `hash` を足した'], reach: [way({})] }] } } as unknown as MapData;
    expect(waySelections(once, indexChanges(once), 'hono', 'token', new Set())[0]?.note).toBe('処理 `a`: `hash` を足した');
    const through = { ...signData, changes: { ...signData.changes, frames: [{ ...signed, reach: [way({ through: ['core:i.ts#Issuer.issue'] })] }] } } as unknown as MapData;
    expect(waySelections(through, indexChanges(through), 'hono', 'token', new Set())[0]?.note).toBe('処理 `a`: `hash` を足した ほか 1 個');
  });

  it('should group the ways by the change each leads to, in the order they first appear', () => {
    expect(wayGroups(signed.reach).map((group) => [group.label, group.ways.length])).toEqual([
      ['RSA: `hash` を足した', 3],
      ['ECDSA: `hash` を足した', 1],
    ]);
    expect(wayGroups([way({})])).toEqual([{ ways: [way({})] }]);
  });

  it('should say where a new failure is caught on a way, or that it leaves the endpoint', () => {
    expect(catchWords({ caught: { frame: 'endpoint:token', name: 'POST /token', node: 's0', call: 'respondTokenError(…)' } })).toBe('新しい失敗は POST /token の catch で捕まえ、`respondTokenError(…)` が応答する');
    expect(catchWords({ caught: { frame: 'core:p.ts#run', name: 'run', node: 's0' } })).toBe('新しい失敗は run() の catch で捕まえる');
    expect(catchWords({ escapes: true })).toBe('新しい失敗はどこでも捕まえずにエンドポイントの外へ出る');
    expect(catchWords({})).toBeUndefined();
  });

  it('should gather the catchers of a new failure over the ways of a framework, each endpoint once', () => {
    const failing = {
      reach: [
        way({ caught: { frame: 'endpoint:token', name: 'POST /token', node: 's0', call: 'respondTokenError(…)' } }),
        way({ caught: { frame: 'endpoint:token', name: 'POST /token', node: 's0', call: 'respondTokenError(…)' }, target: 's1.s9' }),
        way({ endpoint: 'par', caught: { frame: 'core:p.ts#run', name: 'run', node: 's0' } }),
        way({ endpoint: 'userinfo', escapes: true }),
        way({ source: 'nextjs', frameworks: ['nextjs'], caught: { frame: 'nextjs:t.ts#token', name: 'token', node: 's2', call: 'oauthError(…)' } }),
      ],
    };
    expect(failureCatchers(failing, 'hono')).toEqual([
      { kind: 'answer', by: 'respondTokenError(…)', endpoints: [{ endpoint: 'token', source: 'hono' }] },
      { kind: 'frame', by: 'run()', endpoints: [{ endpoint: 'par', source: 'hono' }] },
      { kind: 'escape', endpoints: [{ endpoint: 'userinfo', source: 'hono' }] },
    ]);
    expect(failureCatchers(failing).map((catcher) => catcher.by)).toEqual(['respondTokenError(…)', 'run()', undefined, 'oauthError(…)']);
  });
});

describe('the parts of a diff', () => {
  it('should say what changed at the start of a frame, and nothing when it did not', () => {
    const change = { marks: { '': 'modified', s0: 'added' }, summary: ['宣言を `f(a)` から `f(a, b)` に変えた', '`if (b)` を足した'] } as unknown as FrameChange;
    expect(startWords(change)).toEqual(['宣言を `f(a)` から `f(a, b)` に変えた']);
    expect(startWords({ ...change, marks: { s0: 'added' } })).toEqual([]);
  });

  it('should keep the hunks that touch some lines of the head', () => {
    const early = { base: 1, head: 1, lines: [' a', '+b'] };
    const late = { base: 20, head: 21, lines: ['-c', '+d', ' e'] };
    expect(hunksWithin([early, late], [[22, 30]])).toEqual([late]);
    expect(hunksWithin([early, late], [[3, 20]])).toEqual([]);
  });
});

describe('the ways and the headings on the page of the changes', () => {
  const withMembers = { ...data, members: { 'core:store.ts#Store.get': { id: 'core:store.ts#Store.get', type: 'Store', member: 'get' } } } as unknown as MapData;

  it('should name a way by the functions it goes through, then the changed function', () => {
    expect(wayLabel(withMembers, data.changes!.frames[0] as FrameChangeEntry, { via: ['core:a.ts#top', 'core:a.ts#mid', 'core:a.ts#leaf'], target: 's1.s0.s0' })).toEqual(['top', 'mid', 'leaf()']);
  });

  it('should name a way that ends at a call of a member by every function on it, the member, then the implementation with its root', () => {
    expect(wayLabel(withMembers, data.changes!.frames[1] as FrameChangeEntry, { via: ['core:a.ts#top', 'core:a.ts#mid'], target: 's1.s0.s1' })).toEqual(['top', 'mid', 'Store.get', 'get()（core）']);
  });

  it('should narrow a bare heading by the roots only when they tell the matches apart, and always by the ids', () => {
    expect(narrowing('createProviderStores', ['hono:db/kv/stores.ts#createProviderStores', 'hono:db/memory/stores.ts#createProviderStores'])).toEqual({ roots: [], ids: ['hono:db/kv/stores.ts#createProviderStores', 'hono:db/memory/stores.ts#createProviderStores'] });
    expect(narrowing('verify', ['core:a.ts#verify', 'hono:b.ts#verify']).roots).toEqual(['core:verify', 'hono:verify']);
  });
});
