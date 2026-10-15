/**
 * Read a flow document (`--flow <file>`) back into what `generate` needs.
 *
 * The document is the JSON `maronn-oidc graph --format json` writes, possibly
 * edited: endpoints reordered or removed, steps of a rearrangeable endpoint
 * reordered or left out. Everything the document says is checked against the
 * catalog built from its own features, so a generation never silently drops a
 * step another step depends on.
 */
import { resolveDbKind, type DbKind } from '../db.js';
import { normalizeFeatures, type OidcFeatureConfig } from '../features.js';
import { resolveCustomScopes } from '../scopes.js';
import { buildOpFlow } from './catalog.js';
import type { FlowEdge, FlowEndpoint, FlowStep, OpFlow } from './types.js';

/** What a flow document selects for a generation. */
export interface FlowSelection {
  features: OidcFeatureConfig;
  scopes: string[];
  db: DbKind | undefined;
  /** Every endpoint of the configuration, in the order of the document (the mount order). */
  endpointOrder: string[];
  /**
   * The ordered step ids of each rearrangeable endpoint whose steps differ
   * from the catalog. An endpoint that keeps the catalog's steps is absent.
   */
  steps: Record<string, string[]>;
}

/** Thrown for a document that cannot be generated from; the message names what is wrong. */
export class FlowFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowFileError';
  }
}

function fail(message: string): never {
  throw new FlowFileError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A step entry is either its id or an object with an id (the JSON `graph` writes). */
function readId(entry: unknown, where: string): string {
  if (typeof entry === 'string') return entry;
  if (isRecord(entry) && typeof entry['id'] === 'string') return entry['id'];
  return fail(`${where} must be an id or an object with an "id"`);
}

function readIdList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) return fail(`${where} must be an array`);
  const ids = value.map((entry, index) => readId(entry, `${where}[${index}]`));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return fail(`${where} lists "${id}" twice`);
    seen.add(id);
  }
  return ids;
}

function featureName(feature: keyof OidcFeatureConfig): string {
  return `features.${feature}`;
}

/** Check the step list of one rearrangeable endpoint and return it when it differs from the catalog. */
function selectSteps(endpoint: FlowEndpoint, requested: string[]): string[] | undefined {
  const catalog = new Map(endpoint.steps.map((s) => [s.id, s]));
  const where = `endpoint "${endpoint.id}"`;
  for (const id of requested) {
    if (!catalog.has(id)) {
      fail(
        `${where} has an unknown step "${id}". Steps of this endpoint: ${endpoint.steps.map((s) => s.id).join(', ')}`,
      );
    }
  }
  const selected = new Set(requested);
  for (const step of endpoint.steps) {
    if (selected.has(step.id)) continue;
    if (step.calledFrom !== undefined) {
      const callers = step.calledFrom.filter((caller) => selected.has(caller));
      if (callers.length > 0) {
        fail(`${where} leaves out step "${step.id}", which step ${callers.map((c) => `"${c}"`).join(' and ')} calls`);
      }
      continue;
    }
    // A removable step may be left out whatever generates it; a fixed step of a
    // feature goes away with the feature, not with the step.
    if (step.removable) continue;
    if (step.feature !== undefined) {
      fail(
        `${where} leaves out step "${step.id}", which the feature ${featureName(step.feature)} generates. ` +
          `Set ${featureName(step.feature)} to false to leave the feature out`,
      );
    }
    fail(`${where} leaves out step "${step.id}", which cannot be removed`);
  }

  // Data flow: every value a kept step reads must be produced before it, or be a
  // value the pipeline falls back to when the producing step was removed.
  const fallbackValues = new Set<string>();
  for (const step of endpoint.steps) {
    if (!selected.has(step.id) && step.removable && step.fallback) {
      for (const value of step.produces) fallbackValues.add(value);
    }
  }
  const available = new Set<string>([...(endpoint.initial ?? []), ...fallbackValues]);
  const position = new Map(requested.map((id, index) => [id, index]));
  for (const id of requested) {
    const step = catalog.get(id) as FlowStep;
    if (step.calledFrom !== undefined) continue;
    for (const value of step.consumes) {
      if (!available.has(value)) {
        const producers = endpoint.steps.filter((s) => s.produces.includes(value)).map((s) => `"${s.id}"`);
        fail(
          `${where}: step "${id}" reads "${value}", which no earlier step produces` +
            (producers.length > 0 ? ` (produced by ${producers.join(', ')})` : ''),
        );
      }
    }
    for (const value of step.produces) available.add(value);
  }
  for (const id of requested) {
    const step = catalog.get(id) as FlowStep;
    const index = position.get(id) as number;
    for (const other of step.after ?? []) {
      const otherIndex = position.get(other);
      if (otherIndex !== undefined && otherIndex > index) {
        fail(`${where}: step "${id}" must come after step "${other}"`);
      }
    }
    for (const other of step.before ?? []) {
      const otherIndex = position.get(other);
      if (otherIndex !== undefined && otherIndex < index) {
        fail(`${where}: step "${id}" must come before step "${other}"`);
      }
    }
  }

  const catalogOrder = endpoint.steps.filter((s) => s.calledFrom === undefined).map((s) => s.id);
  const requestedOrder = requested.filter((id) => (catalog.get(id) as FlowStep).calledFrom === undefined);
  const unchanged =
    requestedOrder.length === catalogOrder.length && requestedOrder.every((id, i) => id === catalogOrder[i]);
  return unchanged ? undefined : requested;
}

/**
 * Resolve a parsed flow document into a FlowSelection.
 *
 * @throws {FlowFileError} when the document is not a flow document, names
 *   something the catalog does not have, or rearranges steps in a way the
 *   generated code could not run.
 */
export function resolveFlowSelection(document: unknown): FlowSelection {
  if (!isRecord(document)) return fail('A flow document must be a JSON object');
  if (document['version'] !== 1) return fail('A flow document must have "version": 1');

  let features: OidcFeatureConfig;
  let scopes: string[];
  let db: DbKind | undefined;
  try {
    features = normalizeFeatures(document['features'] ?? {});
    const rawScopes = document['scopes'] ?? [];
    if (!Array.isArray(rawScopes) || rawScopes.some((s) => typeof s !== 'string')) {
      return fail('scopes must be an array of strings');
    }
    scopes = rawScopes.length > 0 ? resolveCustomScopes({ scope: rawScopes as string[] }) : [];
    const rawDb = document['db'];
    if (rawDb !== undefined && rawDb !== null && typeof rawDb !== 'string') {
      return fail('db must be "sql", "kv" or null');
    }
    db = rawDb === undefined || rawDb === null ? undefined : resolveDbKind(rawDb);
  } catch (error) {
    if (error instanceof FlowFileError) throw error;
    return fail(error instanceof Error ? error.message : String(error));
  }

  const flow: OpFlow = buildOpFlow({ features, scopes, db });
  const catalogEndpoints = new Map(flow.endpoints.map((e) => [e.id, e]));
  const rawEndpoints = document['endpoints'];
  if (!Array.isArray(rawEndpoints)) return fail('endpoints must be an array');
  const endpointOrder = readIdList(rawEndpoints, 'endpoints');
  for (const id of endpointOrder) {
    if (!catalogEndpoints.has(id)) {
      fail(
        `Unknown endpoint "${id}". Endpoints of this configuration: ${flow.endpoints.map((e) => e.id).join(', ')}`,
      );
    }
  }
  for (const endpoint of flow.endpoints) {
    if (endpointOrder.includes(endpoint.id)) continue;
    if (endpoint.feature === undefined) {
      fail(`Endpoint "${endpoint.id}" (${endpoint.path}) is required and cannot be left out`);
    }
    fail(
      `Endpoint "${endpoint.id}" (${endpoint.path}) is generated by ${featureName(endpoint.feature)}. ` +
        `Set ${featureName(endpoint.feature)} to false to leave it out`,
    );
  }

  const steps: Record<string, string[]> = {};
  rawEndpoints.forEach((entry, index) => {
    if (!isRecord(entry) || entry['steps'] === undefined) return;
    const id = endpointOrder[index] as string;
    const endpoint = catalogEndpoints.get(id) as FlowEndpoint;
    const requested = readIdList(entry['steps'], `endpoints[${index}].steps`);
    if (!endpoint.rearrangeable) {
      const expected = endpoint.steps.map((s) => s.id);
      const same = requested.length === expected.length && requested.every((s, i) => s === expected[i]);
      if (!same) {
        fail(
          `endpoint "${id}" has a fixed sequence of steps: ${expected.join(', ')}. ` +
            'Its steps cannot be removed or reordered',
        );
      }
      return;
    }
    const selection = selectSteps(endpoint, requested);
    if (selection !== undefined) steps[id] = selection;
  });

  return { features, scopes, db, endpointOrder, steps };
}

/** Parse the text of a flow file and resolve it (see resolveFlowSelection). */
export function parseFlowFile(text: string, fileName: string): FlowSelection {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return fail(`${fileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return resolveFlowSelection(document);
  } catch (error) {
    if (error instanceof FlowFileError) {
      throw new FlowFileError(`${fileName}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Apply a selection to the flow it was resolved against: endpoints in the
 * document's order, steps of a rearranged endpoint in the document's order,
 * and the arrows of a removed step contracted onto its neighbours so the
 * diagram of the rearranged OP still connects.
 */
export function applyFlowSelection(flow: OpFlow, selection: FlowSelection): OpFlow {
  const byId = new Map(flow.endpoints.map((e) => [e.id, e]));
  const endpoints = selection.endpointOrder.map((id) => {
    const endpoint = byId.get(id);
    if (endpoint === undefined) throw new Error(`Unknown endpoint "${id}"`);
    const order = selection.steps[id];
    if (order === undefined) return endpoint;
    const stepsById = new Map(endpoint.steps.map((s) => [s.id, s]));
    const steps = order.map((stepId) => {
      const step = stepsById.get(stepId);
      if (step === undefined) throw new Error(`Unknown step "${stepId}" of endpoint "${id}"`);
      return step;
    });
    const removed = endpoint.steps.filter((s) => !order.includes(s.id)).map((s) => s.id);
    return { ...endpoint, steps, edges: contractRemovedSteps(endpoint.edges, removed) };
  });
  return { ...flow, endpoints };
}

/** Drop the arrows of removed steps, joining each predecessor to each successor. */
function contractRemovedSteps(edges: FlowEdge[], removed: string[]): FlowEdge[] {
  let result = edges;
  for (const id of removed) {
    const incoming = result.filter((e) => e.to === id && e.kind !== 'error');
    const outgoing = result.filter((e) => e.from === id && e.kind !== 'error');
    const bridged: FlowEdge[] = [];
    for (const into of incoming) {
      for (const out of outgoing) {
        const bridge: FlowEdge = { from: into.from, to: out.to, kind: into.kind === 'branch' ? 'branch' : out.kind };
        if (into.label !== undefined) bridge.label = into.label;
        else if (out.label !== undefined) bridge.label = out.label;
        if (!result.some((e) => e.from === bridge.from && e.to === bridge.to && e.kind === bridge.kind)) {
          bridged.push(bridge);
        }
      }
    }
    result = [...result.filter((e) => e.from !== id && e.to !== id), ...bridged];
  }
  return result;
}
