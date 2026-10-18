#!/usr/bin/env node

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { generate, getAvailableFrameworks } from './generator.js';
import {
  AVAILABLE_FEATURES,
  EXPERIMENTAL_FEATURES,
  EXTENSION_FEATURES,
  resolveFeatures,
} from './registry.js';
import { enabledFeatureIds, findFeature, type OidcFeatureConfig } from './registry.js';
import type { GeneratedFile } from './generated-file.js';
import { resolveCustomScopes } from './scopes.js';
import { resolveDbKind, type DbKind } from './db.js';
import { buildOpFlow } from './flow/build.js';
import { renderMermaid, type MermaidDetail } from './flow/mermaid.js';
import { annotateFlowModules } from './flow/modules.js';
import { applyFlowSelection, parseFlowFile, type FlowSelection } from './flow/flow-file.js';
import type { OpFlow } from './flow/types.js';

// The screens of every output but Next.js are hono/jsx, so Express and
// Fastify need hono too (as the JSX runtime).
const INSTALL_COMMANDS: Record<string, string> = {
  hono: 'pnpm add hono @maronn-openid-connect/core',
  express: 'pnpm add express hono @maronn-openid-connect/core && pnpm add -D @types/express',
  fastify: 'pnpm add fastify hono @maronn-openid-connect/core',
  nextjs: 'pnpm add @maronn-openid-connect/core && pnpm add -D next react react-dom',
};

const EXPERIMENTAL_PACKAGE = '@maronn-openid-connect/experimental';
const GOOGLE_LOGIN_PACKAGE = '@maronn-openid-connect/google-login';

/** What the generated code of an output without --db keeps its data in, and how to change that. */
const MEMORY_STORES_STEP =
  'The data is kept in memory (db/): generate with --db sql or --db kv, or pass your own ProviderStores as storage';

/** The packages the code of the enabled features imports (packages of registry.ts), each once. */
function featurePackagesOf(features: OidcFeatureConfig): string[] {
  return [...new Set(enabledFeatureIds(features).flatMap((id) => findFeature(id)?.packages ?? []))];
}

/**
 * Insert the packages of the enabled features after @maronn-openid-connect/core.
 * Without a feature that needs a package the command is returned untouched.
 */
function withFeaturePackages(installCommand: string, features: OidcFeatureConfig): string {
  const packages = featurePackagesOf(features);
  if (packages.length === 0) return installCommand;
  return installCommand.replace('@maronn-openid-connect/core', ['@maronn-openid-connect/core', ...packages].join(' '));
}

const SETUP_UNSUPPORTED_FRAMEWORKS = new Set(['nextjs']);

/**
 * Manifest recording which CLI version and which inputs produced the output,
 * so a user can later diff their code against the release that generated it.
 * It is machine-written, never user-edited, so it is exempt from the overwrite
 * guard and refreshed on every (non-dry-run) generation.
 */
const MANIFEST_FILENAME = '.maronn-openid-connect.json';

// src/ and dist/ both sit one level below the package root, so ../package.json
// resolves to this package's own manifest from either build state.
const CLI_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

const IMPORT_PLACEHOLDER = '// <!-- OIDC_IMPORT_PLACEHOLDER -->';
const SETUP_PLACEHOLDER = '// <!-- OIDC_SETUP_PLACEHOLDER -->';
const APPLY_OIDC_CALL = 'applyOidc(app);';

/**
 * Framework-specific app construction line shown between the two placeholders in
 * the missing-placeholder error, so the example the user copies matches the
 * framework they ran `setup` for.
 */
const ENTRY_APP_EXAMPLES: Record<string, string> = {
  hono: 'const app = new Hono();',
  express: 'const app = express();',
  fastify: 'const app = Fastify();',
};
const DEFAULT_ENTRY_APP_EXAMPLE = 'const app = /* your framework app instance */;';

function printUsage(): void {
  const frameworks = getAvailableFrameworks().join(', ');
  const features = AVAILABLE_FEATURES.join(', ');
  const experimentalFeatures = EXPERIMENTAL_FEATURES.join(', ');
  const extensionFeatures = EXTENSION_FEATURES.join(', ');
  console.log(`
Usage: maronn-oidc <command> <framework> [options]

Commands:
  generate <framework>  Generate OIDC provider code for the specified framework
  setup <framework>     Generate OIDC provider code and apply it to an existing entry file
  graph [framework]     Draw the provider a generate run produces: its endpoints
                        (boxes), the steps inside each endpoint (one box per
                        generated function) and the arrows between them

Frameworks: ${frameworks}

Options:
  --output, -o <dir>    Output directory (default: ./oidc-provider); for graph, the
                        file to write instead of printing to stdout
  --entry, -e <file>    Entry file to patch with OIDC setup (setup command only, default: ./src/index.ts)
  --enable <features>   Comma-separated features to enable (repeatable)
  --disable <features>  Comma-separated features to remove from the default set (repeatable)
  --scope <scopes>      Comma-separated custom scopes the provider accepts (repeatable)
  --db <sql|kv>         Keep the provider's data in SQL tables (sql) or a key-value store (kv); you write db/instance.ts
  --flow <file>         Generate (or draw) from a flow document: the JSON that
                        \`graph --format json\` writes, possibly rearranged. Replaces
                        --enable / --disable / --scope / --db
  --format <mermaid|json>
                        graph only: Mermaid flowchart (default) or the JSON flow document
  --detail <endpoints|steps>
                        graph only: one box per endpoint (default), or the steps inside each
  --endpoint <ids>      graph only: comma-separated endpoint ids to draw (repeatable; default: all)
  --no-error-edges      graph only: leave out the dashed arrows into the error steps
  --force               Overwrite files that already exist in the output directory
  --dry-run             Show what would be written without writing anything
  --help, -h            Show this help message

Features (all enabled by default): ${features}

Experimental features (disabled by default): ${experimentalFeatures}
  Provided by the separate ${EXPERIMENTAL_PACKAGE} package. APIs are unstable
  and may change in a breaking way. Enable one with, e.g.: --enable par

Extension features (disabled by default): ${extensionFeatures}
  google-login (${GOOGLE_LOGIN_PACKAGE}): adds a "Sign in with Google" button to
  the login page and a POST /login/google callback that verifies the ID token
  Google posts there with Google's official google-auth-library. Node.js 22+
  only. Set config.googleLogin.clientId (the generated Next.js output and the
  samples read GOOGLE_CLIENT_ID) and register <issuer>/login/google as an
  authorized redirect URI of that Google OAuth client. Enable with:
  --enable google-login

Custom scopes (none declared by default): the standard scopes (openid, profile,
  email, address, phone, offline_access) are always handled by the generated
  provider. Declare anything else with --scope, e.g.:
    --scope reports.read,reports.write
  The declared scopes are advertised in scopes_supported, and a request for a
  value that was never declared is rejected with invalid_scope. Which End-User
  may be granted which scope is left to the generated code: scopes.ts holds
  resolveGrantableScopes(), already wired into consent, SSO, prompt=none and the
  device / CIBA approvals, as the one place to write that filtering.

Flow documents (graph / --flow): \`maronn-oidc graph --format json\` describes the
  provider as endpoints, steps and arrows, with the features, scopes and db of
  the run. Edit it (drop a removable step, reorder independent steps, reorder
  the endpoints, flip a feature flag) and generate from it with --flow <file>;
  what the document says is checked against the catalog, so a step another
  step depends on can never be dropped by accident. Screen endpoints (login,
  consent, device, ciba, logout) have a fixed sequence of steps. The generated
  pipelines follow a rearranged step order for hono, express and fastify;
  the Next.js output keeps its own layout and accepts endpoint and feature
  changes only.

Database (--db sql | --db kv): the provider keeps its clients, users,
  authorization transactions, codes, tokens, sessions and consent in your
  database instead of memory. Either kind generates db/ (_oidc-provider/db/
  for Next.js, whose --db kv instance.ts runs on Upstash Redis or node:sqlite
  as generated), where db/stores.ts,
  db/clients.ts and db/users.ts read and write the data; the records of Sign
  in with Google come with --enable google-login. Register clients with
  registerClient() in db/clients.ts and users with registerUser() in
  db/users.ts. The one file you write is db/instance.ts: createDatabase()
  returns your database. The CLI creates it only when it is missing and never
  overwrites it, even with --force.

  --db sql: SQL tables. db/schema.sql defines them (the same SQL runs on
  SQLite, Cloudflare D1 and PostgreSQL), and createDatabase() wraps whichever
  driver or ORM you use in two methods that each run one statement.

  --db kv: a key-value store. db/keys.ts lays out the keys, and
  createDatabase() wraps your store in get, set, setIfAbsent and delete.
  setIfAbsent must be atomic (Redis SET NX, for one) and a read must see the
  writes before it, which Cloudflare Workers KV does not guarantee: use D1
  (--db sql) on Cloudflare.
`);
}

/** What --db generated, printed after generation, and the next step it leaves to the user. */
function dbGuidance(db: DbKind, dbDir: string, framework?: string): { summary: string; step: string } {
  const registerFunctions = `registerClient() (${dbDir}/clients.ts) and registerUser() (${dbDir}/users.ts)`;
  const registration = `register clients and users with ${registerFunctions}`;
  if (db === 'kv' && framework === 'nextjs') {
    return {
      summary:
        `Key-value store (--db kv): the provider keeps its data under the keys of ${dbDir}/keys.ts.\n` +
        `${dbDir}/instance.ts runs on Upstash Redis (UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)\n` +
        'or on node:sqlite; that file is yours and is never overwritten. The provider reads its clients\n' +
        `and users from the store: register them with ${registerFunctions}.\n`,
      step: `Register clients and users with ${registerFunctions}`,
    };
  }
  if (db === 'kv') {
    return {
      summary:
        `Key-value store (--db kv): the provider keeps its data under the keys of ${dbDir}/keys.ts.\n` +
        `Write createDatabase() in ${dbDir}/instance.ts (examples inside); that file is yours and is\n` +
        'never overwritten. Its setIfAbsent() must be atomic. The provider reads its clients and users\n' +
        `from the store: register them with ${registerFunctions}.\n`,
      step: `Write createDatabase() in ${dbDir}/instance.ts for your key-value store and ${registration}`,
    };
  }
  return {
    summary:
      `Database (--db sql): the provider keeps its data in the SQL tables of ${dbDir}/schema.sql.\n` +
      `Write createDatabase() in ${dbDir}/instance.ts (examples inside); that file is yours and is\n` +
      'never overwritten. The provider reads its clients and users from the tables: register them\n' +
      `with ${registerFunctions}.\n`,
    step: `Write createDatabase() in ${dbDir}/instance.ts, apply ${dbDir}/schema.sql to your database and ${registration}`,
  };
}

interface ParsedArgs {
  command?: string;
  framework?: string;
  /** --output; undefined when not given (generate defaults to ./oidc-provider, graph to stdout). */
  outputDir: string | undefined;
  entryFile: string;
  enable: string[];
  disable: string[];
  scope: string[];
  /** undefined without --db, null for --db without a kind. */
  db: string | null | undefined;
  /** --flow <file>; null for --flow without a file. */
  flow: string | null | undefined;
  /** graph: --format; null for --format without a value. */
  format: string | null | undefined;
  /** graph: --detail; null for --detail without a value. */
  detail: string | null | undefined;
  /** graph: --endpoint ids (raw, comma-separated). */
  endpoint: string[];
  /** graph: --no-error-edges. */
  errorEdges: boolean;
  force: boolean;
  dryRun: boolean;
  help: boolean;
}

/** The value after a flag, or null when the next word is another flag (or nothing). */
function flagValue(args: string[], index: number): string | null {
  const value = args[index + 1];
  return value === undefined || value.startsWith('-') ? null : value;
}

function parseArgs(args: string[]): ParsedArgs {
  let command: string | undefined;
  let framework: string | undefined;
  let outputDir: string | undefined;
  let entryFile = './src/index.ts';
  const enable: string[] = [];
  const disable: string[] = [];
  // Kept raw here; splitting and validation are resolveCustomScopes()'s job.
  const scope: string[] = [];
  let db: string | null | undefined;
  let flow: string | null | undefined;
  let format: string | null | undefined;
  let detail: string | null | undefined;
  const endpoint: string[] = [];
  let errorEdges = true;
  let force = false;
  let dryRun = false;
  let help = false;

  const splitFeatureList = (value: string | undefined): string[] =>
    (value ?? '').split(',').map((f) => f.trim()).filter((f) => f.length > 0);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--output' || arg === '-o') {
      i++;
      outputDir = args[i] ?? outputDir;
    } else if (arg === '--entry' || arg === '-e') {
      i++;
      entryFile = args[i] ?? entryFile;
    } else if (arg === '--enable') {
      i++;
      enable.push(...splitFeatureList(args[i]));
    } else if (arg === '--disable') {
      i++;
      disable.push(...splitFeatureList(args[i]));
    } else if (arg === '--scope') {
      i++;
      const value = args[i];
      if (value !== undefined) scope.push(value);
    } else if (arg === '--db') {
      // The kind is the next word; another flag (or nothing) after --db means
      // the kind was left out, which resolveDbKind() reports.
      db = flagValue(args, i);
      if (db !== null) i++;
    } else if (arg === '--flow') {
      flow = flagValue(args, i);
      if (flow !== null) i++;
    } else if (arg === '--format') {
      format = flagValue(args, i);
      if (format !== null) i++;
    } else if (arg === '--detail') {
      detail = flagValue(args, i);
      if (detail !== null) i++;
    } else if (arg === '--endpoint') {
      i++;
      endpoint.push(...splitFeatureList(args[i]));
    } else if (arg === '--no-error-edges') {
      errorEdges = false;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (!command) {
      command = arg;
    } else if (!framework) {
      framework = arg;
    }
  }

  return {
    command,
    framework,
    outputDir,
    entryFile,
    enable,
    disable,
    scope,
    db,
    flow,
    format,
    detail,
    endpoint,
    errorEdges,
    force,
    dryRun,
    help,
  };
}

/**
 * What a run generates: the features, scopes and db, plus (with --flow) the
 * rearranged steps and the endpoint order the flow document asks for.
 */
interface GenerationInputs {
  features: OidcFeatureConfig;
  scopes: string[];
  db: DbKind | undefined;
  flow: FlowSelection | undefined;
}

/**
 * Resolve the generation inputs from the flags, or from the flow document when
 * --flow is given. The two are exclusive: a document already carries the
 * features, scopes and db it was drawn with, so a flag beside it would either
 * be ignored or contradict it.
 *
 * @throws {Error} on an invalid combination, a missing or invalid flow file,
 *   or an invalid flag value.
 */
function resolveGenerationInputs(parsed: ParsedArgs): GenerationInputs {
  if (parsed.flow === undefined) {
    return {
      features: resolveFeatures({ enable: parsed.enable, disable: parsed.disable }),
      scopes: resolveCustomScopes({ scope: parsed.scope }),
      db: resolveDbKind(parsed.db),
      flow: undefined,
    };
  }
  if (parsed.flow === null) {
    throw new Error('--flow needs a file: --flow <file> (the JSON that `maronn-oidc graph --format json` writes)');
  }
  if (parsed.enable.length > 0 || parsed.disable.length > 0 || parsed.scope.length > 0 || parsed.db !== undefined) {
    throw new Error(
      '--flow cannot be combined with --enable, --disable, --scope or --db: ' +
        'the flow document already carries the features, scopes and db it was drawn with',
    );
  }
  if (!existsSync(parsed.flow)) {
    throw new Error(`Flow file not found: ${parsed.flow}`);
  }
  const selection = parseFlowFile(readFileSync(parsed.flow, 'utf-8'), parsed.flow);
  return { features: selection.features, scopes: selection.scopes, db: selection.db, flow: selection };
}

const GRAPH_FORMATS = ['mermaid', 'json'] as const;
type GraphFormat = (typeof GRAPH_FORMATS)[number];
const GRAPH_DETAILS: readonly MermaidDetail[] = ['endpoints', 'steps'];

function resolveGraphFormat(value: string | null | undefined): GraphFormat {
  if (value === undefined) return 'mermaid';
  if (value !== null && (GRAPH_FORMATS as readonly string[]).includes(value)) return value as GraphFormat;
  throw new Error(`--format needs one of ${GRAPH_FORMATS.join(', ')}${value === null ? '' : `, not "${value}"`}`);
}

function resolveGraphDetail(value: string | null | undefined): MermaidDetail {
  if (value === undefined) return 'endpoints';
  if (value !== null && (GRAPH_DETAILS as readonly string[]).includes(value)) return value as MermaidDetail;
  throw new Error(`--detail needs one of ${GRAPH_DETAILS.join(', ')}${value === null ? '' : `, not "${value}"`}`);
}

/** The flow of a run: the catalog for its inputs, rearranged as its flow document asks. */
function resolveOpFlow(inputs: GenerationInputs, framework: string | undefined): OpFlow {
  const catalog = buildOpFlow({
    features: inputs.features,
    scopes: inputs.scopes,
    ...(inputs.db === undefined ? {} : { db: inputs.db }),
  });
  const flow = inputs.flow === undefined ? catalog : applyFlowSelection(catalog, inputs.flow);
  return framework === undefined ? flow : annotateFlowModules(flow, framework);
}

/**
 * `graph [framework]`: print (or write) the provider as boxes and arrows.
 * Nothing is generated.
 */
function runGraph(parsed: ParsedArgs): void {
  if (parsed.framework !== undefined && !getAvailableFrameworks().includes(parsed.framework)) {
    throw new Error(
      `Unknown framework: "${parsed.framework}". Available frameworks: ${getAvailableFrameworks().join(', ')}`,
    );
  }
  const format = resolveGraphFormat(parsed.format);
  const detail = resolveGraphDetail(parsed.detail);
  const flow = resolveOpFlow(resolveGenerationInputs(parsed), parsed.framework);
  const endpoints = parsed.endpoint.length > 0 ? parsed.endpoint : undefined;
  const output =
    format === 'json'
      ? `${JSON.stringify(endpoints === undefined ? flow : pickEndpoints(flow, endpoints), null, 2)}\n`
      : renderMermaid(flow, {
          detail,
          errorEdges: parsed.errorEdges,
          ...(endpoints === undefined ? {} : { endpoints }),
        });
  if (parsed.outputDir === undefined) {
    process.stdout.write(output);
    return;
  }
  const dir = dirname(parsed.outputDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(parsed.outputDir, output, 'utf-8');
  console.log(`Wrote ${parsed.outputDir}`);
}

/** The flow restricted to some endpoints (and the arrows among them), for --endpoint with --format json. */
function pickEndpoints(flow: OpFlow, ids: string[]): OpFlow {
  const known = new Set(flow.endpoints.map((e) => e.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown endpoint: ${unknown.map((id) => `"${id}"`).join(', ')}. ` +
        `Endpoints of this configuration: ${flow.endpoints.map((e) => e.id).join(', ')}`,
    );
  }
  const wanted = new Set(ids);
  return {
    ...flow,
    endpoints: flow.endpoints.filter((e) => wanted.has(e.id)),
    edges: flow.edges.filter((e) => wanted.has(e.from) && wanted.has(e.to)),
  };
}

function buildManifestFile(
  framework: string,
  features: OidcFeatureConfig,
  scopes: string[],
  db: DbKind | undefined,
  flow: FlowSelection | undefined,
): GeneratedFile {
  // No timestamp: the same inputs must keep producing byte-identical output.
  // steps / endpointOrder record what a --flow document rearranged (null when
  // the output follows the catalog), so `graph --format json` of the same
  // inputs plus these two fields reproduces the document.
  const rearrangedSteps = flow !== undefined && Object.keys(flow.steps).length > 0 ? flow.steps : null;
  const catalogOrder = buildOpFlow({ features, scopes, ...(db === undefined ? {} : { db }) }).endpoints.map(
    (e) => e.id,
  );
  const endpointOrder =
    flow !== undefined && flow.endpointOrder.some((id, i) => id !== catalogOrder[i]) ? flow.endpointOrder : null;
  const manifest = {
    cliVersion: CLI_VERSION,
    framework,
    features,
    scopes,
    db: db ?? null,
    steps: rearrangedSteps,
    endpointOrder,
  };
  return { path: MANIFEST_FILENAME, content: `${JSON.stringify(manifest, null, 2)}\n` };
}

const USER_OWNED_NOTE = '(yours; never overwritten)';

/** A file the user writes that is already there: generation leaves it alone. */
function isKeptUserFile(outputDir: string, file: GeneratedFile): boolean {
  return file.userOwned === true && existsSync(join(outputDir, file.path));
}

/**
 * Planned paths that already exist on disk, in generation order. A user-owned
 * file is never overwritten, so it never counts as one.
 */
function findExistingFiles(outputDir: string, files: GeneratedFile[]): string[] {
  return files
    .filter((file) => file.userOwned !== true)
    .map((file) => file.path)
    .filter((path) => existsSync(join(outputDir, path)));
}

function printOverwriteRefusal(outputDir: string, existingPaths: string[]): void {
  console.error(`Error: ${existingPaths.length} file(s) already exist in ${outputDir}:`);
  for (const path of existingPaths) {
    console.error(`  ${path}`);
  }
  console.error('');
  console.error(
    'Re-run with --force to overwrite them, or use -o <dir> to generate into a new directory.',
  );
  console.error('Tip: commit the generated files before overwriting so you can diff your changes.');
}

function printDryRunPlan(outputDir: string, files: GeneratedFile[]): void {
  console.log(`Dry run: nothing was written. Planned output in ${outputDir}:`);
  for (const file of files) {
    if (isKeptUserFile(outputDir, file)) {
      console.log(`  Would keep: ${file.path} ${USER_OWNED_NOTE}`);
      continue;
    }
    const label = existsSync(join(outputDir, file.path)) ? 'Would overwrite' : 'Would create';
    console.log(`  ${label}: ${file.path}`);
  }
}

function writeGeneratedFiles(outputDir: string, files: GeneratedFile[]): void {
  for (const file of files) {
    if (isKeptUserFile(outputDir, file)) {
      console.log(`  Kept: ${file.path} ${USER_OWNED_NOTE}`);
      continue;
    }
    const fullPath = join(outputDir, file.path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const label = existsSync(fullPath) ? 'Overwritten' : 'Created';
    writeFileSync(fullPath, file.content, 'utf-8');
    console.log(`  ${label}: ${file.path}`);
  }
}

/**
 * The screens are generated as hono/jsx (the views.tsx and page.tsx files of
 * the endpoints and features), for Express and Fastify too. Say which compiler
 * options that needs.
 */
function printHonoJsxNotes(): void {
  console.log(
    '\nThe screens (the .tsx files) use hono/jsx. Enable JSX in tsconfig.json:\n' +
      '  "jsx": "react-jsx", "jsxImportSource": "hono/jsx"',
  );
}

type PatchEntryFileResult =
  | { status: 'patched' }
  | { status: 'already-patched' }
  | { status: 'missing-placeholders'; missing: string[] };

/**
 * A previous `setup` run consumed both placeholders, so re-running it must be
 * recognised by the wiring it produced rather than by the placeholders.
 */
function isAlreadyPatched(content: string): boolean {
  const hasApplyOidcImport = /import\s*\{[^}]*\bapplyOidc\b[^}]*\}\s*from/.test(content);
  return hasApplyOidcImport && content.includes(APPLY_OIDC_CALL);
}

/**
 * Wire the generated OP into an existing entry file. The file is written only
 * when both placeholders are present: a partial replacement would either leave
 * the OP unmounted or write `applyOidc(app);` without its import, which breaks
 * the user's entry file. Both cases are reported to the caller instead.
 */
function patchEntryFile(entryFilePath: string, outputDir: string): PatchEntryFileResult {
  const entryDir = dirname(resolve(entryFilePath));
  const resolvedOutput = resolve(outputDir);
  const relPath = relative(entryDir, resolvedOutput);
  const importPath = relPath.startsWith('.') ? relPath : `./${relPath}`;
  const applyImportPath = `${importPath}/apply.js`;

  const content = readFileSync(entryFilePath, 'utf-8');
  const hasImportPlaceholder = content.includes(IMPORT_PLACEHOLDER);
  const hasSetupPlaceholder = content.includes(SETUP_PLACEHOLDER);

  if (!hasImportPlaceholder || !hasSetupPlaceholder) {
    if (isAlreadyPatched(content)) {
      return { status: 'already-patched' };
    }
    const missing: string[] = [];
    if (!hasImportPlaceholder) missing.push(IMPORT_PLACEHOLDER);
    if (!hasSetupPlaceholder) missing.push(SETUP_PLACEHOLDER);
    return { status: 'missing-placeholders', missing };
  }

  // Replacer functions keep `$&` and friends in the resolved path literal.
  const patched = content
    .replace(IMPORT_PLACEHOLDER, () => `import { applyOidc } from '${applyImportPath}';`)
    .replace(SETUP_PLACEHOLDER, () => APPLY_OIDC_CALL);
  writeFileSync(entryFilePath, patched, 'utf-8');
  return { status: 'patched' };
}

function printMissingPlaceholderError(
  entryFilePath: string,
  outputDir: string,
  framework: string,
  missing: string[],
): void {
  console.error(`Error: Entry file is missing the required OIDC placeholders: ${entryFilePath}`);
  for (const placeholder of missing) {
    console.error(`  Missing: ${placeholder}`);
  }
  console.error('');
  console.error('Add both placeholder comments to the entry file and re-run `setup`:');
  console.error(`  ${IMPORT_PLACEHOLDER}`);
  console.error(`  ${ENTRY_APP_EXAMPLES[framework] ?? DEFAULT_ENTRY_APP_EXAMPLE}`);
  console.error(`  ${SETUP_PLACEHOLDER}`);
  console.error('');
  console.error(`Generated files are in ${outputDir}, but the entry file was not patched.`);
}

export function run(args: string[]): void {
  const parsed = parseArgs(args);

  if (parsed.help || !parsed.command) {
    printUsage();
    return;
  }

  if (parsed.command === 'graph') {
    try {
      runGraph(parsed);
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      }
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.command !== 'generate' && parsed.command !== 'setup') {
    console.error(`Unknown command: ${parsed.command}`);
    printUsage();
    process.exitCode = 1;
    return;
  }
  const outputDir = parsed.outputDir ?? './oidc-provider';

  if (!parsed.framework) {
    console.error('Error: Framework name is required.');
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.command === 'setup' && SETUP_UNSUPPORTED_FRAMEWORKS.has(parsed.framework)) {
    console.error(
      'Error: setup is not supported for Next.js. Use: maronn-oidc generate nextjs --output ./src/app',
    );
    process.exitCode = 1;
    return;
  }

  if (parsed.command === 'setup' && !existsSync(parsed.entryFile)) {
    console.error(`Error: Entry file not found: ${parsed.entryFile}`);
    process.exitCode = 1;
    return;
  }

  try {
    const { features, scopes, db, flow } = resolveGenerationInputs(parsed);
    const result = generate({
      framework: parsed.framework,
      outputDir,
      features,
      scopes,
      db,
      ...(flow === undefined ? {} : { steps: flow.steps, endpointOrder: flow.endpointOrder }),
    });
    const manifestFile = buildManifestFile(result.framework, features, scopes, db, flow);
    const plannedFiles = [...result.files, manifestFile];

    if (parsed.dryRun) {
      printDryRunPlan(outputDir, plannedFiles);
      return;
    }

    // Only user-facing files arm the guard: the manifest is machine-written
    // and is refreshed on every generation, --force or not.
    const existingPaths = findExistingFiles(outputDir, result.files);
    if (existingPaths.length > 0 && !parsed.force) {
      printOverwriteRefusal(outputDir, existingPaths);
      process.exitCode = 1;
      return;
    }

    console.log(`\nGenerating ${result.framework} OIDC Provider code...\n`);
    const disabledFeatures = AVAILABLE_FEATURES.filter(
      (name) => parsed.disable.includes(name),
    );
    if (disabledFeatures.length > 0) {
      console.log(`Disabled features: ${disabledFeatures.join(', ')}\n`);
    }
    const enabledExperimental = EXPERIMENTAL_FEATURES.filter((name) =>
      parsed.enable.includes(name),
    );
    if (enabledExperimental.length > 0) {
      console.log(`Experimental features enabled: ${enabledExperimental.join(', ')}`);
      console.log(
        `Warning: experimental features are provided by ${EXPERIMENTAL_PACKAGE} and their APIs may change in a breaking way.\n`,
      );
    }
    const enabledExtensions = EXTENSION_FEATURES.filter((name) => parsed.enable.includes(name));
    if (enabledExtensions.length > 0) {
      console.log(`Extension features enabled: ${enabledExtensions.join(', ')}`);
      console.log(
        'google-login: the button renders once config.googleLogin.clientId is set (the generated\n' +
          'Next.js output and the samples read GOOGLE_CLIENT_ID). Register <issuer>/login/google as an\n' +
          'authorized redirect URI of that Google OAuth client. Node.js 22+ only.\n',
      );
    }
    if (scopes.length > 0) {
      console.log(`Custom scopes: ${scopes.join(', ')}`);
      console.log(
        'A scope that was not declared is now rejected with invalid_scope. Write per-End-User\n' +
          'filtering in resolveGrantableScopes() (scopes.ts); it is already wired into every step\n' +
          'that decides a grant.\n',
      );
    }
    const dbDir = result.framework === 'nextjs' ? '_oidc-provider/db' : 'db';
    if (db) {
      console.log(dbGuidance(db, dbDir, result.framework).summary);
    }
    // Decided before writing: a user-owned file created by this run is not "kept".
    const keptCount = plannedFiles.filter((file) => isKeptUserFile(outputDir, file)).length;
    writeGeneratedFiles(outputDir, plannedFiles);
    console.log(`\nDone! Generated ${plannedFiles.length - keptCount} files in ${outputDir}`);
    if (result.framework !== 'nextjs') {
      printHonoJsxNotes();
    }

    if (parsed.command === 'setup') {
      console.log(`\nPatching entry file...`);
      const patchResult = patchEntryFile(parsed.entryFile, outputDir);
      if (patchResult.status === 'missing-placeholders') {
        printMissingPlaceholderError(
          parsed.entryFile,
          outputDir,
          parsed.framework,
          patchResult.missing,
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        patchResult.status === 'already-patched'
          ? `  Already patched (no changes): ${parsed.entryFile}`
          : `  Patched: ${parsed.entryFile}`,
      );
      const setupSteps = [
        'Provide runtime config, signing keys, and client resolvers from env/DB/KV',
        db ? dbGuidance(db, `${outputDir}/db`).step : MEMORY_STORES_STEP,
        `Use ${outputDir}/config.ts defaults only for quick local testing`,
        ...(featurePackagesOf(features).includes(EXPERIMENTAL_PACKAGE)
          ? [`Install the experimental package: pnpm add ${EXPERIMENTAL_PACKAGE}`]
          : []),
        ...(features.googleLogin
          ? [
              `Install the Google login extension: pnpm add ${featurePackagesOf(features)
                .filter((name) => name !== EXPERIMENTAL_PACKAGE)
                .join(' ')}`,
            ]
          : []),
        'Start the server',
      ];
      console.log(`\nNext steps:`);
      setupSteps.forEach((step, index) => {
        const isLast = index === setupSteps.length - 1;
        console.log(`  ${index + 1}. ${step}${isLast ? '\n' : ''}`);
      });
    } else {
      const installCommand = withFeaturePackages(
        INSTALL_COMMANDS[result.framework] ?? `pnpm add @maronn-openid-connect/core`,
        features,
      );
      // Next.js reads its configuration from the environment in
      // _oidc-provider/provider.ts and its data from _oidc-provider/db.
      const nextSteps =
        result.framework === 'nextjs'
          ? [
              'Configure the OP with environment variables: OIDC_ISSUER (see _oidc-provider/provider.ts)',
              db === 'kv'
                ? `${dbDir}/instance.ts runs on Upstash Redis when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set, and on node:sqlite (.data/oidc.sqlite) otherwise`
                : db
                  ? dbGuidance(db, dbDir).step
                  : 'The data is kept in memory (_oidc-provider/db): generate with --db kv (Upstash Redis on Vercel) or --db sql to keep it',
              'Register your clients and users with registerClient() and registerUser() of _oidc-provider/db (instrumentation.ts runs once when the server starts)',
              'Load a fixed signing key in _oidc-provider/provider.ts before running more than one instance',
              `Install dependencies: ${installCommand}`,
              'Start the server: next dev',
            ]
          : [
              'Provide runtime config, signing keys, and client resolvers from env/DB/KV',
              db ? dbGuidance(db, dbDir).step : MEMORY_STORES_STEP,
              'Use config.ts defaults only for quick local testing',
              `Install dependencies: ${installCommand}`,
              'Start the server',
            ];
      console.log(`\nNext steps:`);
      nextSteps.forEach((step, index) => {
        const isLast = index === nextSteps.length - 1;
        console.log(`  ${index + 1}. ${step}${isLast ? '\n' : ''}`);
      });
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

// Run CLI when executed directly
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0 || process.argv[1]?.includes('maronn-oidc')) {
  run(cliArgs);
}
