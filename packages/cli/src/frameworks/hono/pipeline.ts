/**
 * Assemble a generated route module from the steps of its endpoint.
 *
 * The flow catalog (flow/catalog.ts) says which steps an endpoint has; the
 * fragments here say what each step looks like in the hono / express / fastify
 * output: the exported function, the pipeline statement that calls it, and
 * the imports it needs. The renderer puts them together in the order a
 * `--flow` document asks for (the catalog order by default), so one box of
 * `maronn-oidc graph` is always exactly one function of the generated file.
 */
import type { FlowEndpoint, FlowStep } from '../../flow/types.js';

/** The imports a fragment needs, by module. */
export interface StepImports {
  /** Names imported from the core package (`type X` for a type). */
  core?: string[];
  /** Names imported from '../resolvers.js' (`x as defaultX` is fine). */
  resolvers?: string[];
  /** Names imported from '../store.js'. */
  store?: string[];
  /** Names imported from '../config.js'. */
  config?: string[];
  /** Names imported from any other module, by specifier. */
  modules?: Record<string, string[]>;
}

/**
 * A pipeline statement that binds what the step produces, so the renderer
 * can drop the bindings nothing downstream reads (the generated projects
 * compile with noUnusedLocals).
 */
export interface BoundStepCall {
  /** Statements emitted before the binding, as they are. */
  before?: string;
  /** The produced value(s) to bind: a name for `const name =`, names for `const { a, b } =`. */
  bind: string | string[];
  /** The expression whose result is bound (with `await` when needed). */
  expression: string;
  /** Statements emitted after the binding, as they are. */
  after?: string;
}

/** What one step contributes to the generated module. */
export interface StepFragment {
  imports?: StepImports;
  /** The exported function, doc comment included. */
  definition: string;
  /**
   * The pipeline statement(s) calling the function. A string is emitted as it
   * is; '' when another step's call covers this one (a branch, a called step).
   */
  call: string | BoundStepCall;
  /**
   * When the step is left out by `--flow`: the statement defining each of its
   * produced values with a default, by value. Only the values a kept step
   * reads are emitted.
   */
  otherwise?: Record<string, string>;
}

export interface PipelineRouteOptions {
  endpoint: FlowEndpoint;
  fragments: Record<string, StepFragment>;
  /** The step ids to generate, in order (default: every step of the endpoint, in catalog order). */
  selection?: string[];
  corePkg: string;
  /** Imports the module needs whatever its steps are. */
  fixedImports: StepImports & { hono?: boolean };
  /** Module doc comment, shared types, settings: after the imports, before the step functions. */
  header: string;
  /** Opens the handler, up to where the step calls go. */
  handlerOpen: string;
  /** Closes the handler (the catch, the route registration). */
  handlerClose: string;
}

/** Merge import lists, keeping the first occurrence of each name. */
function mergeNames(target: string[], names: readonly string[] | undefined): void {
  for (const name of names ?? []) {
    if (!target.includes(name)) target.push(name);
  }
}

/** A `type X` import beside an `X` import would be a duplicate: keep the value import. */
function dropShadowedTypeImports(names: string[]): string[] {
  const values = new Set(names.filter((n) => !n.startsWith('type ')));
  return names.filter((n) => !n.startsWith('type ') || !values.has(n.slice('type '.length)));
}

function renderImport(names: readonly string[], from: string): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `import { ${names[0]} } from '${from}';\n`;
  return `import {\n${names.map((n) => `  ${n},`).join('\n')}\n} from '${from}';\n`;
}

/** Render every import of the module from the fixed imports and the selected fragments. */
export function renderStepImports(
  corePkg: string,
  fixed: StepImports & { hono?: boolean },
  fragments: readonly StepFragment[],
): string {
  const core: string[] = [];
  const resolvers: string[] = [];
  const store: string[] = [];
  const config: string[] = [];
  const modules = new Map<string, string[]>();
  const add = (imports: StepImports | undefined): void => {
    if (imports === undefined) return;
    mergeNames(core, imports.core);
    mergeNames(resolvers, imports.resolvers);
    mergeNames(store, imports.store);
    mergeNames(config, imports.config);
    for (const [specifier, names] of Object.entries(imports.modules ?? {})) {
      const list = modules.get(specifier) ?? [];
      mergeNames(list, names);
      modules.set(specifier, list);
    }
  };
  add(fixed);
  for (const fragment of fragments) add(fragment.imports);
  let out = fixed.hono ? "import { Hono } from 'hono';\n" : '';
  out += renderImport(dropShadowedTypeImports(core), corePkg);
  out += renderImport(dropShadowedTypeImports(resolvers), '../resolvers.js');
  out += renderImport(dropShadowedTypeImports(store), '../store.js');
  out += renderImport(dropShadowedTypeImports(config), '../config.js');
  for (const [specifier, names] of modules) {
    out += renderImport(dropShadowedTypeImports(names), specifier);
  }
  return out;
}

/** The step ids in generation order: the selection, or the catalog order. */
function orderedSteps(endpoint: FlowEndpoint, selection: string[] | undefined): FlowStep[] {
  if (selection === undefined) return endpoint.steps;
  const byId = new Map(endpoint.steps.map((s) => [s.id, s]));
  return selection.map((id) => {
    const step = byId.get(id);
    if (step === undefined) {
      throw new Error(`Endpoint "${endpoint.id}" has no step "${id}"`);
    }
    return step;
  });
}

function fragmentOf(endpoint: FlowEndpoint, fragments: Record<string, StepFragment>, step: FlowStep): StepFragment {
  const fragment = fragments[step.id];
  if (fragment === undefined) {
    throw new Error(`No code fragment for step "${step.id}" of endpoint "${endpoint.id}"`);
  }
  return fragment;
}

/** One-line header the renderer puts above every pipeline statement. */
function callComment(step: FlowStep): string {
  return `    // [${step.id}] ${step.label}${step.spec === undefined ? '' : ` — ${step.spec}`}`;
}

function renderBoundCall(call: BoundStepCall, needed: ReadonlySet<string>): string {
  const lines: string[] = [];
  if (call.before !== undefined && call.before !== '') lines.push(call.before);
  const names = Array.isArray(call.bind) ? call.bind.filter((n) => needed.has(n)) : call.bind;
  if (Array.isArray(names)) {
    lines.push(
      names.length === 0
        ? `    ${call.expression};`
        : `    const { ${names.join(', ')} } = ${call.expression};`,
    );
  } else {
    lines.push(needed.has(names) ? `    const ${names} = ${call.expression};` : `    ${call.expression};`);
  }
  if (call.after !== undefined && call.after !== '') lines.push(call.after);
  return lines.join('\n');
}

/**
 * Render the route module: imports, header, one exported function per selected
 * step (catalog order), and the handler whose body calls them in selection
 * order. Values a removed step would have produced are defined with the
 * step's `otherwise` defaults when a kept step reads them.
 */
export function renderPipelineRoute(options: PipelineRouteOptions): string {
  const { endpoint, fragments } = options;
  const selected = orderedSteps(endpoint, options.selection);
  const selectedIds = new Set(selected.map((s) => s.id));
  const selectedFragments = selected.map((s) => fragmentOf(endpoint, fragments, s));

  const imports = renderStepImports(options.corePkg, options.fixedImports, selectedFragments);
  const definitions = endpoint.steps
    .filter((s) => selectedIds.has(s.id))
    .map((s) => fragmentOf(endpoint, fragments, s).definition.trim())
    .join('\n\n');

  // What each kept step reads, so bindings and fallbacks nothing uses are left out.
  const consumedAfter = (index: number): Set<string> => {
    const needed = new Set<string>();
    for (const later of selected.slice(index + 1)) {
      for (const value of later.consumes) needed.add(value);
    }
    return needed;
  };
  const consumedByAny = consumedAfter(-1);

  const fallbacks: string[] = [];
  for (const step of endpoint.steps) {
    if (selectedIds.has(step.id)) continue;
    const otherwise = fragments[step.id]?.otherwise;
    if (otherwise === undefined) continue;
    for (const [value, statement] of Object.entries(otherwise)) {
      if (consumedByAny.has(value)) fallbacks.push(`    ${statement}`);
    }
  }

  const calls: string[] = [];
  selected.forEach((step, index) => {
    const fragment = fragmentOf(endpoint, fragments, step);
    if (typeof fragment.call === 'string') {
      if (fragment.call.trim() === '') return;
      calls.push(`${callComment(step)}\n${fragment.call.trimEnd()}`);
      return;
    }
    calls.push(`${callComment(step)}\n${renderBoundCall(fragment.call, consumedAfter(index))}`);
  });

  const body = [...(fallbacks.length > 0 ? [fallbacks.join('\n')] : []), ...calls].join('\n\n');
  return `${imports}\n${options.header.trim()}\n\n${definitions}\n\n${options.handlerOpen.trimEnd()}\n${body}\n${options.handlerClose.replace(/^\n+/, '')}`;
}
