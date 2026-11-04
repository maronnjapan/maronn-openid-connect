/** Compare every mechanically found wiring site with emitted map evidence. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
const repository = resolve(import.meta.dirname, '..');
const inventoryPath = process.argv[2] ?? 'work/wiring-inventory.json';
const mapPath = resolve(repository, process.argv[3] ?? 'apps/map/public/data/map.json');
const outputPath = resolve(repository, process.argv[4] ?? 'work/wiring-coverage.json');
const inventory = JSON.parse(readFileSync(resolve(repository, inventoryPath), 'utf8'));
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const definition = JSON.parse(readFileSync(`${repository}/packages/cli/extract.json`, 'utf8'));
const roots = [...Object.entries(definition.sources), ...Object.entries(definition.libraries)].map(([name, entry]) => ({ name, directory: resolve(repository, 'packages/cli', entry.directory) + '/' }));
/** Translate an inventory source path into the map's source key. */
function fileKey(item) { const root = roots.find((root) => root.name === item.mapRoot); return root ? `${root.name}:${item.file.slice(root.directory.length - repository.length - 1)}` : undefined; }
/** Read all emitted nodes of a flow tree. */
function nodesOf(nodes) { return nodes.flatMap((node) => [node, ...nodesOf(node.pre ?? []), ...(node.branches ?? []).flatMap((branch) => nodesOf(branch.nodes))]); }
const frames = [...Object.values(map.functions), ...Object.values(map.bodies)].map((entry) => {
  const path = resolve(dirname(mapPath), entry.frame.replace(/^\.\/data\//, ''));
  const tree = JSON.parse(readFileSync(path, 'utf8')).tree;
  return { entry, tree, nodes: nodesOf(tree.nodes) };
});
/** Test whether emitted source lines contain the complete wiring site. */
function contains(range, item) { return range[0] <= item.line && range[1] >= (item.end ?? item.line); }
/** Test whether emitted source lines overlap a candidate's implementation. */
function overlaps(range, item) { return range[0] <= (item.end ?? item.line) && range[1] >= item.line; }
const nativeIteration = /\.(?:map|flatMap|filter|find|findIndex|some|every|forEach|reduce|reduceRight|sort)$/;
const items = inventory.items.map((item) => {
  const compact = { kind: item.kind, file: item.file, line: item.line, end: item.end ?? item.line };
  if (item.mapRoot === null) return { ...compact, status: 'outside-map-roots', why: item.file.startsWith('packages/') ? 'CLI/map-analysis tooling is outside generated provider roots in packages/cli/extract.json.' : 'Outer app configuration, startup, operator or settings is outside provider roots in packages/cli/extract.json.' };
  const key = fileKey(item);
  const wiring = (map.wiring ?? []).filter((entry) => entry.file === key && contains(entry.lines, item));

  const inFile = frames.filter((frame) => frame.tree.file === key);
  if (item.kind === 'returned-method-object' || item.kind === 'callback-property') {
    const implementations = inFile.flatMap((frame) => (frame.tree.implements ?? []).filter((impl) => item.kind === 'callback-property' ? contains(impl.lines, item) && impl.member.endsWith('.' + item.property) : overlaps(impl.lines, item)).map((impl) => ({ frame, impl })));
    const implementation = implementations[0];
    if (implementation && (item.kind !== 'returned-method-object' || item.methods.every((method) => implementations.some(({ impl }) => impl.member.endsWith('.' + method))))) return { ...compact, status: 'traced', evidence: `${implementation.frame.tree.id} implements ${implementation.impl.member}`, why: 'Contextual interface member and implementation lines are explicitly emitted.' };
  }
  if (item.kind === 'callback-argument') {
    const target = item.target;
    const candidates = inFile.flatMap((frame) => frame.nodes.filter((node) => overlaps(node.lines, item)).map((node) => ({ frame, node })));
    if (target) {
      const found = candidates.find(({ node }) => node.target?.id === target);
      if (found) return { ...compact, status: 'traced', evidence: `${found.frame.tree.id}/${found.node.id}`, why: `Named callback target ${target} is explicitly emitted as a call.` };
    }
    const nestedTargets = item.repositoryCalls ?? [];
    if (item.inline && nativeIteration.test(item.callee)) {
      const emitted = new Set(candidates.map(({ node }) => node.target?.id).filter(Boolean));
      if (nestedTargets.every((target) => emitted.has(target))) {
        const iteration = candidates.find(({ node }) => node.kind === 'loop') ?? candidates[0];
        if (iteration) return { ...compact, status: 'traced', evidence: `${iteration.frame.tree.id}/${iteration.node.id}`, why: nestedTargets.length ? 'Inline iteration callback and all repository function calls are emitted in the flow tree.' : 'Inline iteration callback contains no hidden repository function call; its host statement and callback source are emitted.' };
      }
    }
    if (!item.inline && !target && item.code === 'Boolean' && nativeIteration.test(item.callee)) {
      const found = candidates[0];
      if (found) return { ...compact, status: 'traced', evidence: `${found.frame.tree.id}/${found.node.id}`, why: 'Native Boolean callback has no repository implementation; the iteration is emitted.' };
    }
    // Registered Hono handlers are endpoint body roots, even when their source is an arrow value.
    const endpoint = inFile.find((frame) => frame.entry.endpoint !== undefined || Object.values(map.flows).some((flow) => flow.endpoints.some((entry) => entry.root === frame.tree.id)));
    if (/\.(get|post|put|patch|delete|all|options)$/.test(item.callee) && endpoint && contains(endpoint.tree.lines, item)) return { ...compact, status: 'traced', evidence: endpoint.tree.id, why: 'The callback is the endpoint handler whose complete flow is emitted as the endpoint root.' };
  }
  if (item.kind === 'dynamic-context-write') {
    const call = inFile.flatMap((frame) => frame.nodes.filter((node) => node.kind === 'call' && node.target !== undefined && overlaps(node.lines, item)).map((node) => ({ frame, node })))[0];
    if (call) return { ...compact, status: call.node.target.kind === 'untraceable' ? 'untraceable' : 'traced', evidence: `${call.frame.tree.id}/${call.node.id}`, why: call.node.target.kind === 'untraceable' ? call.node.target.why : 'This setter is a business store member call; the member target is emitted.' };
  }
  if (item.kind === 'module-callable') {
    const endpoint = inFile.find((frame) => frame.entry.endpoint !== undefined && contains(frame.tree.lines, item));
    if (endpoint) return { ...compact, status: 'traced', evidence: endpoint.tree.id, why: 'The callable is an endpoint handler, with its body emitted as the root.' };
  }
  if (wiring.length) {
    const found = wiring.find((entry) => entry.status === 'untraceable') ?? wiring[0];
    return { ...compact, status: found.status === 'resolved' ? 'traced' : 'untraceable', evidence: `wiring:${found.id}`, why: found.why ?? 'Map wiring entry resolves the target and its endpoint destination.' };
  }
  return { ...compact, status: 'uncovered', code: item.code, why: 'No explicit call target, implementation bridge, endpoint callback tree or wiring entry covers this site.' };
});
const counts = Object.fromEntries([...new Set(items.map((item) => item.status))].map((status) => [status, items.filter((item) => item.status === status).length]));
writeFileSync(outputPath, JSON.stringify({ revision: inventory.revision, files: inventory.files, counts, items }, null, 2) + '\n');
console.log(JSON.stringify(counts, null, 2));
if (counts.uncovered) process.exitCode = 1;
