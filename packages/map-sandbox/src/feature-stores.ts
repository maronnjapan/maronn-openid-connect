import type { MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { cibaAuthenticationRequestStore, cibaLoginTransactionStore } from '../../../apps/hono/src/oidc-provider/features/ciba/store.js';
import { InMemoryDeviceAuthorizationStore, deviceAuthorizationStore } from '../../../apps/hono/src/oidc-provider/features/device-authorization-grant/store.js';
import { InMemoryDynamicallyRegisteredClientStore, dynamicClientStore } from '../../../apps/hono/src/oidc-provider/features/dynamic-client-registration/store.js';
import { InMemoryPushedAuthorizationRequestStore, parStore } from '../../../apps/hono/src/oidc-provider/features/par/store.js';
import { createInMemoryCibaAuthenticationRequestStore, createInMemoryCibaLoginTransactionStore } from '../../experimental/src/ciba/index.js';
import { atClock } from './clock.js';

interface StoreBinding {
  singleton: object;
  create: () => object;
  reads: readonly string[];
  writes: readonly string[];
}

/** Describe the singleton methods to delegate and the operations that must survive a snapshot. */
function binding<T extends object>(singleton: T, create: () => T, reads: ReadonlyArray<keyof T & string>, writes: ReadonlyArray<keyof T & string>): StoreBinding {
  return { singleton, create, reads, writes };
}

const stores = {
  par: binding(parStore, () => new InMemoryPushedAuthorizationRequestStore(), [], ['save', 'consume']),
  device: binding(deviceAuthorizationStore, () => new InMemoryDeviceAuthorizationStore(), ['findByDeviceCode', 'findByUserCode'], ['save', 'update', 'delete', 'consume']),
  ciba: binding(cibaAuthenticationRequestStore, createInMemoryCibaAuthenticationRequestStore, ['findByAuthReqId', 'listPendingBySubject'], ['save', 'update', 'delete', 'consume']),
  cibaLogin: binding(cibaLoginTransactionStore, createInMemoryCibaLoginTransactionStore, ['findById'], ['save', 'update', 'delete']),
  registration: binding(dynamicClientStore, () => new InMemoryDynamicallyRegisteredClientStore(), ['get', 'count'], ['save', 'delete']),
};

type StoreName = keyof typeof stores;
interface StoreWrite {
  store: StoreName;
  method: string;
  at: number;
  args: unknown[];
}

interface ScenarioDatabase extends MemoryDatabase {
  featureStoreWrites?: StoreWrite[];
}

/** Bind a store method to its instance. */
function methodOf(store: object, method: string): (...args: unknown[]) => Promise<unknown> {
  const fn: unknown = Reflect.get(store, method);
  if (typeof fn !== 'function') throw new Error(`Unknown sandbox feature store method: ${method}`);
  return (...args) => Reflect.apply(fn, store, args) as Promise<unknown>;
}

/**
 * Give each sandbox database its own copy of the feature stores. The live OP
 * captures singleton objects in its feature context, so delegate their methods
 * for the duration of the sandbox's serialized run. Replay each write at
 * the time it originally ran so lazy eviction and consumption agree with
 * the setup even if the case evaluates a later request after expiry.
 */
export async function onFeatureStores<T>(db: MemoryDatabase, run: () => Promise<T>): Promise<T> {
  const scoped = db as ScenarioDatabase;
  const writes = scoped.featureStoreWrites ??= [];
  const delegates = new Map<StoreName, object>();
  for (const name of Object.keys(stores) as StoreName[]) delegates.set(name, stores[name].create());
  for (const write of writes) {
    const store = delegates.get(write.store);
    if (store === undefined || !stores[write.store].writes.includes(write.method)) throw new Error('Invalid sandbox feature store snapshot.');
    const invoke = methodOf(store, write.method);
    await atClock(write.at, () => invoke(...structuredClone(write.args)));
  }

  const restore: Array<() => void> = [];
  try {
    for (const [name, delegate] of delegates) {
      const { singleton, reads, writes: methods } = stores[name];
      for (const method of [...reads, ...methods]) {
        const original = Object.getOwnPropertyDescriptor(singleton, method);
        restore.push(() => {
          if (original === undefined) Reflect.deleteProperty(singleton, method);
          else Object.defineProperty(singleton, method, original);
        });
        const invoke = methodOf(delegate, method);
        Object.defineProperty(singleton, method, {
          configurable: true,
          value: methods.includes(method) ? async (...args: unknown[]) => {
            const write = { store: name, method, at: Date.now(), args: structuredClone(args) };
            const result = await invoke(...args);
            writes.push(write);
            return result;
          } : invoke,
        });
      }
    }
    return await run();
  } finally {
    for (const reset of restore.reverse()) reset();
  }
}
