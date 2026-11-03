/** The source files a map can open, with the catalog's exact function spans. */
import { posix } from 'node:path';

/** Attach source references to the map and collect each file once, using the extraction roots. */
export function collectSources({ functions, flows, roots, directories, frameworks, spanOf }) {
  const files = new Map(roots.map((root) => [root.name, root.files]));
  const sources = {};
  const add = (root, module) => {
    const id = `${root}:${module}`;
    if (sources[id] !== undefined) return id;
    const code = files.get(root)?.get(module);
    if (code === undefined || directories[root] === undefined) throw new Error(`Source missing: ${id}`);
    sources[id] = { path: posix.join(directories[root], module), code };
    return id;
  };
  for (const card of Object.values(functions)) {
    const span = spanOf(card.id);
    if (span === undefined) throw new Error(`Function span missing: ${card.id}`);
    card.source = { file: add(card.package, card.module), start: span.doc ?? span.start, end: span.end };
  }
  for (const [framework, flow] of Object.entries(flows)) {
    const definition = frameworks[framework];
    if (definition === undefined) throw new Error(`Extraction framework missing: ${framework}`);
    for (const endpoint of flow.endpoints) {
      if (endpoint.module !== undefined) endpoint.source = add(definition.source, posix.join(definition.root, endpoint.module));
    }
  }
  return sources;
}
