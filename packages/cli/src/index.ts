#!/usr/bin/env node

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { generate, getAvailableFrameworks } from './generator.js';
import {
  AVAILABLE_FEATURES,
  EXPERIMENTAL_FEATURES,
  EXTENSION_FEATURES,
  OPTIONAL_FEATURES,
  resolveFeatures,
} from './features.js';
import type { OidcFeatureConfig } from './features.js';
import { resolveCustomScopes } from './scopes.js';

const INSTALL_COMMANDS: Record<string, string> = {
  hono: 'pnpm add hono @maronn-openid-connect/core',
  express: 'pnpm add express @maronn-openid-connect/core && pnpm add -D @types/express',
  fastify: 'pnpm add fastify @maronn-openid-connect/core',
  nextjs: 'pnpm add @maronn-openid-connect/core && pnpm add -D next react react-dom',
};

const EXPERIMENTAL_PACKAGE = '@maronn-openid-connect/experimental';
const GOOGLE_LOGIN_PACKAGE = '@maronn-openid-connect/google-login';

/**
 * Insert @maronn-openid-connect/experimental into the install guidance, but only when an
 * experimental feature was actually selected. Without a selection the command
 * string is returned untouched so existing output never changes.
 */
function withExperimentalPackage(installCommand: string, features: OidcFeatureConfig): string {
  if (
    !features.par &&
    !features.tokenExchange &&
    !features.jarm &&
    !features.deviceAuthorizationGrant &&
    !features.idJag &&
    !features.ciba &&
    !features.jwtIntrospectionResponse &&
    !features.rpInitiatedLogout
  ) {
    return installCommand;
  }
  return installCommand.replace('@maronn-openid-connect/core', `@maronn-openid-connect/core ${EXPERIMENTAL_PACKAGE}`);
}

/**
 * Insert @maronn-openid-connect/google-login into the install guidance, but only
 * when the google-login extension was selected. Applied before the experimental
 * insertion so the packages read core, experimental, google-login.
 */
function withGoogleLoginPackage(installCommand: string, features: OidcFeatureConfig): string {
  if (!features.googleLogin) {
    return installCommand;
  }
  return installCommand.replace('@maronn-openid-connect/core', `@maronn-openid-connect/core ${GOOGLE_LOGIN_PACKAGE}`);
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
  const optionalFeatures = OPTIONAL_FEATURES.join(', ');
  const experimentalFeatures = EXPERIMENTAL_FEATURES.join(', ');
  const extensionFeatures = EXTENSION_FEATURES.join(', ');
  console.log(`
Usage: maronn-oidc <command> <framework> [options]

Commands:
  generate <framework>  Generate OIDC provider code for the specified framework
  setup <framework>     Generate OIDC provider code and apply it to an existing entry file

Frameworks: ${frameworks}

Options:
  --output, -o <dir>    Output directory (default: ./oidc-provider)
  --entry, -e <file>    Entry file to patch with OIDC setup (setup command only, default: ./src/index.ts)
  --enable <features>   Comma-separated features to enable (repeatable)
  --disable <features>  Comma-separated features to remove from the default set (repeatable)
  --scope <scopes>      Comma-separated custom scopes the provider accepts (repeatable)
  --force               Overwrite files that already exist in the output directory
  --dry-run             Show what would be written without writing anything
  --help, -h            Show this help message

Features (all enabled by default): ${features}

Optional features (disabled by default): ${optionalFeatures}
  Stable hardening that no OIDC Core / OAuth 2.1 clause requires, so the default
  output stays the specification and nothing more. Enable one with, e.g.:
  --enable transaction-binding

Experimental features (disabled by default): ${experimentalFeatures}
  Provided by the separate ${EXPERIMENTAL_PACKAGE} package. APIs are unstable
  and may change in a breaking way. Enable one with, e.g.: --enable par

Extension features (disabled by default): ${extensionFeatures}
  google-login (${GOOGLE_LOGIN_PACKAGE}): adds a "Sign in with Google" button to
  the login page and a POST /login/google callback that verifies the ID token
  Google posts there with Google's official google-auth-library. Node.js 22+
  only. Set config.googleLogin.clientId (the generated Next.js runtime and the
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
`);
}

function parseArgs(args: string[]): {
  command?: string;
  framework?: string;
  outputDir: string;
  entryFile: string;
  enable: string[];
  disable: string[];
  scope: string[];
  force: boolean;
  dryRun: boolean;
  help: boolean;
} {
  let command: string | undefined;
  let framework: string | undefined;
  let outputDir = './oidc-provider';
  let entryFile = './src/index.ts';
  const enable: string[] = [];
  const disable: string[] = [];
  // Kept raw here; splitting and validation are resolveCustomScopes()'s job.
  const scope: string[] = [];
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

  return { command, framework, outputDir, entryFile, enable, disable, scope, force, dryRun, help };
}

function buildManifestFile(
  framework: string,
  features: OidcFeatureConfig,
  scopes: string[],
): { path: string; content: string } {
  // No timestamp: the same inputs must keep producing byte-identical output.
  const manifest = { cliVersion: CLI_VERSION, framework, features, scopes };
  return { path: MANIFEST_FILENAME, content: `${JSON.stringify(manifest, null, 2)}\n` };
}

/** Planned paths that already exist on disk, in generation order. */
function findExistingFiles(outputDir: string, files: Array<{ path: string }>): string[] {
  return files.map((file) => file.path).filter((path) => existsSync(join(outputDir, path)));
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

function printDryRunPlan(outputDir: string, files: Array<{ path: string }>): void {
  console.log(`Dry run: nothing was written. Planned output in ${outputDir}:`);
  for (const file of files) {
    const label = existsSync(join(outputDir, file.path)) ? 'Would overwrite' : 'Would create';
    console.log(`  ${label}: ${file.path}`);
  }
}

function writeGeneratedFiles(outputDir: string, files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
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

  if (parsed.command !== 'generate' && parsed.command !== 'setup') {
    console.error(`Unknown command: ${parsed.command}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

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
    const features = resolveFeatures({
      enable: parsed.enable,
      disable: parsed.disable,
    });
    const scopes = resolveCustomScopes({ scope: parsed.scope });
    const result = generate({
      framework: parsed.framework,
      outputDir: parsed.outputDir,
      features,
      scopes,
    });
    const manifestFile = buildManifestFile(result.framework, features, scopes);
    const plannedFiles = [...result.files, manifestFile];

    if (parsed.dryRun) {
      printDryRunPlan(parsed.outputDir, plannedFiles);
      return;
    }

    // Only user-facing files arm the guard: the manifest is machine-written
    // and is refreshed on every generation, --force or not.
    const existingPaths = findExistingFiles(parsed.outputDir, result.files);
    if (existingPaths.length > 0 && !parsed.force) {
      printOverwriteRefusal(parsed.outputDir, existingPaths);
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
    const enabledOptional = OPTIONAL_FEATURES.filter((name) => parsed.enable.includes(name));
    if (enabledOptional.length > 0) {
      console.log(`Optional features enabled: ${enabledOptional.join(', ')}\n`);
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
          'Next.js runtime and the samples read GOOGLE_CLIENT_ID). Register <issuer>/login/google as an\n' +
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
    writeGeneratedFiles(parsed.outputDir, plannedFiles);
    console.log(`\nDone! Generated ${plannedFiles.length} files in ${parsed.outputDir}`);

    if (parsed.command === 'setup') {
      console.log(`\nPatching entry file...`);
      const patchResult = patchEntryFile(parsed.entryFile, parsed.outputDir);
      if (patchResult.status === 'missing-placeholders') {
        printMissingPlaceholderError(
          parsed.entryFile,
          parsed.outputDir,
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
        'Inject persistent ProviderStores through the generated JsonStoreBackend contract',
        `Use ${parsed.outputDir}/config.ts defaults only for quick local testing`,
        ...(features.par ||
        features.tokenExchange ||
        features.jarm ||
        features.deviceAuthorizationGrant ||
        features.ciba
          ? [`Install the experimental package: pnpm add ${EXPERIMENTAL_PACKAGE}`]
          : []),
        ...(features.googleLogin
          ? [`Install the Google login extension: pnpm add ${GOOGLE_LOGIN_PACKAGE}`]
          : []),
        'Start the server',
      ];
      console.log(`\nNext steps:`);
      setupSteps.forEach((step, index) => {
        const isLast = index === setupSteps.length - 1;
        console.log(`  ${index + 1}. ${step}${isLast ? '\n' : ''}`);
      });
    } else {
      const installCommand = withExperimentalPackage(
        withGoogleLoginPackage(
          INSTALL_COMMANDS[result.framework] ?? `pnpm add @maronn-openid-connect/core`,
          features,
        ),
        features,
      );
      console.log(`\nNext steps:`);
      console.log(`  1. Provide runtime config, signing keys, and client resolvers from env/DB/KV`);
      console.log(`  2. Inject persistent ProviderStores through the generated JsonStoreBackend contract`);
      console.log(`  3. Use config.ts defaults only for quick local testing`);
      console.log(`  4. Install dependencies: ${installCommand}`);
      console.log(`  5. Start the server\n`);
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
