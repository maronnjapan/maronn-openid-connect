/**
 * Where the Durable Object of a workspace keeps it (WorkspaceStorage of the
 * live OP): the key-value API of the Durable Object's storage, which keeps
 * each value as it is (a SQLite-backed Durable Object, as the map's are,
 * keeps up to 2 MB a value).
 *
 * - `snapshot`: what the workspace holds (WorkspaceSnapshot): its database,
 *   the writes of its features' stores, its key, its clock and the
 *   summaries of its exchanges
 * - `x:<id>`: an exchange, whole (its trace can hold 400,000 probes)
 *
 * A value is written as JSON (with its Dates, Maps, Sets and undefined
 * tagged, so it reads back as it was given) cut into parts of at most
 * PART_LENGTH characters: the key holds how many parts there are, and
 * `<key>#<n>` the n-th part. A snapshot is written again after every
 * request, so only the parts that changed are written.
 */
import type { LiveExchange, WorkspaceSnapshot, WorkspaceStorage } from '@maronn-openid-connect/live-op';

/** The part of a Durable Object's storage (DurableObjectStorage) a DurableStorage uses. */
export interface KeyValueStorage {
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
}

/**
 * The most characters a part holds: a part of characters past Latin-1 is
 * kept as UTF-16, so 512 Ki characters are at most 1 MiB, half of what the
 * storage keeps a value.
 */
export const PART_LENGTH = 512 * 1024;

/** The most keys one call of the storage takes. */
const KEYS_PER_CALL = 128;

/** The key of what a workspace holds. */
export const SNAPSHOT_KEY = 'snapshot';

/** The key of an exchange. */
export function exchangeKey(id: string): string {
  return `x:${id}`;
}

/** The key of the n-th part of a value. */
function partKey(key: string, index: number): string {
  return `${key}#${index}`;
}

/** The tag of a value JSON cannot hold as it is (see the module comment); an object with a member of this name is tagged too. */
const TAG = '~';

/** A value as JSON with its Dates, Maps, Sets, undefined, bigints and numbers JSON has no form for tagged (thawed by thaw). */
export function freeze(value: unknown): unknown {
  if (value === undefined) return { [TAG]: 'u' };
  if (typeof value === 'bigint') return { [TAG]: 'b', v: value.toString() };
  if (typeof value === 'number' && !Number.isFinite(value)) return { [TAG]: 'n', v: String(value) };
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return { [TAG]: 'd', v: value.getTime() };
  if (value instanceof Map) return { [TAG]: 'm', v: [...value].map(([key, member]) => [freeze(key), freeze(member)]) };
  if (value instanceof Set) return { [TAG]: 's', v: [...value].map(freeze) };
  if (Array.isArray(value)) return value.map(freeze);
  const members = Object.fromEntries(Object.entries(value).map(([key, member]) => [key, freeze(member)]));
  return Object.hasOwn(value, TAG) ? { [TAG]: 'o', v: members } : members;
}

/** A value from its JSON as freeze wrote it. */
export function thaw(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(thaw);
  const object = value as Record<string, unknown>;
  if (!Object.hasOwn(object, TAG)) return Object.fromEntries(Object.entries(object).map(([key, member]) => [key, thaw(member)]));
  const held = object['v'];
  switch (object[TAG]) {
    case 'u':
      return undefined;
    case 'b':
      return BigInt(held as string);
    case 'n':
      return Number(held);
    case 'd':
      return new Date(held as number);
    case 'm':
      return new Map((held as Array<[unknown, unknown]>).map(([key, member]) => [thaw(key), thaw(member)]));
    case 's':
      return new Set((held as unknown[]).map(thaw));
    case 'o':
      return Object.fromEntries(Object.entries(held as Record<string, unknown>).map(([key, member]) => [key, thaw(member)]));
    default:
      throw new Error(`Unknown tag ${String(object[TAG])} in a stored value.`);
  }
}

/** The parts a value is written in: its frozen JSON cut every PART_LENGTH characters (one empty part for none). */
export function partsOf(value: unknown): string[] {
  const text = JSON.stringify(freeze(value));
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += PART_LENGTH) parts.push(text.slice(start, start + PART_LENGTH));
  return parts;
}

/** Split keys into the groups one call of the storage takes. */
function batches<T>(items: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += KEYS_PER_CALL) groups.push(items.slice(start, start + KEYS_PER_CALL));
  return groups;
}

/** A WorkspaceStorage on a Durable Object's storage (see the module comment). */
export class DurableStorage implements WorkspaceStorage {
  private readonly storage: KeyValueStorage;
  /** The parts of the snapshot as the storage holds them, once read or written. */
  private snapshotParts: string[] | undefined;

  /** A storage of a workspace on the storage of its Durable Object. */
  constructor(storage: KeyValueStorage) {
    this.storage = storage;
  }

  /** How many parts the values of some keys are in, for each key that holds a value. */
  private async countsOf(keys: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const group of batches(keys)) for (const [key, count] of await this.storage.get<number>(group)) counts.set(key, count);
    return counts;
  }

  /** Read the parts of the values of some keys: for each key that holds a value, its parts in order. */
  private async readParts(keys: readonly string[]): Promise<Map<string, string[]>> {
    const counts = await this.countsOf(keys);
    const wanted = [...counts].flatMap(([key, count]) => Array.from({ length: count }, (_, index) => partKey(key, index)));
    const held = new Map<string, string>();
    for (const group of batches(wanted)) for (const [key, part] of await this.storage.get<string>(group)) held.set(key, part);
    const values = new Map<string, string[]>();
    for (const [key, count] of counts) {
      const parts = Array.from({ length: count }, (_, index) => held.get(partKey(key, index)));
      if (parts.some((part) => part === undefined)) throw new Error(`The storage lost a part of ${key}.`);
      values.set(key, parts as string[]);
    }
    return values;
  }

  /**
   * Write the parts of a value, given those the storage holds for it: the
   * parts that changed and the count, and the parts past the new count
   * removed. The calls are made without waiting between them, so the
   * Durable Object writes them as one.
   */
  private writeParts(key: string, parts: readonly string[], before: readonly string[]): Promise<unknown> {
    const entries: Record<string, string | number> = {};
    if (parts.length !== before.length) entries[key] = parts.length;
    parts.forEach((part, index) => {
      if (part !== before[index]) entries[partKey(key, index)] = part;
    });
    const stale = before.slice(parts.length).map((_, offset) => partKey(key, parts.length + offset));
    const keys = Object.keys(entries);
    return Promise.all([
      ...batches(keys).map((group) => this.storage.put(Object.fromEntries(group.map((name) => [name, entries[name]])))),
      ...batches(stale).map((group) => this.storage.delete(group)),
    ]);
  }

  /** Read the parts of one value and give the value, undefined when the key holds none. */
  private async read(key: string): Promise<unknown> {
    const parts = (await this.readParts([key])).get(key);
    return parts === undefined ? undefined : thaw(JSON.parse(parts.join('')));
  }

  /** What the workspace holds, undefined for a workspace never kept (or deleted when it was left unused). */
  async load(): Promise<WorkspaceSnapshot | undefined> {
    const parts = (await this.readParts([SNAPSHOT_KEY])).get(SNAPSHOT_KEY);
    this.snapshotParts = parts ?? [];
    return parts === undefined ? undefined : (thaw(JSON.parse(parts.join(''))) as WorkspaceSnapshot);
  }

  /** Keep what the workspace holds, writing only the parts that changed. */
  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    const before = this.snapshotParts ?? (await this.readParts([SNAPSHOT_KEY])).get(SNAPSHOT_KEY) ?? [];
    const parts = partsOf(snapshot);
    this.snapshotParts = parts;
    await this.writeParts(SNAPSHOT_KEY, parts, before);
  }

  /** Keep an exchange, whole. */
  async putExchange(exchange: LiveExchange): Promise<void> {
    await this.writeParts(exchangeKey(exchange.id), partsOf(exchange), []);
  }

  /** An exchange kept, undefined for one dropped or never made. */
  async getExchange(id: string): Promise<LiveExchange | undefined> {
    return (await this.read(exchangeKey(id))) as LiveExchange | undefined;
  }

  /** Remove exchanges, every part of each. */
  async deleteExchanges(ids: readonly string[]): Promise<void> {
    const counts = await this.countsOf(ids.map(exchangeKey));
    const doomed = [...counts].flatMap(([key, count]) => [key, ...Array.from({ length: count }, (_, index) => partKey(key, index))]);
    await Promise.all(batches(doomed).map((group) => this.storage.delete(group)));
  }
}
