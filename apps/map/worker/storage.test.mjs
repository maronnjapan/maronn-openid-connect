/**
 * How the Durable Object of a workspace keeps it (storage.ts): values read
 * back as they were given, a value larger than one value of the storage
 * cut into parts, only the parts of a snapshot that changed written again,
 * and an exchange removed with every part. The storage is a Map that
 * refuses what a Durable Object's refuses: a value past 2 MB, a call with
 * more than 128 keys.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DurableStorage, exchangeKey, freeze, PART_LENGTH, partsOf, SNAPSHOT_KEY, thaw } from './storage.ts';

/** The most bytes a Durable Object keeps a value (SQLite-backed). */
const VALUE_LIMIT = 2 * 1024 * 1024;

/** A storage like a Durable Object's in memory, counting the keys written. */
function memoryStorage() {
  const held = new Map();
  const written = [];
  /** Refuse a call with more keys than a Durable Object's storage takes. */
  const checkKeys = (keys) => {
    if (keys.length > 128) throw new Error(`${keys.length} keys in one call`);
  };
  return {
    held,
    written,
    async get(keys) {
      checkKeys(keys);
      return new Map(keys.filter((key) => held.has(key)).map((key) => [key, structuredClone(held.get(key))]));
    },
    async put(entries) {
      checkKeys(Object.keys(entries));
      for (const [key, value] of Object.entries(entries)) {
        const bytes = typeof value === 'string' ? value.length * 2 : 8;
        if (bytes > VALUE_LIMIT) throw new Error(`${key} is ${bytes} bytes`);
        held.set(key, structuredClone(value));
        written.push(key);
      }
    },
    async delete(keys) {
      checkKeys(keys);
      return keys.filter((key) => held.delete(key)).length;
    },
  };
}

/** A snapshot of a workspace whose database holds some text. */
function snapshotWith(text) {
  return {
    version: 1,
    id: 't1',
    issuer: 'http://127.0.0.1:8787',
    createdAt: 1,
    clockOffset: 0,
    signingKey: { kty: 'RSA', kid: 'k1' },
    database: { $map: [['codes', { $map: [['c1', { note: text }]] }]] },
    featureWrites: [{ store: 'par', method: 'save', at: 5, args: [{ requestUri: 'urn:x', expiresAt: new Date(9), extra: undefined }] }],
    exchanges: [{ id: 'x1', source: 'http', at: 2, method: 'GET', path: '/token' }],
    counter: 1,
    provenance: {},
  };
}

describe('freeze / thaw', () => {
  it('should read back Dates, Maps, Sets, undefined and numbers JSON has no form for', () => {
    const value = {
      at: new Date(1700000000000),
      consents: new Map([['testuser', new Map([['client-1', new Set(['openid', 'profile'])]])]]),
      list: [1, undefined, null, 'a'],
      missing: undefined,
      odd: [Number.NaN, Number.POSITIVE_INFINITY, 10n],
      '~': 'a member named as the tag',
      nested: { '~': { '~': 1 } },
    };
    assert.deepEqual(thaw(JSON.parse(JSON.stringify(freeze(value)))), value);
  });

  it('should keep the tags of the OP database codec as plain data', () => {
    const database = { $map: [['codes', { $map: [] }]], at: { $date: 5 } };
    assert.deepEqual(thaw(JSON.parse(JSON.stringify(freeze(database)))), database);
  });
});

describe('DurableStorage snapshot', () => {
  it('should read back a snapshot it kept, none before', async () => {
    const storage = memoryStorage();
    assert.equal(await new DurableStorage(storage).load(), undefined);
    await new DurableStorage(storage).save(snapshotWith('small'));
    assert.deepEqual(await new DurableStorage(storage).load(), snapshotWith('small'));
  });

  it('should cut a snapshot larger than a value of the storage into parts and remove the parts it no longer needs', async () => {
    const storage = memoryStorage();
    const durable = new DurableStorage(storage);
    await durable.load();
    const large = snapshotWith('あ'.repeat(PART_LENGTH * 2));
    await durable.save(large);
    assert.equal(storage.held.get(SNAPSHOT_KEY), partsOf(large).length);
    assert.ok(partsOf(large).length >= 3);
    assert.deepEqual(await new DurableStorage(storage).load(), large);
    await durable.save(snapshotWith('small'));
    assert.deepEqual([...storage.held.keys()].sort(), [SNAPSHOT_KEY, `${SNAPSHOT_KEY}#0`]);
    assert.deepEqual(await new DurableStorage(storage).load(), snapshotWith('small'));
  });

  it('should write again only the parts of a snapshot that changed', async () => {
    const storage = memoryStorage();
    const durable = new DurableStorage(storage);
    await durable.load();
    const snapshot = snapshotWith('a'.repeat(PART_LENGTH * 2));
    await durable.save(snapshot);
    storage.written.length = 0;
    await durable.save(snapshot);
    assert.deepEqual(storage.written, []);
    snapshot.counter = 2;
    await durable.save(snapshot);
    assert.deepEqual(storage.written, [`${SNAPSHOT_KEY}#${partsOf(snapshot).length - 1}`]);
  });
});

describe('DurableStorage exchanges', () => {
  it('should keep an exchange with the longest trace in parts and remove every part of it', async () => {
    const storage = memoryStorage();
    const durable = new DurableStorage(storage);
    const exchange = { id: 'x7', source: 'relay', at: 3, method: 'POST', path: '/token', request: { method: 'POST', url: 'http://127.0.0.1:8787/token', headers: [] }, trace: { probes: 'h', events: Array.from({ length: 400_000 }, (_, index) => 100_000 + index) }, store: { read: [], wrote: [] } };
    await durable.putExchange(exchange);
    assert.ok(storage.held.get(exchangeKey('x7')) > 1);
    assert.deepEqual(await durable.getExchange('x7'), exchange);
    assert.equal(await durable.getExchange('x8'), undefined);
    await durable.deleteExchanges(['x7', 'x8']);
    assert.deepEqual([...storage.held.keys()], []);
  });
});
