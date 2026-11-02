import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FlowStep, FunctionCard, FunctionChange, FunctionFlowNode, MapChanges, MapData, OpFlow } from '../types';
import {
  changesBelow,
  changesOfStep,
  diffStat,
  endpointMark,
  groupChanges,
  indexChanges,
  inlineParts,
  nodeMark,
  noteBlocks,
  numberHunk,
  stepMark,
  strongest,
  markOf,
  marksCode,
} from './changes';

function card(id: string, calls: string[] = []): FunctionCard {
  const [root, rest] = id.split(':') as [string, string];
  const [module, name] = rest.split('#') as [string, string];
  return { id, name, package: root, module, line: 1, exported: true, kind: 'other', summary: `${name} does it.`, calls, calledBy: [] };
}

function change(id: string, kind: FunctionChange['kind'], extra: Partial<FunctionChange> = {}): FunctionChange {
  const [root, rest] = id.split(':') as [string, string];
  const [module, name] = rest.split('#') as [string, string];
  return { id, name, package: root, module, line: 1, kind, ...extra };
}

function step(id: string, functionId: string | undefined, calls: string[] = []): FlowStep {
  const base: FlowStep = { id, label: id, kind: 'validate', function: id, calls, consumes: [], produces: [], removable: false };
  return functionId === undefined ? base : { ...base, functionId };
}

const steps = {
  own: step('own', 'core:b.ts#leaf'),
  inside: step('inside', 'hono:s.ts#run'),
  callsAdded: step('calls-added', 'hono:t.ts#other'),
  docs: step('docs', 'core:d.ts#documented'),
  block: step('block', undefined, ['core:b.ts#leaf']),
  untouched: step('untouched', 'core:e.ts#plain'),
};
const endpoint: FlowEndpoint = {
  id: 'token', label: 'Token', path: '/token', methods: ['POST'], layer: 'api', group: { id: 'code', label: 'Code' }, rearrangeable: true,
  module: 'token/route.ts', steps: Object.values(steps), edges: [],
};
const quiet: FlowEndpoint = { ...endpoint, id: 'quiet', module: 'quiet/route.ts', steps: [steps.untouched] };
const flow: OpFlow = { version: 2, features: {}, scopes: [], db: null, endpoints: [endpoint, quiet], edges: [] };

const changes: MapChanges = {
  base: { ref: 'origin/main', commit: 'abc1234' },
  head: { commit: 'def5678', dirty: false },
  notes: [],
  functions: [
    change('core:b.ts#leaf', 'modified', { changedLines: [12] }),
    change('core:c.ts#fresh', 'added'),
    change('core:d.ts#documented', 'docs'),
    change('core:z.ts#gone', 'removed'),
    change('nextjs:app/quiet/route.ts#POST', 'docs'),
  ],
  unmatched: [],
  otherFiles: 0,
};

const data: MapData = {
  version: 3, frameworks: ['hono'], commands: [], features: [], flows: { hono: flow }, members: {}, memberOfCall: {}, edgeSets: {}, changes,
  functions: Object.fromEntries(
    [
      card('core:b.ts#leaf'),
      card('core:a.ts#middle', ['core:b.ts#leaf']),
      card('hono:s.ts#run', ['core:a.ts#middle']),
      card('core:c.ts#fresh'),
      card('hono:t.ts#other', ['core:c.ts#fresh']),
      card('core:d.ts#documented'),
      card('core:e.ts#plain', ['core:e.ts#loop']),
      card('core:e.ts#loop', ['core:e.ts#plain']),
    ].map((entry) => [entry.id, entry]),
  ),
};
const index = indexChanges(data);

describe('indexChanges', () => {
  it('should give nothing for a map without changes', () => {
    expect(indexChanges({ ...data, changes: undefined })).toBe(undefined);
  });

  it('should index the changes by id, leaving out the removed functions', () => {
    expect([...(index?.byId.keys() ?? [])]).toEqual(['core:b.ts#leaf', 'core:c.ts#fresh', 'core:d.ts#documented', 'nextjs:app/quiet/route.ts#POST']);
  });

  it('should tell the functions that reach a change of code through what they call, and stop at a cycle', () => {
    expect(['hono:s.ts#run', 'core:a.ts#middle', 'core:b.ts#leaf', 'core:d.ts#documented', 'core:e.ts#plain'].map((id) => index?.reaches(id))).toEqual([true, true, true, false, false]);
  });
});

describe('stepMark', () => {
  it('should mark a step by the change of its own code first, then by what it calls, then by its other changes', () => {
    expect(Object.values(steps).map((entry) => stepMark(index, data, entry)?.label)).toEqual(['変更', '中で変更', '中で変更', '説明', '中で変更', undefined]);
  });

  it('should mark nothing in a map without changes', () => {
    expect(stepMark(undefined, data, steps.own)).toBe(undefined);
  });
});

describe('nodeMark', () => {
  const node = (id: string, line: number, callee?: string): FunctionFlowNode =>
    callee === undefined ? { id, kind: 'return', label: 'return', line } : { id, kind: 'call', label: id, callee, line };
  const modified = index?.byId.get('core:b.ts#leaf');

  it('should mark a box on a line the pull request changed', () => {
    expect(nodeMark(index, modified, node('n1', 12))?.kind).toBe('line');
  });

  it('should mark the start box when a line of the declaration changed', () => {
    const start: FunctionFlowNode = { id: 'n0', kind: 'start', label: 'leaf(a, b)', line: 14 };
    expect(nodeMark(index, modified, start, 10)?.kind).toBe('line');
    expect(nodeMark(index, modified, start, 13)).toBe(undefined);
  });

  it('should mark a call of an added function as added and a call that leads to a change as inside', () => {
    expect(nodeMark(index, modified, node('n2', 3, 'core:c.ts#fresh'))?.kind).toBe('added');
    expect(nodeMark(index, modified, node('n3', 4, 'core:a.ts#middle'))?.kind).toBe('inside');
    expect(nodeMark(index, modified, node('n4', 5, 'core:e.ts#plain'))).toBe(undefined);
  });

  it('should not mark the lines of a function the pull request added', () => {
    expect(nodeMark(index, change('core:c.ts#fresh', 'added', { changedLines: [12] }), node('n1', 12))).toBe(undefined);
  });
});

describe('endpointMark', () => {
  it('should take the strongest badge of the steps of an endpoint', () => {
    expect(endpointMark(index, data, flow, endpoint)?.kind).toBe('modified');
  });

  it('should mark an endpoint whose own file holds a changed function', () => {
    expect(endpointMark(index, data, flow, quiet)?.kind).toBe('docs');
  });
});

describe('marksCode', () => {
  it('should tell the badges of a change of code from the others', () => {
    expect((['added', 'modified', 'line', 'inside', 'moved', 'docs', 'noted', 'removed'] as const).map((kind) => marksCode(markOf(kind)))).toEqual([true, true, true, true, false, false, false, false]);
  });
});

describe('strongest', () => {
  it('should put a change of code before a change below it, and that before the other changes', () => {
    expect(strongest([markOf('docs'), markOf('inside'), undefined])?.kind).toBe('inside');
    expect(strongest([markOf('inside'), markOf('added')])?.kind).toBe('added');
    expect(strongest([undefined])).toBe(undefined);
  });
});

describe('changesBelow', () => {
  it('should find the changes of code below a function, nearest first, with the functions between', () => {
    expect(changesBelow(index, data, ['core:a.ts#middle', 'core:c.ts#fresh']).map((found) => [found.card.id, found.via.map((between) => between.id)])).toEqual([
      ['core:c.ts#fresh', []],
      ['core:b.ts#leaf', ['core:a.ts#middle']],
    ]);
  });

  it('should find what a step calls, from its function or from its block', () => {
    expect(changesOfStep(index, data, steps.inside).map((found) => found.card.id)).toEqual(['core:b.ts#leaf']);
    expect(changesOfStep(index, data, steps.block).map((found) => found.card.id)).toEqual(['core:b.ts#leaf']);
    expect(changesOfStep(index, data, steps.untouched)).toEqual([]);
  });
});

describe('groupChanges', () => {
  it('should group the changes by kind in the order of the page, leaving out the empty groups', () => {
    expect(groupChanges(changes).map((group) => [group.kind, group.functions.map((entry) => entry.id)])).toEqual([
      ['added', ['core:c.ts#fresh']],
      ['modified', ['core:b.ts#leaf']],
      ['docs', ['core:d.ts#documented', 'nextjs:app/quiet/route.ts#POST']],
      ['removed', ['core:z.ts#gone']],
    ]);
  });
});

describe('numberHunk', () => {
  it('should number each line in the base and in the head', () => {
    expect(numberHunk({ base: 10, head: 20, lines: [' a', '-b', '+c', ' d'] })).toEqual([
      { op: ' ', text: 'a', base: 10, head: 20 },
      { op: '-', text: 'b', base: 11 },
      { op: '+', text: 'c', head: 21 },
      { op: ' ', text: 'd', base: 12, head: 22 },
    ]);
  });
});

describe('diffStat', () => {
  it('should count the lines the hunks add and remove', () => {
    expect(diffStat([{ base: 1, head: 1, lines: [' a', '-b', '+c', '+d'] }])).toEqual({ added: 2, removed: 1 });
    expect(diffStat(undefined)).toEqual({ added: 0, removed: 0 });
  });
});

describe('noteBlocks', () => {
  it('should read paragraphs, lists with their continued lines, and fenced code', () => {
    expect(noteBlocks('一文目。\n二文目。\n\n- 一つ目\n  続き\n- 二つ目\n\n```ts\nconst a = 1;\n```\n後ろ。')).toEqual([
      { type: 'paragraph', text: '一文目。\n二文目。' },
      { type: 'list', items: ['一つ目 続き', '二つ目'] },
      { type: 'code', text: 'const a = 1;' },
      { type: 'paragraph', text: '後ろ。' },
    ]);
  });
});

describe('inlineParts', () => {
  it('should split the code between backticks from the text', () => {
    expect(inlineParts('`a()` を呼ぶ')).toEqual([
      { code: true, text: 'a()' },
      { code: false, text: ' を呼ぶ' },
    ]);
  });
});
