/**
 * The memory database of the OP as JSON and back: the build writes the
 * database the premises were made on beside the map, and the page's OP
 * takes it again (PreparedPremises.database). Its records are plain
 * objects, arrays and strings, numbers and booleans, held in Maps, some of
 * whose values are Maps of Sets (the consents): a Map is written as
 * `{ $map: [[key, value], …] }`, a Set as `{ $set: […] }`. No record of the
 * database has a member named `$map` or `$set`.
 */
import type { EncodedValue } from './api.js';

/** A value as JSON, its Maps and Sets tagged (see the module comment). */
export function encodeValue(value: unknown): EncodedValue {
  if (value instanceof Map) return { $map: [...Map.prototype.entries.call(value)].map(([key, member]) => [key, encodeValue(member)]) };
  if (value instanceof Set) return { $set: [...value].map(encodeValue) };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined).map(([key, member]) => [key, encodeValue(member)]));
  return value;
}

/** A value from its JSON (encodeValue), its Maps and Sets made again. */
export function decodeValue(value: EncodedValue): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.$map) && Object.keys(object).length === 1) return new Map((object.$map as Array<[unknown, EncodedValue]>).map(([key, member]) => [key, decodeValue(member)]));
  if (Array.isArray(object.$set) && Object.keys(object).length === 1) return new Set((object.$set as EncodedValue[]).map(decodeValue));
  return Object.fromEntries(Object.entries(object).map(([key, member]) => [key, decodeValue(member)]));
}
