/**
 * The records the OP's features keep apart from its database: pushed
 * authorization requests (par), device codes, CIBA requests and their login
 * transactions, and dynamically registered clients. Each feature keeps them
 * in a store of its module (`parStore`, …), one for the process, which its
 * context hook hands the OP when the app is made. A workspace needs its own
 * records, so each workspace has its own store of each kind (the in-memory
 * one the feature ships), and while one of its requests runs the methods of
 * the module's store forward to it.
 *
 * A workspace's host may forget its memory between two requests (a Durable
 * Object put to sleep), so every write is noted with its arguments and the
 * clock it ran at, and the stores are made again by running the writes once
 * more, each at its own clock, in order: what has expired since is evicted
 * as it would have been.
 *
 * The records of every store but the registered clients live minutes (a
 * pushed request 60 seconds, a device code 10, a CIBA request 2), so the
 * writes of a record last written over an hour ago (FEATURE_WRITE_LIFETIME)
 * are dropped (prune): the record has expired, and its writes would only
 * grow what the workspace keeps and the time it takes to make it again.
 *
 * The calls of a request are noted too, so the map shows what it read and
 * wrote of them beside the records of the database.
 */
import { cibaAuthenticationRequestStore, cibaLoginTransactionStore } from '../../../apps/hono/src/oidc-provider/features/ciba/store.js';
import { InMemoryDeviceAuthorizationStore, deviceAuthorizationStore } from '../../../apps/hono/src/oidc-provider/features/device-authorization-grant/store.js';
import { InMemoryDynamicallyRegisteredClientStore, dynamicClientStore } from '../../../apps/hono/src/oidc-provider/features/dynamic-client-registration/store.js';
import { InMemoryPushedAuthorizationRequestStore, parStore } from '../../../apps/hono/src/oidc-provider/features/par/store.js';
import { createInMemoryCibaAuthenticationRequestStore, createInMemoryCibaLoginTransactionStore } from '../../experimental/src/ciba/index.js';
import type { StoreChange, StoreRead } from './api.js';
import { atClock } from './clock.js';
import { plainOf } from './store.js';

/** How long after its record was last written a write of a store whose records live minutes is kept, in milliseconds (1 hour). */
export const FEATURE_WRITE_LIFETIME = 60 * 60 * 1000;

/** A store of a feature: the module's one, how to make one of a workspace, its methods that read and that write, and whether its records live minutes. */
interface StoreBinding {
  singleton: object;
  create: () => object;
  /** The collection the map names its records by. */
  collection: string;
  reads: readonly string[];
  writes: readonly string[];
  /** Its records expire within minutes, so the writes of one written over FEATURE_WRITE_LIFETIME ago are dropped. */
  shortLived: boolean;
}

/** A store of a feature (see StoreBinding). */
function binding<T extends object>(singleton: T, create: () => T, collection: string, reads: ReadonlyArray<keyof T & string>, writes: ReadonlyArray<keyof T & string>, shortLived: boolean): StoreBinding {
  return { singleton, create, collection, reads, writes, shortLived };
}

const stores = {
  par: binding(parStore, () => new InMemoryPushedAuthorizationRequestStore(), 'pushedRequests', [], ['save', 'consume'], true),
  device: binding(deviceAuthorizationStore, () => new InMemoryDeviceAuthorizationStore(), 'deviceCodes', ['findByDeviceCode', 'findByUserCode'], ['save', 'update', 'delete', 'consume'], true),
  ciba: binding(cibaAuthenticationRequestStore, createInMemoryCibaAuthenticationRequestStore, 'cibaRequests', ['findByAuthReqId', 'listPendingBySubject'], ['save', 'update', 'delete', 'consume'], true),
  cibaLogin: binding(cibaLoginTransactionStore, createInMemoryCibaLoginTransactionStore, 'cibaLogins', ['findById'], ['save', 'update', 'delete'], true),
  registration: binding(dynamicClientStore, () => new InMemoryDynamicallyRegisteredClientStore(), 'registeredClients', ['get', 'count'], ['save', 'delete'], false),
};

type StoreName = keyof typeof stores;

/** A write to a store of a feature: which store, which method, the clock it ran at (Unix milliseconds) and its arguments as JSON. */
export interface FeatureWrite {
  store: StoreName;
  method: string;
  at: number;
  args: unknown[];
}

/** A method of a store, bound to it. */
function methodOf(store: object, method: string): (...args: unknown[]) => Promise<unknown> {
  const fn: unknown = Reflect.get(store, method);
  if (typeof fn !== 'function') throw new Error(`Unknown feature store method: ${method}`);
  return (...args) => Reflect.apply(fn, store, args) as Promise<unknown>;
}

/** The key a call names its record by: its first argument when it is a string, the `client_id` / an id of a record it saves, else none. */
function keyOf(args: readonly unknown[]): string | undefined {
  const [first] = args;
  if (typeof first === 'string') return first;
  if (first !== null && typeof first === 'object') {
    const record = first as Record<string, unknown>;
    for (const name of ['requestUri', 'request_uri', 'deviceCode', 'authReqId', 'id', 'clientId', 'client_id']) {
      if (typeof record[name] === 'string') return record[name] as string;
    }
  }
  return undefined;
}

/** What the calls of one request read and wrote of the stores of the features. */
export interface FeatureAccess {
  read: StoreRead[];
  wrote: StoreChange[];
}

/** The stores of the features of one workspace (see the module comment). */
export class FeatureStores {
  private readonly delegates = new Map<StoreName, object>();

  private constructor(readonly writes: FeatureWrite[]) {
    for (const name of Object.keys(stores) as StoreName[]) this.delegates.set(name, stores[name].create());
  }

  /** The stores of a workspace made again from its writes (none for a new workspace), each run at its own clock; an error for a write of a store or a method this build does not have. */
  static async restore(writes: readonly FeatureWrite[] = []): Promise<FeatureStores> {
    const made = new FeatureStores([]);
    for (const write of writes) {
      const store = Object.hasOwn(stores, write.store) ? made.delegates.get(write.store) : undefined;
      if (store === undefined || !stores[write.store].writes.includes(write.method) || !Array.isArray(write.args)) throw new Error(`A write this OP's feature stores do not have (${String(write.store)}.${String(write.method)}).`);
      await atClock(write.at, () => methodOf(store, write.method)(...structuredClone(write.args)));
      made.writes.push(write);
    }
    return made;
  }

  /**
   * Drop the writes of the records of the short-lived stores whose last
   * write is older than FEATURE_WRITE_LIFETIME at a clock (the OP's, in
   * Unix milliseconds): every write of such a record goes, so the writes
   * left make again only records that may not have expired. The writes of
   * the registered clients are kept.
   */
  prune(now: number): void {
    const lastWritten = new Map<string, number>();
    const recordOf = (write: FeatureWrite): string => JSON.stringify([write.store, keyOf(write.args) ?? null]);
    for (const write of this.writes) {
      if (keyOf(write.args) !== undefined) lastWritten.set(recordOf(write), Math.max(lastWritten.get(recordOf(write)) ?? write.at, write.at));
    }
    const kept = this.writes.filter((write) => !stores[write.store].shortLived || (lastWritten.get(recordOf(write)) ?? write.at) > now - FEATURE_WRITE_LIFETIME);
    if (kept.length === this.writes.length) return;
    this.writes.length = 0;
    for (const write of kept) this.writes.push(write);
  }

  /**
   * The records the stores hold, where a store keeps them in a Map it
   * names (`records`, `clients`: the class stores of PAR, device codes and
   * registered clients); the CIBA stores keep theirs in a closure, which
   * their writes say instead.
   */
  records(): Array<{ collection: string; key: string; value: unknown }> {
    const records: Array<{ collection: string; key: string; value: unknown }> = [];
    for (const [name, delegate] of this.delegates) {
      for (const field of ['records', 'clients']) {
        const held = Reflect.get(delegate, field) as unknown;
        if (!(held instanceof Map)) continue;
        for (const [key, value] of held) records.push({ collection: stores[name].collection, key: String(key), value });
      }
    }
    return records;
  }

  /**
   * Run with the methods of the modules' stores forwarding to this
   * workspace's, noting the writes (for restore) and what each call read
   * and wrote (for the map), and give the modules' stores back after.
   */
  async bind<T>(run: () => Promise<T>): Promise<{ result: T; access: FeatureAccess }> {
    const access: FeatureAccess = { read: [], wrote: [] };
    const restore: Array<() => void> = [];
    try {
      for (const [name, delegate] of this.delegates) {
        const { singleton, reads, writes: methods, collection } = stores[name];
        for (const method of [...reads, ...methods]) {
          const original = Object.getOwnPropertyDescriptor(singleton, method);
          restore.push(() => {
            if (original === undefined) Reflect.deleteProperty(singleton, method);
            else Object.defineProperty(singleton, method, original);
          });
          const invoke = methodOf(delegate, method);
          const writes = methods.includes(method);
          Object.defineProperty(singleton, method, {
            configurable: true,
            value: async (...args: unknown[]) => {
              const write = writes ? { store: name, method, at: Date.now(), args: structuredClone(args) } : undefined;
              const result = await invoke(...args);
              const key = keyOf(args);
              if (write !== undefined) {
                this.writes.push(write);
                access.wrote.push({
                  collection,
                  key: key ?? method,
                  change: method === 'save' ? 'added' : method === 'delete' ? 'removed' : 'changed',
                  ...(method === 'save' ? { value: plainOf(args[0]) } : {}),
                  fields: [method],
                });
              } else {
                access.read.push({ collection, ...(key === undefined ? {} : { key }), found: result !== undefined && result !== null && !(Array.isArray(result) && result.length === 0) });
              }
              return result;
            },
          });
        }
      }
      const result = await run();
      return { result, access };
    } finally {
      for (const reset of restore.reverse()) reset();
    }
  }
}
