import { describe, expect, it } from 'vitest';
import type { MapData } from '@maronn-openid-connect/map-analysis';
import { attachTestFeatures } from '../features.js';
import { entryOf } from '../join.js';
import type { TestCase } from '../model.js';

const PAR = 'experimental:par/par-request.ts#validatePushedRequest';
const data = {
  features: [{ id: 'par' }, { id: 'refresh-token' }],
  functions: { [PAR]: { feature: 'par', calls: [] }, shared: { calls: [PAR] } },
  bodies: {},
  flows: { hono: { endpoints: [
    { id: 'par', feature: 'par', root: 'endpoint:par', steps: [] },
    { id: 'authorize', root: 'endpoint:authorize', steps: [{ id: 'resolve-pushed-request', feature: 'par' }] },
  ] } },
} as unknown as MapData;

function testCase(id: string, extra: Partial<TestCase> = {}): TestCase {
  return { id, kind: 'unit', root: 'core', source: { file: 'packages/core/src/shared.test.ts', lines: [1, 3], form: 'code' }, title: id, path: [], subjects: [], outcome: 'success', aspects: [], spec: [], assertions: [], evidence: [], digest: '', ...extra };
}

describe('attachTestFeatures', () => {
  it('should attribute ownership, direct subjects and annotations while keeping shared authorize and transitive reach unmarked', () => {
    const cases = [
      testCase('owned', { source: { file: 'apps/hono/src/oidc-provider/features/par/store.test.ts', lines: [1, 3], form: 'code' } }),
      testCase('direct', { subjects: [{ kind: 'function', id: PAR, how: 'describe' }] }),
      testCase('request', { kind: 'api', subjects: [{ kind: 'endpoint', id: 'par', source: 'hono', how: 'request' }] }),
      testCase('explicit', { features: ['par', 'unknown', 'refreshToken', 'par'] }),
      testCase('authorize', { kind: 'api', subjects: [{ kind: 'endpoint', id: 'authorize', source: 'hono', how: 'request' }] }),
      testCase('shared', { subjects: [{ kind: 'function', id: 'shared', how: 'describe' }] }),
      testCase('measured', { subjects: [{ kind: 'function', id: PAR, how: 'coverage' }], reach: [{ functions: [PAR] }] }),
      testCase('tool', { kind: 'tool', subjects: [{ kind: 'function', id: PAR, how: 'describe' }] }),
    ];
    attachTestFeatures(cases, data);
    expect(cases.map((test) => test.features)).toEqual([['par'], ['par'], ['par'], ['par', 'refresh-token'], undefined, undefined, undefined, undefined]);
    expect(entryOf(cases[1] as TestCase).features).toEqual(['par']);
  });
});
