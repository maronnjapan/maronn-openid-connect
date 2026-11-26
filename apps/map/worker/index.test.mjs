/**
 * The Worker and the Durable Object of a workspace (index.ts), on a state
 * like a Durable Object's in memory (its storage and its alarm): a request
 * the playground refuses (refusalOf) reaches no Durable Object, a workspace
 * whose storage holds what this build cannot make again still answers and
 * says so, and only a request the workspace answered moves its alarm on,
 * so a workspace that cannot be opened is left to be deleted. It reads the
 * built live OP (packages/live-op/dist).
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

// index.ts imports the Workers runtime, which Node does not have (a DurableObject that keeps its state and env is
// enough here), and its sibling by the name it is bundled to (./storage.js for storage.ts).
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
  }
  if (specifier === './storage.js' && context.parentURL?.endsWith('/worker/index.ts')) return next('./storage.ts', context);
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { default: worker, LiveOpWorkspace } = await import('./index.ts');
const { EXCHANGE_HEADER, LIVE_PREFIX, REQUEST_BODY_LIMIT, WORKSPACE_HEADER } = await import('@maronn-openid-connect/live-op');
const { SNAPSHOT_KEY } = await import('./storage.ts');

/** The origin the requests are sent to. */
const ORIGIN = 'https://map.example.com';

/** How long a workspace is kept after its last request (index.ts IDLE_LIFETIME). */
const IDLE_LIFETIME = 7 * 24 * 60 * 60 * 1000;

/** The state of a Durable Object in memory: its storage (that refuses every write when told to) and its alarm. */
function durableState({ refuseWrites = false } = {}) {
  const held = new Map();
  let alarm = null;
  return {
    held,
    alarm: () => alarm,
    storage: {
      async get(keys) {
        return new Map(keys.filter((key) => held.has(key)).map((key) => [key, structuredClone(held.get(key))]));
      },
      async put(entries) {
        if (refuseWrites) throw new Error('The storage refused the write.');
        for (const [key, value] of Object.entries(entries)) held.set(key, structuredClone(value));
      },
      async delete(keys) {
        return keys.filter((key) => held.delete(key)).length;
      },
      async deleteAll() {
        held.clear();
      },
      async getAlarm() {
        return alarm;
      },
      async setAlarm(time) {
        alarm = Number(time);
      },
      async deleteAlarm() {
        alarm = null;
      },
    },
  };
}

/** A request of the reader's page to a path of the origin, naming its workspace. */
function request(path, init = {}) {
  return new Request(new URL(path, ORIGIN), { ...init, headers: { [WORKSPACE_HEADER]: 'reader', ...init.headers } });
}

describe('LiveOpWorkspace', () => {
  it('should answer a request on the workspace and move its alarm on', async () => {
    const state = durableState();
    const before = Date.now();
    const response = await new LiveOpWorkspace(state, {}).fetch(request('/.well-known/openid-configuration'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(EXCHANGE_HEADER), 'x1');
    assert.ok(state.alarm() >= before + IDLE_LIFETIME);
  });

  it('should not move the alarm for a request it could not answer, so the workspace is left to be deleted', async () => {
    const state = durableState({ refuseWrites: true });
    const response = await new LiveOpWorkspace(state, {}).fetch(request('/.well-known/openid-configuration'));
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error, 'server_error');
    assert.equal(state.alarm(), null);
  });

  it('should answer and reset a workspace whose storage holds what this build cannot make again, saying so', async () => {
    const state = durableState();
    await new LiveOpWorkspace(state, {}).fetch(request('/.well-known/openid-configuration'));
    // What an older build kept: a write of a store this one does not have.
    const count = state.held.get(SNAPSHOT_KEY);
    const snapshot = JSON.parse(Array.from({ length: count }, (_, index) => state.held.get(`${SNAPSHOT_KEY}#${index}`)).join(''));
    snapshot.featureWrites.push({ store: 'oldStore', method: 'save', at: Date.now(), args: [] });
    const text = JSON.stringify(snapshot);
    state.held.set(SNAPSHOT_KEY, 1);
    state.held.set(`${SNAPSHOT_KEY}#0`, text);
    for (let index = 1; index < count; index += 1) state.held.delete(`${SNAPSHOT_KEY}#${index}`);
    const woken = new LiveOpWorkspace(state, {});
    const status = await woken.fetch(request(`${LIVE_PREFIX}state`));
    const reset = await woken.fetch(request(`${LIVE_PREFIX}reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(status.status, 200);
    assert.match((await status.json()).notice, /^保存していた状態を読めなかったので、ワークスペースを作り直しました/);
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).notice, undefined);
  });
});

describe('the Worker', () => {
  /** The bindings of the Worker, with a Durable Object namespace that fails the test when it is used. */
  const env = {
    ASSETS: { fetch: async () => new Response('the page') },
    LIVE_OP: {
      idFromName: () => assert.fail('A refused request reached a Durable Object.'),
      get: () => assert.fail('A refused request reached a Durable Object.'),
    },
  };

  it('should refuse what the playground refuses before it reaches a Durable Object', async () => {
    const refused = [
      request('/par', { method: 'POST', headers: { 'content-length': String(REQUEST_BODY_LIMIT + 1) }, body: 'a'.repeat(REQUEST_BODY_LIMIT + 1) }),
      request(`/authorize?state=${'s'.repeat(16 * 1024)}`),
      request(`${LIVE_PREFIX}reset`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }),
      request(`${LIVE_PREFIX}reset`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' }),
      request(`${LIVE_PREFIX}state`, { headers: { [WORKSPACE_HEADER]: 'not a workspace' } }),
    ];
    const statuses = [];
    for (const refusal of refused) statuses.push((await worker.fetch(refusal, env)).status);
    assert.deepEqual(statuses, [413, 413, 415, 403, 400]);
    assert.equal(await (await worker.fetch(new Request(`${ORIGIN}/code/`), env)).text(), 'the page');
  });
});
