/**
 * The memory database of the OP as JSON and back: a workspace keeps its
 * database between two runs of its host (a Durable Object put to sleep
 * wakes up with its storage, not its memory). Its records are plain
 * objects, arrays and strings, numbers and booleans, held in Maps, some of
 * whose values are Maps of Sets (the consents): a Map is written as
 * `{ $map: [[key, value], …] }`, a Set as `{ $set: […] }`, and a Date as
 * `{ $date: <Unix milliseconds> }`. These tags are reserved by the codec:
 * a record may hold JSON a client sent (the `claims` of an authorization
 * request), whose members can be named anything, so an object with a
 * member whose name starts with `$` is written as `{ $object: [[name,
 * value], …] }`, and read back as the object it was.
 */
/** A value encoded for JSON (encodeValue). */
export type EncodedValue = unknown;

// Keep the original constructor while a workspace with a moved clock replaces the global one.
const RealDate = Date;

/** A value as JSON with its non-JSON types tagged, and an object that could be read as a tag escaped (see the module comment). */
export function encodeValue(value: unknown): EncodedValue {
  if (value instanceof RealDate) return { $date: value.getTime() };
  if (value instanceof Map) return { $map: [...Map.prototype.entries.call(value)].map(([key, member]) => [key, encodeValue(member)]) };
  if (value instanceof Set) return { $set: [...value].map(encodeValue) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === 'object') {
    const members = Object.entries(value).filter(([, member]) => member !== undefined).map(([key, member]): [string, EncodedValue] => [key, encodeValue(member)]);
    return members.some(([key]) => key.startsWith('$')) ? { $object: members } : Object.fromEntries(members);
  }
  return value;
}

/** A value from its JSON (encodeValue), with its non-JSON types restored and its escaped objects read back. */
export function decodeValue(value: EncodedValue): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length === 1) {
    if (typeof object.$date === 'number') return new RealDate(object.$date);
    if (Array.isArray(object.$map)) return new Map((object.$map as Array<[unknown, EncodedValue]>).map(([key, member]) => [key, decodeValue(member)]));
    if (Array.isArray(object.$set)) return new Set((object.$set as EncodedValue[]).map(decodeValue));
    if (Array.isArray(object.$object)) return Object.fromEntries((object.$object as Array<[string, EncodedValue]>).map(([key, member]) => [key, decodeValue(member)]));
  }
  return Object.fromEntries(Object.entries(object).map(([key, member]) => [key, decodeValue(member)]));
}
