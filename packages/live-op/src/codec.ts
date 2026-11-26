/**
 * The memory database of the OP as JSON and back: a workspace keeps its
 * database between two runs of its host (a Durable Object put to sleep
 * wakes up with its storage, not its memory). Its records are plain
 * objects, arrays and strings, numbers and booleans, held in Maps, some of
 * whose values are Maps of Sets (the consents): a Map is written as
 * `{ $map: [[key, value], …] }`, a Set as `{ $set: […] }`, and a Date as
 * `{ $date: <Unix milliseconds> }`. These tags are reserved by the codec.
 */
/** A value encoded for JSON (encodeValue). */
export type EncodedValue = unknown;

// Keep the original constructor while a workspace with a moved clock replaces the global one.
const RealDate = Date;

/** A value as JSON with its non-JSON types tagged (see the module comment). */
export function encodeValue(value: unknown): EncodedValue {
  if (value instanceof RealDate) return { $date: value.getTime() };
  if (value instanceof Map) return { $map: [...Map.prototype.entries.call(value)].map(([key, member]) => [key, encodeValue(member)]) };
  if (value instanceof Set) return { $set: [...value].map(encodeValue) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined).map(([key, member]) => [key, encodeValue(member)]));
  return value;
}

/** A value from its JSON (encodeValue), with its non-JSON types restored. */
export function decodeValue(value: EncodedValue): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (typeof object.$date === 'number' && Object.keys(object).length === 1) return new RealDate(object.$date);
  if (Array.isArray(object.$map) && Object.keys(object).length === 1) return new Map((object.$map as Array<[unknown, EncodedValue]>).map(([key, member]) => [key, decodeValue(member)]));
  if (Array.isArray(object.$set) && Object.keys(object).length === 1) return new Set((object.$set as EncodedValue[]).map(decodeValue));
  return Object.fromEntries(Object.entries(object).map(([key, member]) => [key, decodeValue(member)]));
}
