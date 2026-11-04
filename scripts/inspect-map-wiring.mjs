/** Read actual frame edges, typed implementations and endpoint reach from a built map. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CallGraph, reachOf } from '../packages/map-analysis/dist/impact.js';
import { nodesOf } from '../packages/map-analysis/dist/tree.js';

const directory = resolve(process.argv[2]);
const data = JSON.parse(readFileSync(resolve(directory, 'map.json'), 'utf8'));
const trees = new Map(Object.values({ ...data.functions, ...data.bodies })
  .filter((entry) => entry.frame)
  .map((entry) => [entry.id, JSON.parse(readFileSync(resolve(directory, entry.frame.replace('./data/', '')), 'utf8')).tree]));
const groups = new Map();
for (const [framework, flow] of Object.entries(data.flows)) {
  for (const endpoint of flow.endpoints) {
    const source = framework === 'nextjs' ? 'nextjs' : 'hono';
    const key = `${source}:${endpoint.id}`;
    const entry = groups.get(key) ?? { source, frameworks: [], endpoint, root: endpoint.root };
    entry.frameworks.push(framework);
    groups.set(key, entry);
  }
}
const graph = new CallGraph(trees, [...groups.values()]);
const pattern = new RegExp(process.argv[4] ?? '.*');

/** Keep the computed destination and the typed chain distinct from registration metadata. */
function waySummary({ source, endpoint, step, via, through, features }) {
  return { source, endpoint, step, via, through, features };
}

/** Report a factory's own runtime path separately from paths through the methods it implements. */
function frameReport([id, tree]) {
  return {
    id,
    calls: [...nodesOf(tree.nodes)].filter((node) => node.kind === 'call').map(({ code, target }) => ({ code, target })),
    implements: (tree.implements ?? []).map((implementation) => ({
      ...implementation,
      reach: reachOf(graph, { member: implementation.member, root: id.slice(0, id.indexOf(':')) }).map(waySummary),
    })),
    prReach: data.changes?.frames.find((entry) => entry.id === id)?.reach ?? [],
    deferred: tree.deferred ?? [],
    reach: reachOf(graph, { frame: id, node: '' }).map(waySummary),
  };
}

const report = {
  version: data.version,
  counts: {
    functions: Object.keys(data.functions).length,
    bodies: Object.keys(data.bodies).length,
    members: Object.keys(data.members).length,
    wiring: data.wiring?.length ?? 0,
  },
  functions: [...trees].filter(([id]) => pattern.test(id)).map(frameReport),
  members: Object.values(data.members).filter(({ id }) => pattern.test(id)),
};
writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  counts: report.counts,
  functions: report.functions.map(({ id, calls, implements: implementations, reach }) => ({
    id,
    calls: calls.length,
    implements: implementations.map((entry) => entry.member),
    reach: reach.map((way) => `${way.source}:${way.endpoint}/${way.step ?? ''}`),
  })),
}, null, 2));
