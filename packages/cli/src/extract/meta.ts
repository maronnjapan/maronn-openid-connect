/**
 * The descriptions the apps give of their steps and endpoints — the `meta` of
 * every steps/<id>.ts (step({...})), the `endpoint` of every endpoint.ts
 * (defineEndpoint({...})) and the `contribution` of a feature that adds to a
 * step of the base (contribute({...})) — read from the source text.
 *
 * The arguments of those calls are literals (strings, numbers, booleans,
 * arrays and objects of them), so they are read by evaluating the literal on
 * its own, without importing the module. `maronn-oidc graph`, the checks of
 * `--flow` and the removal of owner blocks all work from these descriptions.
 */

export type StepKind =
  | 'parse'
  | 'resolve'
  | 'validate'
  | 'decide'
  | 'dispatch'
  | 'issue'
  | 'persist'
  | 'transform'
  | 'respond';

export interface StepMeta {
  id: string;
  endpoint: string;
  feature?: string;
  kind: StepKind;
  label: string;
  spec?: string;
  function: string;
  calls?: string[];
  consumes: string[];
  optional?: string[];
  produces: string[];
  removable: boolean;
  fallback?: boolean;
  after?: string[];
  before?: string[];
  calledFrom?: string[];
}

export interface EdgeMeta {
  from: string;
  to: string;
  label?: string;
  kind: 'flow' | 'branch' | 'error';
}

export interface JourneyMeta extends EdgeMeta {
  order: number;
}

export interface EndpointEdges {
  chain: boolean;
  off?: string[];
  forks?: Array<{ at: string; branches: Array<{ step: string; label: string }> }>;
  fromKind?: Array<{ kind: StepKind; to: string; label: string }>;
  extra?: EdgeMeta[];
}

export interface EndpointMeta {
  id: string;
  order: number;
  label: string;
  path: string;
  methods: string[];
  layer: 'api' | 'browser' | 'metadata';
  group: { id: string; label: string };
  spec?: string;
  feature?: string;
  rearrangeable: boolean;
  initial?: string[];
  steps: string[];
  errorStep?: string;
  edges: EndpointEdges;
  journeys?: JourneyMeta[];
}

export interface StepContribution {
  endpoint: string;
  step: string;
  feature: string;
  calls?: string[];
  consumes?: string[];
  spec?: string;
}

/** The literal argument of the first call of callee in source, as text; undefined without one. */
export function literalArgumentOf(source: string, callee: string): string | undefined {
  const match = new RegExp(`\\b${callee}\\(\\s*\\{`).exec(source);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (const { char, index } of codeOf(source, start)) {
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated ${callee}({...}) literal`);
}

/** Evaluate an object literal made of literals only. */
export function evaluateLiteral(literal: string): unknown {
  // A literal of literals has no call, no arrow and no template: anything
  // else would run code of the source while reading it.
  const code = [...codeOf(literal, 0)].map(({ char }) => char).join('');
  if (/[()`]|=>/.test(code)) {
    throw new Error(`Not a plain literal: ${literal.slice(0, 80)}`);
  }
  return new Function(`"use strict"; return (${literal});`)();
}

/**
 * The characters of the source from start on that are code: neither inside a
 * string ('…', "…") nor inside a comment (// … and /* … *\/). A template
 * literal counts as code, so evaluateLiteral() refuses it.
 */
function* codeOf(source: string, start: number): Generator<{ char: string; index: number }> {
  let quote: string | undefined;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end - 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    yield { char, index };
  }
}

/** The step meta of a steps/<id>.ts source, or undefined when it has none. */
export function readStepMeta(source: string): StepMeta | undefined {
  const literal = literalArgumentOf(source, 'step');
  return literal === undefined ? undefined : (evaluateLiteral(literal) as StepMeta);
}

export function readEndpointMeta(source: string): EndpointMeta | undefined {
  const literal = literalArgumentOf(source, 'defineEndpoint');
  return literal === undefined ? undefined : (evaluateLiteral(literal) as EndpointMeta);
}

export function readContribution(source: string): StepContribution | undefined {
  const literal = literalArgumentOf(source, 'contribute');
  return literal === undefined ? undefined : (evaluateLiteral(literal) as StepContribution);
}

/**
 * The descriptions of one framework's source: the steps (with the source file
 * each comes from), the endpoints and the contributions.
 */
export interface SourceCatalog {
  /** Every file of the root, so a module path can be checked. */
  files: string[];
  steps: Array<StepMeta & { file: string }>;
  endpoints: Array<EndpointMeta & { file: string }>;
  contributions: Array<StepContribution & { file: string }>;
}

/** Read the catalog of a set of source files (path relative to the extraction root → text). */
export function buildSourceCatalog(files: ReadonlyMap<string, string>): SourceCatalog {
  const catalog: SourceCatalog = { files: [...files.keys()].sort(), steps: [], endpoints: [], contributions: [] };
  for (const [file, source] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (/(^|\/)steps\/[^/]+\.tsx?$/.test(file)) {
      const meta = readStepMeta(source);
      if (meta) catalog.steps.push({ ...meta, file });
    } else if (/(^|\/)endpoint\.ts$/.test(file)) {
      const meta = readEndpointMeta(source);
      if (meta) catalog.endpoints.push({ ...meta, file });
    }
    if (/\bcontribute\(\s*\{/.test(source) && !/(^|\/)step\.ts$/.test(file)) {
      const contribution = readContribution(source);
      if (contribution) catalog.contributions.push({ ...contribution, file });
    }
  }
  return catalog;
}
