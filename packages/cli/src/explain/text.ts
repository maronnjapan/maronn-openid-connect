/**
 * `maronn-oidc explain` as text: the overview of the map, one endpoint, one
 * step with the tree of the functions it calls, one function with what it
 * calls and who calls it.
 */
import type { FunctionCard, FunctionCatalog } from '../extract/functions.js';
import type { FlowEndpoint, FlowStep, OpFlow } from '../flow/types.js';
import { featureKeyOf } from '../registry.js';
import { stepUses, type OpMap, type StepUse } from './map.js';

const SUMMARY_WIDTH = 110;

function truncate(text: string, width = SUMMARY_WIDTH): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function methods(endpoint: FlowEndpoint): string {
  return endpoint.methods.join('|');
}

/** `name()  root module:line  [kind]`. */
function cardLine(card: FunctionCard): string {
  return `${card.name}()  ${card.package} ${card.module}:${card.line}  [${card.kind}]`;
}

/** The `[id] label — spec` of a step, as its marker line reads. */
function stepTitle(step: FlowStep): string {
  const feature = step.feature === undefined ? '' : ` (feature: ${step.feature})`;
  return `[${step.id}]${feature} ${step.label}${step.spec === undefined ? '' : ` — ${step.spec}`}`;
}

/** The bare names of the calls of a step, the dynamic ones marked. */
function callNames(step: FlowStep, functions: Record<string, FunctionCard>): string {
  const names = step.calls.map((id) => functions[id]?.name ?? id);
  const dynamic = (step.dynamicCalls ?? []).map((name) => `${name} (dynamic)`);
  const all = [...names, ...dynamic];
  return all.length === 0 ? '—' : all.join(', ');
}

/**
 * What a feature's flag reads for a step or an endpoint: the flag of its
 * feature (named by its id or by its OidcFeatureConfig key), or "every provider".
 */
function flagOf(map: OpMap, feature: string | undefined): string {
  if (feature === undefined) return 'every provider';
  const entry = map.features.find((candidate) => candidate.id === feature || featureKeyOf(candidate.id) === feature);
  return entry === undefined ? `feature: ${feature}` : entry.flag;
}

/** The overview: the commands, the frameworks, the endpoints of the configuration and the features. */
export function renderOverview(map: OpMap): string {
  const lines: string[] = [];
  lines.push('Commands');
  for (const command of map.commands) {
    lines.push(`  ${command.usage}`);
    lines.push(`      ${command.summary}`);
  }
  lines.push('');
  lines.push(`Frameworks: ${map.frameworks.join(', ')}${map.framework === undefined ? '' : `  (this map: ${map.framework})`}`);
  lines.push('');
  const enabled = map.features.filter((feature) => feature.enabled).map((feature) => feature.id);
  lines.push(`Endpoints of this configuration (features: ${enabled.length === 0 ? 'none' : enabled.join(', ')})`);
  const width = Math.max(...map.flow.endpoints.map((endpoint) => `${methods(endpoint)} ${endpoint.path}`.length));
  for (const endpoint of map.flow.endpoints) {
    const route = `${methods(endpoint)} ${endpoint.path}`.padEnd(width);
    const feature = endpoint.feature === undefined ? '' : `  (${flagOf(map, endpoint.feature as string)})`;
    lines.push(`  ${endpoint.id.padEnd(26)} ${route}  ${endpoint.label}  ${endpoint.steps.length} steps${feature}`);
  }
  const off = map.features.filter((feature) => !feature.enabled && feature.endpoints.length > 0);
  if (off.length > 0) {
    lines.push('');
    lines.push('Endpoints a feature adds (not in this configuration)');
    for (const feature of off) {
      lines.push(`  ${feature.flag.padEnd(40)} ${feature.endpoints.join(', ')}  (${feature.summary})`);
    }
  }
  lines.push('');
  lines.push('Features');
  for (const feature of map.features) {
    lines.push(`  ${feature.enabled ? 'on ' : 'off'} ${feature.id.padEnd(28)} ${feature.tier.padEnd(12)} ${feature.summary}`);
  }
  lines.push('');
  lines.push(`${Object.keys(map.functions).length} functions are reached from the steps of this configuration.`);
  lines.push('explain <endpoint> lists its steps; explain <endpoint>/<step> the functions a step calls; explain fn <name> a function and where it is used.');
  return `${lines.join('\n')}\n`;
}

/** One endpoint: its steps in pipeline order, each with its kind, function, spec and calls. */
export function renderEndpoint(map: OpMap, endpoint: FlowEndpoint): string {
  const lines: string[] = [];
  const feature = endpoint.feature === undefined ? '' : `  (${flagOf(map, endpoint.feature as string)})`;
  lines.push(`${methods(endpoint)} ${endpoint.path}  ${endpoint.label}${endpoint.spec === undefined ? '' : `  — ${endpoint.spec}`}  [${endpoint.layer}]${feature}`);
  if (endpoint.module !== undefined) lines.push(`  module: ${endpoint.module}`);
  lines.push(`  steps: ${endpoint.rearrangeable ? 'a pipeline --flow can rearrange' : 'a fixed sequence (a screen)'}`);
  lines.push('');
  lines.push('Steps');
  endpoint.steps.forEach((step, index) => {
    lines.push(`  ${String(index + 1).padStart(2)}. ${stepTitle(step)}  [${step.kind}]`);
    const io = `reads: ${step.consumes.length === 0 ? '—' : step.consumes.join(', ')}   defines: ${step.produces.length === 0 ? '—' : step.produces.join(', ')}`;
    lines.push(`      ${step.function}()${step.module === undefined ? '' : `  ${step.module}`}`);
    lines.push(`      ${io}`);
    lines.push(`      calls: ${callNames(step, map.functions)}`);
  });
  const arrows = endpoint.edges.filter((edge) => edge.kind !== 'error');
  if (arrows.length > 0) {
    lines.push('');
    lines.push('Arrows');
    for (const edge of arrows) {
      lines.push(`  ${edge.from} → ${edge.to}${edge.label === undefined ? '' : `  (${edge.label})`}${edge.kind === 'branch' ? '  [branch]' : ''}`);
    }
  }
  lines.push('');
  lines.push(`explain ${endpoint.id}/<step> shows the functions of a step down to core.`);
  return `${lines.join('\n')}\n`;
}

/**
 * The tree of the functions some ids call, `depth` levels deep: each node is
 * the card, then its summary; a card already drawn is not expanded again.
 */
export function renderCallTree(
  ids: readonly string[],
  functions: Record<string, FunctionCard>,
  depth: number,
  prefix = '',
  drawn = new Set<string>(),
): string[] {
  const lines: string[] = [];
  ids.forEach((id, index) => {
    const last = index === ids.length - 1;
    const branch = `${prefix}${last ? '└─ ' : '├─ '}`;
    const continuation = `${prefix}${last ? '   ' : '│  '}`;
    const card = functions[id];
    if (card === undefined) {
      lines.push(`${branch}${id}`);
      return;
    }
    const again = drawn.has(id);
    lines.push(`${branch}${cardLine(card)}${again ? '  (above)' : ''}`);
    if (again) return;
    drawn.add(id);
    if (card.summary !== '') lines.push(`${continuation}   ${truncate(card.summary)}`);
    const details: string[] = [];
    if (card.spec !== undefined) details.push(`spec: ${card.spec.join(', ')}`);
    if (card.throws !== undefined) details.push(`throws: ${card.throws.join(', ')}`);
    if (details.length > 0) lines.push(`${continuation}   ${details.join('   ')}`);
    if (depth > 1 && card.calls.length > 0) {
      lines.push(...renderCallTree(card.calls, functions, depth - 1, continuation, drawn));
    }
  });
  return lines;
}

/** One step: its place in the endpoint, then its function and the tree of what it calls. */
export function renderStep(map: OpMap, endpoint: FlowEndpoint, step: FlowStep, depth: number): string {
  const lines: string[] = [];
  lines.push(stepTitle(step));
  lines.push(`  endpoint: ${methods(endpoint)} ${endpoint.path} (${endpoint.id})   kind: ${step.kind}   removable: ${step.removable ? 'yes' : 'no'}   ${flagOf(map, step.feature as string | undefined)}`);
  lines.push(`  reads: ${step.consumes.length === 0 ? '—' : step.consumes.join(', ')}   defines: ${step.produces.length === 0 ? '—' : step.produces.join(', ')}`);
  if (step.module !== undefined) lines.push(`  module: ${step.module}`);
  const position = endpoint.steps.findIndex((candidate) => candidate.id === step.id);
  const before = endpoint.steps[position - 1];
  const after = endpoint.steps[position + 1];
  lines.push(`  pipeline: ${before === undefined ? '(first)' : `[${before.id}]`} → [${step.id}] → ${after === undefined ? '(last)' : `[${after.id}]`}`);
  lines.push('');
  const card = step.functionId === undefined ? undefined : map.functions[step.functionId];
  if (card !== undefined) {
    lines.push(cardLine(card));
    if (card.summary !== '') lines.push(`   ${truncate(card.summary, 200)}`);
    if (card.spec !== undefined) lines.push(`   spec: ${card.spec.join(', ')}`);
    if (card.throws !== undefined) lines.push(`   throws: ${card.throws.join(', ')}`);
  } else {
    lines.push(`${step.function}()  (a block of ${step.module ?? 'the Route Handler'}, not a function of its own)`);
  }
  if (step.calls.length === 0 && (step.dynamicCalls ?? []).length === 0) {
    lines.push('   calls no function of the catalog');
  } else {
    lines.push(...renderCallTree(step.calls, map.functions, depth));
    for (const name of step.dynamicCalls ?? []) lines.push(`└─ ${name}  (dynamic: a method of a resolver or a store, or a hook)`);
  }
  return `${lines.join('\n')}\n`;
}

/** The step a card is used by, as one line: `⇐ step [id] of METHOD /path (flag)`. */
function useLine(map: OpMap, use: StepUse): string {
  const what = use.framework === 'nextjs' ? 'block' : 'step';
  const how = use.as === 'function' ? `the function of ${what}` : `called by ${what}`;
  const where = use.framework === undefined ? '' : `  [${use.framework}${use.step.module === undefined ? '' : ` ${use.step.module}`}]`;
  return `⇐ ${how} [${use.step.id}] of ${methods(use.endpoint)} ${use.endpoint.path}  (${flagOf(map, (use.step.feature ?? use.endpoint.feature) as string | undefined)})${where}`;
}

/**
 * The tree of the callers of a card, `depth` levels up, each caller with the
 * steps that use it; a caller that is the function of a step is not climbed
 * further (the step is where it is used).
 */
export function renderCallerTree(
  id: string,
  catalog: FunctionCatalog,
  uses: Map<string, StepUse[]>,
  map: OpMap,
  depth: number,
  prefix = '',
  seen = new Set<string>(),
): string[] {
  const lines: string[] = [];
  const card = catalog.functions[id];
  if (card === undefined) return lines;
  const callers = [...card.calledBy];
  callers.forEach((callerId, index) => {
    const caller = catalog.functions[callerId];
    if (caller === undefined) return;
    const last = index === callers.length - 1;
    const branch = `${prefix}${last ? '└─ ' : '├─ '}`;
    const continuation = `${prefix}${last ? '   ' : '│  '}`;
    const again = seen.has(callerId);
    lines.push(`${branch}← ${cardLine(caller)}${again ? '  (above)' : ''}`);
    if (again) return;
    seen.add(callerId);
    const stepUsesOfCaller = uses.get(callerId) ?? [];
    for (const use of stepUsesOfCaller) lines.push(`${continuation}   ${useLine(map, use)}`);
    const isStepFunction = stepUsesOfCaller.some((use) => use.as === 'function');
    if (!isStepFunction && depth > 1) {
      lines.push(...renderCallerTree(callerId, catalog, uses, map, depth - 1, continuation, seen));
    }
  });
  return lines;
}

export interface RenderFunctionOptions {
  /** How deep the tree of the calls goes (default 2). */
  depth: number;
  /** Draw the callers (the steps, endpoints and features the function is used from). */
  callers: boolean;
  /**
   * The flows with every feature, to say which step of which feature uses the
   * function: the one of the map's framework (or of the hono source), and the
   * Next.js one when no framework was given, since its blocks call functions
   * of their own.
   */
  everything: { flow: OpFlow; framework?: string }[];
}

/** One function: its card, the tree of what it calls, and (with callers) who calls it and from which steps. */
export function renderFunction(map: OpMap, catalog: FunctionCatalog, card: FunctionCard, options: RenderFunctionOptions): string {
  const lines: string[] = [];
  lines.push(`${cardLine(card)}${card.exported ? '  exported' : '  (not exported)'}`);
  if (card.summary !== '') lines.push(`   ${card.summary}`);
  if (card.description !== undefined) {
    for (const paragraph of card.description.split('\n\n')) lines.push(`   ${truncate(paragraph, 400)}`);
  }
  if (card.spec !== undefined) lines.push(`   spec: ${card.spec.join(', ')}`);
  if (card.throws !== undefined) lines.push(`   throws: ${card.throws.join(', ')}`);
  const uses = new Map<string, StepUse[]>();
  for (const { flow, framework } of options.everything) {
    for (const [id, found] of stepUses(flow, framework)) uses.set(id, [...(uses.get(id) ?? []), ...found]);
  }
  const own = uses.get(card.id) ?? [];
  if (own.length > 0) {
    lines.push('');
    lines.push('Steps');
    for (const use of own) lines.push(`   ${useLine(map, use)}`);
  }
  lines.push('');
  lines.push('Calls');
  if (card.calls.length === 0) lines.push('   no function of the catalog');
  else lines.push(...renderCallTree(card.calls, catalog.functions, options.depth));
  if (options.callers) {
    lines.push('');
    lines.push('Called by');
    if (card.calledBy.length === 0) lines.push('   no function of the catalog (an entry point, or called through a resolver, a store or a hook)');
    else lines.push(...renderCallerTree(card.id, catalog, uses, map, Math.max(options.depth, 4)));
  }
  return `${lines.join('\n')}\n`;
}
