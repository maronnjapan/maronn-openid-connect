/** Feature attribution from ownership and direct test subjects, without walking the call graph. */
import { featureOfPath, type MapData } from '@maronn-openid-connect/map-analysis';
import type { TestCase } from './model.js';

/** Add the known features each case directly tests; measured reach never assigns ownership. */
export function attachTestFeatures(tests: readonly TestCase[], data: MapData): void {
  const known = new Map((data.features ?? []).flatMap((feature) => [[feature.id, feature.id], [feature.id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()), feature.id]]));
  const endpoints = new Map((['hono', 'nextjs'] as const).flatMap((source) => (data.flows[source]?.endpoints ?? []).map((endpoint) => [`${source}:${endpoint.id}`, endpoint.feature])));
  for (const test of tests) {
    if (test.kind === 'tool') continue;
    const found = new Set<string>();
    const add = (key: string | undefined) => {
      const id = key === undefined ? undefined : known.get(key);
      if (id !== undefined) found.add(id);
    };
    add(featureOfPath(test.source.file, data.features ?? []));
    for (const feature of test.features ?? []) add(feature);
    for (const subject of test.subjects) {
      if (subject.how === 'coverage') continue;
      if (subject.kind === 'function') add((data.functions[subject.id] ?? data.bodies[subject.id])?.feature);
      else if (subject.kind === 'endpoint') add(endpoints.get(`${subject.source}:${subject.id}`));
    }
    if (found.size > 0) test.features = [...found].sort();
    else delete test.features;
  }
}
