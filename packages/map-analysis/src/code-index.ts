/**
 * What following the code needs of the map (CodeIndex), from map.json: the
 * build writes it as data/code.json for the code page, which so does not
 * load map.json, and the drawer of the map derives it from map.json. Plain
 * data, shared with the page (`@maronn-openid-connect/map-analysis/code-index`):
 * it imports only types.
 */
import type { CodeIndex, MapData } from './model.js';

/** The index of the code (see the module comment). */
export function codeIndexOf(data: Pick<MapData, 'functions' | 'bodies' | 'members' | 'sources' | 'features'>): CodeIndex {
  const frames: CodeIndex['frames'] = {};
  for (const entry of Object.values(data.functions)) frames[entry.id] = { name: entry.name, kind: 'function', ...(entry.summary === '' ? {} : { summary: entry.summary }), ...(entry.source === undefined ? {} : { source: entry.source }) };
  for (const entry of Object.values(data.bodies)) frames[entry.id] = { name: entry.name, kind: 'body', ...(entry.summary === '' ? {} : { summary: entry.summary }), ...(entry.source === undefined ? {} : { source: entry.source }) };
  const members: CodeIndex['members'] = {};
  for (const [id, member] of Object.entries(data.members)) members[id] = { type: member.type, member: member.member, ...(member.implementedBy === undefined ? {} : { implementedBy: member.implementedBy }) };
  return { version: 1, sources: data.sources, features: data.features, frames, members };
}
