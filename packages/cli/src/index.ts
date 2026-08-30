#!/usr/bin/env node

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { generate, getAvailableFrameworks } from './generator.js';
import {
  AVAILABLE_FEATURES,
  EXPERIMENTAL_FEATURES,
  OPTIONAL_FEATURES,
  resolveFeatures,
} from './features.js';
import type { OidcFeatureConfig } from './features.js';

const INSTALL_COMMANDS: Record<string, string> = {
  hono: 'pnpm add hono @maronn-openid-connect/core',
  express: 'pnpm add express @maronn-openid-connect/core && pnpm add -D @types/express',
  fastify: 'pnpm add fastify @maronn-openid-connect/core',
  nextjs: 'pnpm add @maronn-openid-connect/core && pnpm add -D next react react-dom',
};

const EXPERIMENTAL_PACKAGE = '@maronn-openid-connect/experimental';

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
    !features.idJag
  ) {
    return installCommand;
  }
  return installCommand.replace('@maronn-openid-connect/core', `@maronn-openid-connect/core ${EXPERIMENTAL_PACKAGE}`);
}

const SETUP_UNSUPPORTED_FRAMEWORKS = new Set(['nextjs']);

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
  --help, -h            Show this help message

Features (all enabled by default): ${features}

Optional features (disabled by default): ${optionalFeatures}
  Stable hardening that no OIDC Core / OAuth 2.1 clause requires, so the default
  output stays the specification and nothing more. Enable one with, e.g.:
  --enable transaction-binding

Experimental features (disabled by default): ${experimentalFeatures}
  Provided by the separate ${EXPERIMENTAL_PACKAGE} package. APIs are unstable
  and may change in a breaking way. Enable one with, e.g.: --enable par
`);
}

function parseArgs(args: string[]): {
  command?: string;
  framework?: string;
  outputDir: string;
  entryFile: string;
  enable: string[];
  disable: string[];
  help: boolean;
} {
  let command: string | undefined;
  let framework: string | undefined;
  let outputDir = './oidc-provider';
  let entryFile = './src/index.ts';
  const enable: string[] = [];
  const disable: string[] = [];
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
    } else if (!command) {
      command = arg;
    } else if (!framework) {
      framework = arg;
    }
  }

  return { command, framework, outputDir, entryFile, enable, disable, help };
}

function writeGeneratedFiles(outputDir: string, files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
    const fullPath = join(outputDir, file.path);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, file.content, 'utf-8');
    console.log(`  Created: ${file.path}`);
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
    const result = generate({
      framework: parsed.framework,
      outputDir: parsed.outputDir,
      features,
    });

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
    writeGeneratedFiles(parsed.outputDir, result.files);
    console.log(`\nDone! Generated ${result.files.length} files in ${parsed.outputDir}`);

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
      console.log(`\nNext steps:`);
      console.log(`  1. Provide runtime config, signing keys, and client resolvers from env/DB/KV`);
      console.log(`  2. Inject persistent ProviderStores through the generated JsonStoreBackend contract`);
      console.log(`  3. Use ${parsed.outputDir}/config.ts defaults only for quick local testing`);
      if (
        features.par ||
        features.tokenExchange ||
        features.jarm ||
        features.deviceAuthorizationGrant
      ) {
        console.log(`  4. Install the experimental package: pnpm add ${EXPERIMENTAL_PACKAGE}`);
        console.log(`  5. Start the server\n`);
      } else {
        console.log(`  4. Start the server\n`);
      }
    } else {
      const installCommand = withExperimentalPackage(
        INSTALL_COMMANDS[result.framework] ?? `pnpm add @maronn-openid-connect/core`,
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
