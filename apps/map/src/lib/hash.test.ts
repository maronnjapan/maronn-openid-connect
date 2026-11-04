import { describe, expect, it } from 'vitest';
import type { FlowEndpoint, FunctionEntry, MapData, OpFlow } from '../types';
import { buildHash, parseHash, parseTrace, traceHash, type View } from './hash';
import { EMPTY_TRACE, type TraceState } from './trace';

const token = { id: 'token', steps: [{ id: 'respond' }], root: 'endpoint:token' } as unknown as FlowEndpoint;
const flow = { endpoints: [token] } as unknown as OpFlow;
function card(id: string, name: string): FunctionEntry {
  const [root, rest] = id.split(':') as [string, string];
  return { id, name, package: root, module: rest.split('#')[0] as string, line: 1, exported: true, kind: 'other', summary: '', calls: [], calledBy: [], sites: [], frame: '' };
}
const data = {
  frameworks: ['hono', 'nextjs'],
  flows: { hono: flow, nextjs: flow },
  functions: {
    'core:b.ts#isForm': card('core:b.ts#isForm', 'isForm'),
    'hono:oidc-provider/x.ts#split': card('hono:oidc-provider/x.ts#split', 'split'),
    'core:y.ts#split': card('core:y.ts#split', 'split'),
  },
} as unknown as MapData;
const defaults: View = { framework: 'hono', endpoint: null, step: null, fn: null, trace: EMPTY_TRACE };

describe('the trace in a hash', () => {
  it('should write the frames opened, each choice, the errors and the focus, and read them back', () => {
    const trace: TraceState = { open: ['s4', 's4.s2t0'], choices: [{ 's4.s1': 'true', s12: 'nullish' }, { s3: 'c1' }], errors: true, focus: 's4' };
    const hash = traceHash(trace);
    expect(hash).toBe('/s4/s4.s2t0;d=s4.s1:true,s12:nullish;d=s3:c1;e;f=s4');
    expect(parseTrace(hash)).toEqual(trace);
    expect(traceHash(EMPTY_TRACE)).toBe('');
  });

  it('should read a side to its end, a colon in it kept, and drop what is not a frame', () => {
    expect(parseTrace("/s1/../x y;d=s0:case 'a:b'")).toEqual({ open: ['s1'], choices: [{ s0: "case 'a:b'" }], errors: false, focus: '' });
  });
});

describe('the view in a hash', () => {
  it('should round-trip an endpoint, a step and the trace of its page', () => {
    const view: View = { framework: 'nextjs', endpoint: 'token', step: 'respond', fn: null, trace: { open: ['s0b1s0'], choices: [{ s0b8s0: 'nullish' }], errors: false, focus: '' } };
    expect(buildHash(view, data)).toBe('nextjs--token--respond/s0b1s0;d=s0b8s0:nullish');
    expect(parseHash('#nextjs--token--respond/s0b1s0;d=s0b8s0:nullish', data, defaults)).toEqual(view);
  });

  it('should round-trip a function by its name, and by its package and module when the name is shared', () => {
    expect(buildHash({ ...defaults, fn: 'core:b.ts#isForm' }, data)).toBe('hono--fn--isForm');
    expect(parseHash('#hono--fn--isForm/s1', data, defaults)).toEqual({ ...defaults, fn: 'core:b.ts#isForm', trace: { ...EMPTY_TRACE, open: ['s1'] } });
    expect(buildHash({ ...defaults, fn: 'hono:oidc-provider/x.ts#split' }, data)).toBe('hono--fn--split--hono--oidc-provider%2Fx.ts');
    expect(parseHash('#hono--fn--split--hono--oidc-provider%2Fx.ts', data, defaults).fn).toBe('hono:oidc-provider/x.ts#split');
  });

  it('should round-trip the page of the changes of the pull request, and read #changes alone', () => {
    const changes = { ...defaults, framework: 'nextjs', changes: true };
    expect(buildHash(changes, data)).toBe('nextjs--changes');
    expect(parseHash('#nextjs--changes', data, defaults)).toEqual(changes);
    expect(parseHash('#changes', data, defaults)).toEqual({ ...defaults, changes: true });
  });

  it('should keep the defaults for a hash that names nothing known', () => {
    expect(parseHash('#nope--token', data, defaults)).toEqual(defaults);
    expect(parseHash('#hono--nope', data, defaults)).toEqual({ ...defaults, framework: 'hono' });
    expect(parseHash('#fn--nope', data, defaults)).toEqual(defaults);
  });
});
