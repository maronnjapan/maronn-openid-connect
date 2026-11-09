/**
 * What the analysis takes from the built CLI (packages/cli/dist): the
 * function catalog, the flow of a generation with every feature on, the
 * features of the registry, the frameworks, and how comments are joined.
 *
 * The CLI publishes only its command line, so the modules are loaded by path
 * (as the map always did). Their shapes are the ones of model.ts.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FunctionKind, MapCommand, MapFeature, OpFlow } from './model.js';
import type { ExtractionDefinition } from './roots.js';

/** A card of the function catalog (packages/cli/src/extract/functions.ts). */
export interface CatalogCard {
  id: string;
  name: string;
  package: string;
  module: string;
  line: number;
  exported: boolean;
  kind: FunctionKind;
  summary: string;
  description?: string;
  spec?: string[];
  throws?: string[];
  calls: string[];
  calledBy: string[];
}

export interface Cli {
  /** The root of the CLI package. */
  packageRoot: string;
  definition: ExtractionDefinition;
  catalog: Record<string, CatalogCard>;
  frameworks: string[];
  commands: MapCommand[];
  features: MapFeature[];
  /** The flow of each framework with every feature on, its endpoints and steps naming their modules. */
  flows: Record<string, Omit<OpFlow, 'endpoints'> & { endpoints: Array<Omit<OpFlow['endpoints'][number], 'root'>> }>;
  /** Feature key (refreshToken) → id (refresh-token). */
  featureIds: Record<string, string>;
  joinLines(lines: readonly string[]): string;
  joinLinesFlat(lines: readonly string[]): string;
  /** The specification references a text names, each once, normalized as the catalog writes them (`RFC 6749 §5.2`). */
  specReferencesOf(text: string): string[];
  /** The same owner-block boundaries the generator removes when a feature is off. */
  parseOwnerBlocks(text: string): Array<{ feature: string | undefined; startLine: number; endLine: number }>;
  /** Read the catalog of other roots (the files of a revision): analyzeFunctions of the CLI. */
  analyzeFunctions(roots: Array<{ name: string; specifier?: string; files: ReadonlyMap<string, string> }>): { catalog: { functions: Record<string, CatalogCard> } };
}

/** Load the built CLI; throws when it is not built. */
export async function loadCli(cliDist: string): Promise<Cli> {
  if (!existsSync(join(cliDist, 'index.js'))) {
    throw new Error(`packages/cli is not built (${cliDist}): run pnpm --filter @maronn-openid-connect/cli build first`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const load = async (file: string): Promise<any> => import(pathToFileURL(join(cliDist, file)).href);
  const { buildOpFlow } = await load('flow/build.js');
  const { annotateFlowModules } = await load('flow/modules.js');
  const { buildOpMap } = await load('explain/map.js');
  const { PACKAGE_ROOT, functionProject, readExtractionDefinition } = await load('extract/templates.js');
  const { analyzeFunctions, specReferencesOf } = await load('extract/functions.js');
  const { joinLines, joinLinesFlat } = await load('extract/prose.js');
  const { parseOwnerBlocks } = await load('extract/source.js');
  const { FEATURE_CONFIG_KEYS, FEATURE_REGISTRY, featureKeyOf } = await load('registry.js');
  const { getAvailableFrameworks } = await load('generator.js');
  const features = Object.fromEntries((FEATURE_CONFIG_KEYS as string[]).map((key) => [key, true]));
  const project = functionProject();
  const frameworks = getAvailableFrameworks() as string[];
  const flows: Cli['flows'] = {};
  let shared: { commands: MapCommand[]; features: MapFeature[] } | undefined;
  for (const framework of frameworks) {
    const flow = annotateFlowModules(buildOpFlow({ features }), framework);
    const map = buildOpMap({ flow, framework, functions: project.catalog, frameworks });
    flows[framework] = map.flow;
    shared ??= { commands: map.commands, features: map.features };
  }
  const featureIds: Record<string, string> = {};
  for (const entry of FEATURE_REGISTRY as Array<{ id: string }>) featureIds[featureKeyOf(entry.id) as string] = entry.id;
  return {
    packageRoot: PACKAGE_ROOT as string,
    definition: readExtractionDefinition() as ExtractionDefinition,
    catalog: project.catalog.functions as Record<string, CatalogCard>,
    frameworks,
    commands: shared?.commands ?? [],
    features: shared?.features ?? [],
    flows,
    featureIds,
    joinLines,
    joinLinesFlat,
    specReferencesOf,
    parseOwnerBlocks,
    analyzeFunctions,
  };
}
