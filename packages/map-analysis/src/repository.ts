/**
 * The working tree of the repository read for the map: the CLI's catalog and
 * flows, the roots, and the revision of every frame (analyze.ts).
 */
import { join } from 'node:path';
import { loadCli, type Cli } from './cli.js';
import type { StepMark } from './model.js';
import { readRoots, type AnalysisRoot } from './roots.js';
import { catalogModules, readRevision, type EndpointSource, type Revision } from './analyze.js';

export interface Repository {
  repository: string;
  cli: Cli;
  roots: AnalysisRoot[];
  endpoints: EndpointSource[];
  /** The step each function of a step of Hono is, by function id. */
  steps: Map<string, StepMark>;
  head: Revision;
}

/** The endpoints of the flows by the source they are generated from: hono (Hono, Express, Fastify) and nextjs. */
export function endpointSources(cli: Cli): EndpointSource[] {
  const sources = new Map<string, EndpointSource>();
  for (const framework of cli.frameworks) {
    const definition = cli.definition.frameworks[framework];
    const flow = cli.flows[framework];
    if (definition === undefined || flow === undefined) continue;
    const known = sources.get(definition.source);
    if (known !== undefined) {
      known.frameworks.push(framework);
      continue;
    }
    sources.set(definition.source, { source: definition.source, directory: definition.root, layout: definition.layout, frameworks: [framework], endpoints: flow.endpoints });
  }
  return [...sources.values()];
}

/** The step of each function that is a step of Hono (`hono:oidc-provider/endpoints/token/steps/parse-request.ts#parseTokenRequest`). */
export function stepMarks(cli: Cli): Map<string, StepMark> {
  const steps = new Map<string, StepMark>();
  for (const flow of Object.values(cli.flows)) {
    for (const endpoint of flow.endpoints) {
      for (const step of endpoint.steps) {
        if (step.functionId === undefined || steps.has(step.functionId)) continue;
        const feature = step.feature === undefined ? undefined : (cli.featureIds[step.feature] ?? step.feature);
        steps.set(step.functionId, { id: step.id, label: step.label, ...(feature === undefined ? {} : { feature }), ...(step.spec === undefined ? {} : { spec: step.spec }) });
      }
    }
  }
  return steps;
}

/** Read the working tree (see the module comment). */
export async function readRepository(repository: string, cliDist = join(repository, 'packages/cli/dist')): Promise<Repository> {
  const cli = await loadCli(cliDist);
  const roots = readRoots(repository, cli.definition);
  const endpoints = endpointSources(cli);
  const steps = stepMarks(cli);
  const head = readRevision({
    repository,
    roots,
    files: catalogModules(Object.values(cli.catalog)),
    endpoints,
    summaryOf: (id) => cli.catalog[id]?.summary,
    stepOf: (id) => steps.get(id),
    joinLines: cli.joinLines,
    joinLinesFlat: cli.joinLinesFlat,
  });
  return { repository, cli, roots, endpoints, steps, head };
}
