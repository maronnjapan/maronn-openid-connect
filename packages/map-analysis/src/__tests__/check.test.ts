import { describe, expect, it } from 'vitest';
import { checkLinks, checkMap } from '../check.js';
import type { FrameFile, MapChanges, MapData, PremisesFile, RootRequests, SourceDocument, StoreAccess, WaySample } from '../model.js';

/** A map of one function whose frame offers some choices by name. */
function mapOf(names: readonly string[]): { data: MapData; frame: FrameFile } {
  const frame: FrameFile = {
    version: 4,
    tree: { id: 'core:a.ts#f', name: 'f', signature: 'f()', file: 'core:a.ts', lines: [1, 3], head: [1, 1], nodes: [{ id: 's0', kind: 'return', lines: [2, 3], code: 'return x' }] },
    selections: names.map((name) => ({ kind: 'exit', name, decisions: {}, target: 's0' })),
  };
  const data = {
    version: 4,
    frameworks: [],
    commands: [],
    features: [],
    flows: {},
    functions: { 'core:a.ts#f': { id: 'core:a.ts#f', name: 'f', package: 'core', module: 'a.ts', line: 1, exported: true, kind: 'other', summary: '', calls: [], calledBy: [], sites: [], frame: 'f.json' } },
    bodies: {},
    members: {},
    sources: {},
  } satisfies MapData;
  return { data, frame };
}

/** A map of one function whose tree ends on a closing line no node holds (the brace that closes the body). */
function mapWithClosingLine(last: number, nodeEnd: number): { data: MapData; frame: FrameFile } {
  const frame: FrameFile = {
    version: 4,
    tree: { id: 'core:a.ts#f', name: 'f', signature: 'f()', file: 'core:a.ts', lines: [1, last], head: [1, 1], nodes: [{ id: 's0', kind: 'return', lines: [2, nodeEnd], code: 'return x' }] },
    selections: [],
  };
  const { data } = mapOf([]);
  return { data, frame };
}

/** The changes of a map whose one frame `core:a.ts#f` was added with these changed lines. */
function changesOf(changedLines: number[]): MapChanges {
  return {
    base: { ref: 'origin/main', commit: 'base' },
    head: { commit: 'head', dirty: false },
    notes: [],
    frames: [{ id: 'core:a.ts#f', name: 'f', package: 'core', module: 'a.ts', line: 1, kind: 'added', summary: ['関数を足した'], counts: {}, changedLines, reach: [] }],
    unmatched: [],
    unknown: [],
    ambiguous: [],
    undocumented: [],
    outside: [],
    otherFiles: 0,
  };
}

/** A request the OP of the map took a way with. */
function sample(): WaySample {
  return { method: 'POST', path: '/token', params: [{ name: 'grant_type', value: 'authorization_code', in: 'form' }], headers: [], status: 200 };
}

describe('checkMap, with the requests the OP of the map took ways with', () => {
  it('should pass ways that are choices of their root, and count them', async () => {
    const { data, frame } = mapOf(['return x']);
    data.requests = { 'core:a.ts#f': 'requests.json' };
    const requests: RootRequests = { version: 3, root: 'core:a.ts#f', source: 'hono', endpoint: 'token', ways: [{ id: 'c1', kind: 'exit', name: 'return x', target: 's0', sample: sample() }] };
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined, async () => requests);
    expect([metrics.requests, failures]).toEqual([{ roots: 1, ways: 1, unmatched: 0 }, []]);
  });

  it('should fail on a way no choice of its root is, and a root with no frame', async () => {
    const { data, frame } = mapOf(['return x']);
    data.requests = { 'core:a.ts#f': 'requests.json', 'core:b.ts#g': 'other.json' };
    const requests: RootRequests = {
      version: 3,
      root: 'core:a.ts#f',
      source: 'hono',
      endpoint: 'token',
      ways: [
        { id: 'c1', kind: 'step', name: 'a step', target: 's0', sample: sample() },
        { id: 'c2', kind: 'exit', name: 'return x', target: 's0', sample: sample() },
      ],
    };
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined, async () => requests);
    expect([metrics.requests.unmatched, failures]).toEqual([
      1,
      [
        'core:a.ts#f: the requests name the way step "a step" (s0), which no ready-made choice of the root is: the flow view would not show them',
        'core:b.ts#g: the requests name a root the map has no frame of',
      ],
    ]);
  });
});

/** Premises made by two requests: a code added by the first and changed by the second, and a client of the configuration. */
function premisesFile(): PremisesFile {
  return {
    version: 1,
    issuer: 'https://op.example.com',
    now: 0,
    steps: [
      { grant: 'g', request: { method: 'POST', url: 'https://op.example.com/consent' }, response: { status: 302 }, wrote: [{ collection: 'codes', key: 'c1', change: 'added', value: {} }] },
      { grant: 'g', request: { method: 'POST', url: 'https://op.example.com/token' }, response: { status: 200 }, wrote: [{ collection: 'codes', key: 'c1', change: 'changed', value: {}, fields: ['used'] }] },
    ],
    records: [
      { collection: 'codes', key: 'c1', value: {}, addedBy: 0, changedBy: [1] },
      { collection: 'clients', key: 'client-1', value: {} },
    ],
  };
}

/** The requests of a root whose one way's sample read what is given. */
function requestsReading(read: StoreAccess['read']): RootRequests {
  return { version: 3, root: 'core:a.ts#f', source: 'hono', endpoint: 'token', ways: [{ id: 'c1', kind: 'exit', name: 'return x', target: 's0', sample: { ...sample(), store: { read, wrote: [] } } }] };
}

describe('checkMap, with the premises of the OP of the map', () => {
  it('should pass premises whose records were written by the requests they name, and samples that read what they hold', async () => {
    const { data, frame } = mapOf(['return x']);
    data.requests = { 'core:a.ts#f': 'requests.json' };
    data.premises = 'premises.json';
    const requests = requestsReading([
      { collection: 'clients', key: 'client-1', found: true },
      { collection: 'codes', key: 'c1', found: true },
      { collection: 'codes', key: 'c9', found: false },
      { collection: 'accessTokens', found: false },
    ]);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined, async () => requests, async () => premisesFile());
    expect([metrics.premises, failures]).toEqual([{ steps: 2, records: 2, made: 1, reads: 3, unmatched: 0 }, []]);
  });

  it('should read a lookup inside a record that is a Map (a consent to a client) against the members of the record', async () => {
    const { data, frame } = mapOf(['return x']);
    data.requests = { 'core:a.ts#f': 'requests.json' };
    data.premises = 'premises.json';
    const premises = premisesFile();
    premises.records.push({ collection: 'consentScopes', key: 'testuser', value: { 'client-1': ['openid'] }, addedBy: 0 });
    premises.steps[0]?.wrote.push({ collection: 'consentScopes', key: 'testuser', change: 'added', value: { 'client-1': ['openid'] } });
    const requests = requestsReading([
      { collection: 'consentScopes', key: 'testuser', member: 'client-1', found: true },
      { collection: 'consentScopes', key: 'testuser', member: 'client-2', found: false },
      { collection: 'consentScopes', key: 'testuser', member: 'client-9', found: true },
    ]);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined, async () => requests, async () => premises);
    expect([metrics.premises.unmatched, failures]).toEqual([1, ['core:a.ts#f: the sample of "return x" found consentScopes testuser client-9, which the premises do not hold: it was not run on the premises the page hands to its OP']]);
  });

  it('should fail on a record that names a request that did not write it, and on a sample that read records the premises disagree with', async () => {
    const { data, frame } = mapOf(['return x']);
    data.requests = { 'core:a.ts#f': 'requests.json' };
    data.premises = 'premises.json';
    const premises = premisesFile();
    premises.records[0] = { collection: 'codes', key: 'c1', value: {}, addedBy: 1 };
    const requests = requestsReading([
      { collection: 'codes', key: 'c2', found: true },
      { collection: 'clients', key: 'client-1', found: false },
    ]);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined, async () => requests, async () => premises);
    expect([metrics.premises.unmatched, failures]).toEqual([
      2,
      [
        'premises: the record codes c1 says request 1 added it, which that request did not',
        'core:a.ts#f: the sample of "return x" found codes c2, which the premises do not hold: it was not run on the premises the page hands to its OP',
        'core:a.ts#f: the sample of "return x" did not find clients client-1, which the premises hold: it was not run on the premises the page hands to its OP',
      ],
    ]);
  });
});

describe('checkMap', () => {
  it('should reject feature labels with an unknown flag or a range outside the source', async () => {
    const { data, frame } = mapOf([]);
    data.sources['core:a.ts'] = { path: 'packages/core/src/a.ts', url: 'a.json', features: [{ feature: 'unknown', lines: [1, 9] }] };
    expect((await checkMap(data, async () => frame, async () => 'function f() {}')).failures).toEqual([
      'core:a.ts: source range names unknown feature unknown',
      'core:a.ts: feature unknown has invalid source lines',
    ]);
  });

  it('should count two choices told apart by a number only as one name repeated', async () => {
    const { data, frame } = mapOf(['例外が起きたとき → return null', '例外が起きたとき → return null (2)']);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect(metrics.duplicateNames).toEqual([{ frame: 'core:a.ts#f', name: '例外が起きたとき → return null' }]);
    expect(failures).toEqual(['core:a.ts#f: two choices are named "例外が起きたとき → return null"']);
  });

  it('should pass choices with names of their own', async () => {
    const { data, frame } = mapOf(['`decode()` で例外が起きたとき', '`split()` で例外が起きたとき']);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect([metrics.duplicateNames, failures]).toEqual([[], []]);
  });

  it('should retain a reason for unresolved wiring and require evidence before claiming an endpoint destination', async () => {
    const { data, frame } = mapOf([]);
    data.flows['hono'] = { endpoints: [{ id: 'example' }] } as unknown as MapData['flows'][string];
    data.wiring = [
      { id: 'unknown', file: 'core:a.ts', lines: [2, 2], kind: 'callback', code: 'register(callback)', status: 'untraceable', why: 'The registration target is dynamic' },
      { id: 'known', file: 'core:a.ts', lines: [2, 2], kind: 'callback', code: 'items.map(callback)', status: 'resolved', target: 'core:a.ts#f', destinations: ['hono:example'] },
    ];
    const result = await checkMap(data, async () => frame, async () => undefined);
    expect(result.failures).toEqual([]);
    expect(result.metrics.wiring).toEqual({ entries: 2, untraceable: 1, invalid: 0 });
  });

  it('should reject unresolved wiring whose reason or source was silently dropped', async () => {
    const { data, frame } = mapOf([]);
    data.wiring = [{ id: 'lost', file: '', lines: [0, -1], kind: 'initialization', code: 'build()', status: 'untraceable', why: ' ' }];
    const result = await checkMap(data, async () => frame, async () => undefined);
    expect(result.failures).toEqual([
      'lost: wiring has no source file',
      'lost: wiring has invalid source lines',
      'lost: wiring is untraceable but has no reason',
    ]);
    expect(result.metrics.wiring.invalid).toBe(1);
  });

  it('should reject a resolved wiring claim without target and destination evidence', async () => {
    const { data, frame } = mapOf([]);
    data.wiring = [{ id: 'invented', file: 'core:a.ts', lines: [2, 2], kind: 'middleware', code: 'app.use(middleware)', status: 'resolved' }];
    expect((await checkMap(data, async () => frame, async () => undefined)).failures).toEqual([
      'invented: wiring claims a destination but has no target',
      'invented: wiring claims a destination but names no endpoints',
    ]);
  });

  it('should reject names that do not refer to emitted target or endpoint evidence', async () => {
    const { data, frame } = mapOf([]);
    data.wiring = [{ id: 'invented', file: 'core:a.ts', lines: [2, 2], kind: 'callback', code: 'register(callback)', status: 'resolved', target: 'core:missing.ts#callback', destinations: ['hono:missing'] }];
    expect((await checkMap(data, async () => frame, async () => undefined)).failures).toEqual([
      'invented: wiring claims a target absent from the map',
      'invented: wiring claims an endpoint absent from the map',
    ]);
  });

  it('should reject missing reasons in unresolved call nodes nested in callbacks and branches', async () => {
    const { data, frame } = mapOf([]);
    frame.tree.nodes[0]!.pre = [{
      id: 's0i0', kind: 'loop', lines: [2, 2], code: 'register(…)',
      branches: [{ key: 'callback', label: 'Later', nodes: [{ id: 's0i0b0', kind: 'call', lines: [2, 2], code: 'callback()', target: { kind: 'untraceable', why: '' } }] }],
    }];
    expect((await checkMap(data, async () => frame, async () => undefined)).failures).toEqual(['core:a.ts#f:s0i0b0: an untraceable call has no reason']);
  });

  it('should not count the closing line of an added function as a changed line in no node', async () => {
    const { data, frame } = mapWithClosingLine(3, 2);
    data.changes = changesOf([1, 2, 3]);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect([metrics.changedOutside, failures]).toEqual([[], []]);
  });

  it('should fail on a change whose related tests the pull request did not touch, naming the reason line that lets it pass', async () => {
    const { data, frame } = mapOf([]);
    data.changes = { ...changesOf([]), untested: ['core:a.ts#f'] };
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect(metrics.untested).toEqual(['core:a.ts#f']);
    expect(failures).toEqual([
      'f() (core a.ts) changed and reaches an endpoint, but this pull request adds or changes none of its related tests: change a test that names or reaches it, or write why the tests stay as they are on a line `テストを変えない理由: …` in its section of apps/map/changes/*.md',
    ]);
  });

  it('should count a changed line between the last node and the closing line as outside every node', async () => {
    const { data, frame } = mapWithClosingLine(4, 2);
    data.changes = changesOf([3]);
    const { metrics, failures } = await checkMap(data, async () => frame, async () => undefined);
    expect(metrics.changedOutside).toEqual([{ frame: 'core:a.ts#f', lines: [3] }]);
    expect(failures).toEqual(['core:a.ts#f: changed lines 3 are in no node']);
  });
});

describe('the check of the links of the code', () => {
  /** A source document of some code with links. */
  const documentOf = (code: string, links?: SourceDocument['links']): SourceDocument => ({ code, foreground: '', background: '', tokens: [], ...(links === undefined ? {} : { links }) });

  it('should pass links that sit on names and go to declarations of the files', () => {
    const documents = new Map([
      ['lib:b.ts', documentOf('export function double() {}\n')],
      ['lib:a.ts', documentOf("import { double } from './b';\n", { targets: [{ file: 'lib:b.ts', line: 1, column: 16, name: 'double', kind: 'function' }, { file: 'lib:b.ts', line: 1, column: 0, name: 'b.ts', kind: 'module' }], refs: [1, 9, 6, 0, 1, 23, 5, 1] })],
    ]);
    expect(checkLinks(documents)).toEqual({ links: 2, broken: [] });
  });

  it('should fail a link to a file the map has no source of, a declaration not where it says, and a link beside its name', () => {
    const documents = new Map([
      ['lib:b.ts', documentOf('export function double() {}\n')],
      ['lib:a.ts', documentOf('double(1);\n', { targets: [{ file: 'lib:c.ts', line: 1, column: 0, name: 'triple', kind: 'function' }, { file: 'lib:b.ts', line: 1, column: 0, name: 'double', kind: 'function' }], refs: [1, 0, 6, 1, 1, 6, 3, 1] })],
    ]);
    expect(checkLinks(documents).broken).toEqual([
      'lib:a.ts: triple goes to lib:c.ts, which the map has no source of',
      'lib:a.ts: double is not at lib:b.ts:1:0',
      'lib:a.ts:1:6: the link of 3 characters is on "(1)", not a name',
    ]);
  });
});
