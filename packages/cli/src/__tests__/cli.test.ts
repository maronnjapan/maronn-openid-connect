import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run } from '../index.js';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('run', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'maronn-cli-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should show help when no arguments provided', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    run([]);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Usage:');
    consoleSpy.mockRestore();
  });

  it('should show help with --help flag', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['--help']);
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Usage:');
    consoleSpy.mockRestore();
  });

  it('should error on unknown command', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['unknown-cmd']);
    expect(consoleSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    consoleSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('should error when framework is missing', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['generate']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Framework name is required'),
    );
    expect(process.exitCode).toBe(1);
    consoleSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('should error for unknown framework', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['generate', 'unknown-framework']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown framework'),
    );
    expect(process.exitCode).toBe(1);
    consoleSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('should error on an unknown feature name', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['generate', 'hono', '-o', join(testDir, 'unused'), '--disable', 'dpop']);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Error: Unknown feature: "dpop". Available features: pkce, refresh-token, introspection, revocation, request-object. Experimental features (disabled by default): par, token-exchange, jarm, device-authorization-grant, id-jag, ciba, jwt-introspection-response, rp-initiated-logout, dynamic-client-registration. Extension features (disabled by default): google-login',
    );
    expect(process.exitCode).toBe(1);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should error when a feature is both enabled and disabled', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['generate', 'hono', '-o', join(testDir, 'unused'), '--enable', 'pkce', '--disable', 'pkce']);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Error: Feature "pkce" cannot be both enabled and disabled',
    );
    expect(process.exitCode).toBe(1);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should list the available features in help output', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['--help']);
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('--enable');
    expect(output).toContain('--disable');
    expect(output).toContain('pkce, refresh-token, introspection, revocation, request-object');
    consoleSpy.mockRestore();
  });

  it('should exit with a non-zero code when the entry file has no OIDC placeholders', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(entryFile, "import { Hono } from 'hono';\nconst app = new Hono();\nexport default app;\n");
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(process.exitCode).toBe(1);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should leave the entry file unchanged when the entry file has no OIDC placeholders', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    const original = "import { Hono } from 'hono';\nconst app = new Hono();\nexport default app;\n";
    writeFileSync(entryFile, original);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(readFileSync(entryFile, 'utf-8')).toBe(original);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should exit with a non-zero code when only the import placeholder is present', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(entryFile, "import { Hono } from 'hono';\n// <!-- OIDC_IMPORT_PLACEHOLDER -->\nconst app = new Hono();\n");
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(process.exitCode).toBe(1);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should leave the entry file unchanged when only the import placeholder is present', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    const original = "import { Hono } from 'hono';\n// <!-- OIDC_IMPORT_PLACEHOLDER -->\nconst app = new Hono();\n";
    writeFileSync(entryFile, original);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(readFileSync(entryFile, 'utf-8')).toBe(original);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should exit with a non-zero code when only the setup placeholder is present', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(entryFile, "const app = new Hono();\n// <!-- OIDC_SETUP_PLACEHOLDER -->\n");
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(process.exitCode).toBe(1);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should leave the entry file unchanged when only the setup placeholder is present', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    const original = "const app = new Hono();\n// <!-- OIDC_SETUP_PLACEHOLDER -->\n";
    writeFileSync(entryFile, original);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(readFileSync(entryFile, 'utf-8')).toBe(original);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should name the missing placeholder in the error message', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(entryFile, "import { Hono } from 'hono';\n// <!-- OIDC_IMPORT_PLACEHOLDER -->\nconst app = new Hono();\n");
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(errorSpy).toHaveBeenCalledWith(
      `Error: Entry file is missing the required OIDC placeholders: ${entryFile}`,
    );
    expect(errorSpy).toHaveBeenCalledWith('  Missing: // <!-- OIDC_SETUP_PLACEHOLDER -->');
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should print both required placeholders and the generated output location in the error message', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(entryFile, "const app = new Hono();\n");
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    const output = errorSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toBe(
      [
        `Error: Entry file is missing the required OIDC placeholders: ${entryFile}`,
        '  Missing: // <!-- OIDC_IMPORT_PLACEHOLDER -->',
        '  Missing: // <!-- OIDC_SETUP_PLACEHOLDER -->',
        '',
        'Add both placeholder comments to the entry file and re-run `setup`:',
        '  // <!-- OIDC_IMPORT_PLACEHOLDER -->',
        '  const app = new Hono();',
        '  // <!-- OIDC_SETUP_PLACEHOLDER -->',
        '',
        `Generated files are in ${outputDir}, but the entry file was not patched.`,
      ].join('\n'),
    );
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should show the express app example in the error message for the express framework', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(entryFile, 'const app = express();\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'express', '-o', outputDir, '-e', entryFile]);
    expect(errorSpy).toHaveBeenCalledWith('  const app = express();');
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should not print the start-the-server guidance when patching fails', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(entryFile, "const app = new Hono();\n");
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output.includes('Start the server')).toBe(false);
    expect(output.includes('Next steps:')).toBe(false);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should report already patched and leave the file unchanged on a second setup run', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      entryFile,
      "import { Hono } from 'hono';\n// <!-- OIDC_IMPORT_PLACEHOLDER -->\nconst app = new Hono();\n// <!-- OIDC_SETUP_PLACEHOLDER -->\n",
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    vi.restoreAllMocks();
    const afterFirstRun = readFileSync(entryFile, 'utf-8');

    // --force: the first run filled outputDir, so a plain re-run would be
    // refused by the overwrite guard before reaching the patch step.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile, '--force']);
    expect(logSpy).toHaveBeenCalledWith(`  Already patched (no changes): ${entryFile}`);
    expect(readFileSync(entryFile, 'utf-8')).toBe(afterFirstRun);
    expect(process.exitCode).toBe(undefined);
    vi.restoreAllMocks();
  });

  it('should error when framework is missing for setup', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Framework name is required'),
    );
    expect(process.exitCode).toBe(1);
    consoleSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('should error when entry file does not exist', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', join(testDir, 'nonexistent.ts')]);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Entry file not found'),
    );
    expect(process.exitCode).toBe(1);
    consoleSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('should error when setup is requested for Next.js', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'nextjs', '-o', join(testDir, 'app')]);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Error: setup is not supported for Next.js. Use: maronn-oidc generate nextjs --output ./src/app',
    );
    expect(process.exitCode).toBe(1);
    consoleSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('should exit with a non-zero code when the output directory already contains generated files', () => {
    const outputDir = join(testDir, 'guarded-output');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'config.ts'), 'export const mine = true;\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['generate', 'hono', '-o', outputDir]);
    expect(process.exitCode).toBe(1);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should leave existing files untouched when generate is refused', () => {
    const outputDir = join(testDir, 'guarded-output');
    mkdirSync(outputDir, { recursive: true });
    const customized = 'export const mine = true;\n';
    writeFileSync(join(outputDir, 'config.ts'), customized);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['generate', 'hono', '-o', outputDir]);
    expect(readFileSync(join(outputDir, 'config.ts'), 'utf-8')).toBe(customized);
    expect(existsSync(join(outputDir, 'app.ts'))).toBe(false);
    expect(existsSync(join(outputDir, '.maronn-openid-connect.json'))).toBe(false);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should list every existing file in the refusal message', () => {
    const outputDir = join(testDir, 'guarded-output');
    mkdirSync(join(outputDir, 'endpoints', 'token'), { recursive: true });
    writeFileSync(join(outputDir, 'config.ts'), '// a\n');
    writeFileSync(join(outputDir, 'store.ts'), '// b\n');
    writeFileSync(join(outputDir, 'endpoints', 'token', 'pipeline.ts'), '// c\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['generate', 'hono', '-o', outputDir]);
    const output = errorSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toBe(
      [
        `Error: 3 file(s) already exist in ${outputDir}:`,
        '  config.ts',
        '  endpoints/token/pipeline.ts',
        '  store.ts',
        '',
        'Re-run with --force to overwrite them, or use -o <dir> to generate into a new directory.',
        'Tip: commit the generated files before overwriting so you can diff your changes.',
      ].join('\n'),
    );
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should not write any file when --dry-run is given', () => {
    const outputDir = join(testDir, 'dry-run-output');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['generate', 'hono', '-o', outputDir, '--dry-run']);
    expect(process.exitCode).toBe(undefined);
    expect(existsSync(outputDir)).toBe(false);
    vi.restoreAllMocks();
  });

  it('should refuse setup as well when the output directory already contains generated files', () => {
    const outputDir = join(testDir, 'oidc-provider');
    const srcDir = join(testDir, 'src');
    const entryFile = join(srcDir, 'index.ts');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      entryFile,
      "import { Hono } from 'hono';\n// <!-- OIDC_IMPORT_PLACEHOLDER -->\nconst app = new Hono();\n// <!-- OIDC_SETUP_PLACEHOLDER -->\n",
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    vi.restoreAllMocks();
    const afterFirstRun = readFileSync(entryFile, 'utf-8');
    // Every file of the first run is in the way of the second, except the
    // manifest, which is rewritten on every run.
    const generatedCount = readdirSync(outputDir, { recursive: true })
      .map(String)
      .filter((path) => statSync(join(outputDir, path)).isFile() && path !== '.maronn-openid-connect.json').length;

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((c) => String(c[0]))[0]).toBe(
      `Error: ${generatedCount} file(s) already exist in ${outputDir}:`,
    );
    expect(readFileSync(entryFile, 'utf-8')).toBe(afterFirstRun);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('should list --force and --dry-run in help output', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    run(['--help']);
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('--force');
    expect(output).toContain('--dry-run');
    consoleSpy.mockRestore();
  });

  // db/instance.ts is where the user writes the database instance, so the CLI
  // creates it only once and never overwrites it.
  // EXPERIMENTAL (RFC 7591): the CLI-side surface of --enable
  // dynamic-client-registration — option parsing and the install guidance.
  // The generated OP's behavior is covered by tests/e2e, not here.
  describe('--enable dynamic-client-registration', () => {
    it('should accept the feature name and generate without errors', () => {
      const outputDir = join(testDir, 'oidc-provider');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--enable', 'dynamic-client-registration']);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(undefined);
      vi.restoreAllMocks();
    });

    it('should add the experimental package to the install guidance when selected', () => {
      const outputDir = join(testDir, 'oidc-provider');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--enable', 'dynamic-client-registration']);
      const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(output).toContain(
        'Install dependencies: pnpm add hono @maronn-openid-connect/core @maronn-openid-connect/experimental',
      );
      vi.restoreAllMocks();
    });

    it('should keep the install guidance without the experimental package when not selected', () => {
      const outputDir = join(testDir, 'oidc-provider');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir]);
      const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
      expect(output).toContain('Install dependencies: pnpm add hono @maronn-openid-connect/core');
      expect(output).not.toContain('@maronn-openid-connect/experimental');
      vi.restoreAllMocks();
    });
  });

  describe('install guidance', () => {
    function guidanceOf(args: string[]): string {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', ...args, '-o', join(testDir, 'oidc-provider')]);
      const output = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      vi.restoreAllMocks();
      return output;
    }

    // The screens of the Express and Fastify output are hono/jsx, as in the Hono output.
    it('should add hono to the install guidance of the Express output', () => {
      expect(guidanceOf(['express'])).toContain(
        'Install dependencies: pnpm add express hono @maronn-openid-connect/core && pnpm add -D @types/express',
      );
    });

    it('should add hono to the install guidance of the Fastify output', () => {
      expect(guidanceOf(['fastify'])).toContain('Install dependencies: pnpm add fastify hono @maronn-openid-connect/core');
    });

    it('should tell the JSX settings for the Express output', () => {
      expect(guidanceOf(['express'])).toContain('"jsx": "react-jsx", "jsxImportSource": "hono/jsx"');
    });

    // The generated google-login feature imports google-auth-library itself.
    it('should add the packages of google-login to the install guidance', () => {
      expect(guidanceOf(['hono', '--enable', 'google-login'])).toContain(
        'Install dependencies: pnpm add hono @maronn-openid-connect/core @maronn-openid-connect/google-login google-auth-library',
      );
    });

    it('should add the experimental package once for several experimental features', () => {
      expect(guidanceOf(['hono', '--enable', 'id-jag', '--enable', 'rp-initiated-logout'])).toContain(
        'Install dependencies: pnpm add hono @maronn-openid-connect/core @maronn-openid-connect/experimental\n',
      );
    });

    it('should not name a store contract the generated code does not have', () => {
      expect(guidanceOf(['hono'])).not.toContain('JsonStoreBackend');
    });
  });

  describe('--db', () => {
    const userInstance = "export function createDatabase() { return myDatabase; }\n";

    function writeUserInstance(outputDir: string): string {
      const instancePath = join(outputDir, 'db', 'instance.ts');
      mkdirSync(join(outputDir, 'db'), { recursive: true });
      writeFileSync(instancePath, userInstance);
      return instancePath;
    }

    it.each(['sql', 'kv'])(
      'should keep an existing db/instance.ts when generating with --db %s --force',
      (kind) => {
        const outputDir = join(testDir, 'oidc-provider');
        const instancePath = writeUserInstance(outputDir);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['generate', 'hono', '-o', outputDir, '--db', kind, '--force']);
        expect(readFileSync(instancePath, 'utf-8')).toBe(userInstance);
        expect(process.exitCode).toBe(undefined);
        vi.restoreAllMocks();
      },
    );

    it.each(['sql', 'kv'])(
      'should not refuse generation with --db %s when db/instance.ts is the only existing file',
      (kind) => {
        const outputDir = join(testDir, 'oidc-provider');
        const instancePath = writeUserInstance(outputDir);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        run(['generate', 'hono', '-o', outputDir, '--db', kind]);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(undefined);
        expect(existsSync(join(outputDir, '.maronn-openid-connect.json'))).toBe(true);
        expect(readFileSync(instancePath, 'utf-8')).toBe(userInstance);
        vi.restoreAllMocks();
      },
    );

    it('should report the kept db/instance.ts in the generation log', () => {
      const outputDir = join(testDir, 'oidc-provider');
      writeUserInstance(outputDir);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--db', 'sql']);
      expect(logSpy).toHaveBeenCalledWith('  Kept: db/instance.ts (yours; never overwritten)');
      vi.restoreAllMocks();
    });

    it('should report the kept db/instance.ts in the --dry-run plan', () => {
      const outputDir = join(testDir, 'oidc-provider');
      writeUserInstance(outputDir);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--db', 'kv', '--dry-run']);
      expect(logSpy).toHaveBeenCalledWith('  Would keep: db/instance.ts (yours; never overwritten)');
      vi.restoreAllMocks();
    });

    it('should error without writing anything when --db has no kind', () => {
      const outputDir = join(testDir, 'oidc-provider');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--db']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error: --db needs a kind: --db sql (SQL tables) or --db kv (a key-value store)',
      );
      expect(process.exitCode).toBe(1);
      expect(existsSync(outputDir)).toBe(false);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should error without writing anything on an unknown --db kind', () => {
      const outputDir = join(testDir, 'oidc-provider');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--db', 'redis', '--force']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error: Unknown --db kind: "redis". Use --db sql (SQL tables) or --db kv (a key-value store)',
      );
      expect(process.exitCode).toBe(1);
      expect(existsSync(outputDir)).toBe(false);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should list both --db kinds in help output', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['--help']);
      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('--db <sql|kv>');
      consoleSpy.mockRestore();
    });
  });

  // `graph` draws the provider a run would generate; it writes no code.
  describe('graph', () => {
    function captureStdout(): { output: () => string; restore: () => void } {
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      return { output: () => chunks.join(''), restore: () => spy.mockRestore() };
    }

    it('should print a Mermaid flowchart of the default provider to stdout', () => {
      const stdout = captureStdout();
      run(['graph']);
      const lines = stdout.output().split('\n');
      stdout.restore();
      expect(process.exitCode).toBe(undefined);
      expect(lines[0]).toBe('flowchart LR');
      expect(lines.includes('    token["POST /token<br/>Token endpoint"]')).toBe(true);
      expect(lines.includes('  consent -->|"code"| token')).toBe(true);
    });

    it('should print the JSON flow document with the module of each endpoint for a framework', () => {
      const stdout = captureStdout();
      run(['graph', 'hono', '--format', 'json']);
      const document = JSON.parse(stdout.output()) as {
        version: number;
        endpoints: { id: string; module?: string; steps: { module?: string }[] }[];
      };
      stdout.restore();
      expect(document.version).toBe(1);
      const token = document.endpoints.find((e) => e.id === 'token');
      expect(token?.module).toBe('endpoints/token/pipeline.ts');
      expect(token?.steps[0]?.module).toBe('endpoints/token/steps/parse-request.ts');
    });

    it('should name the App Router module for nextjs', () => {
      const stdout = captureStdout();
      run(['graph', 'nextjs', '--format', 'json']);
      const document = JSON.parse(stdout.output()) as { endpoints: { id: string; module?: string }[] };
      stdout.restore();
      expect(document.endpoints.find((e) => e.id === 'discovery')?.module).toBe(
        '.well-known/openid-configuration/route.ts',
      );
    });

    it('should draw the steps of one endpoint with --detail steps --endpoint', () => {
      const stdout = captureStdout();
      run(['graph', '--detail', 'steps', '--endpoint', 'token', '--enable', 'token-exchange']);
      const output = stdout.output();
      stdout.restore();
      expect(output.startsWith('flowchart TD\n  subgraph token["POST /token<br/>Token endpoint"]\n')).toBe(true);
      expect(output.includes('token__dispatch_token_exchange[')).toBe(true);
      expect(output.includes('subgraph authorize[')).toBe(false);
    });

    it('should write the diagram to the --output file', () => {
      const file = join(testDir, 'diagrams', 'op.mmd');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['graph', '-o', file]);
      expect(logSpy).toHaveBeenCalledWith(`Wrote ${file}`);
      expect(readFileSync(file, 'utf-8').startsWith('flowchart LR\n')).toBe(true);
      vi.restoreAllMocks();
    });

    it('should error on an unknown format', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['graph', '--format', 'svg']);
      expect(errorSpy).toHaveBeenCalledWith('Error: --format needs one of mermaid, json, not "svg"');
      expect(process.exitCode).toBe(1);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should error on an unknown detail level', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['graph', '--detail']);
      expect(errorSpy).toHaveBeenCalledWith('Error: --detail needs one of endpoints, steps');
      expect(process.exitCode).toBe(1);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should error on an unknown endpoint', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['graph', '--endpoint', 'dpop']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error: Unknown endpoint: "dpop". Endpoints of this configuration: discovery, jwks, authorize, login, consent, token, userinfo, introspection, revocation',
      );
      expect(process.exitCode).toBe(1);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should error on an unknown framework', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['graph', 'koa']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error: Unknown framework: "koa". Available frameworks: hono, express, fastify, nextjs',
      );
      expect(process.exitCode).toBe(1);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should draw the rearranged provider of a flow document', () => {
      const stdout = captureStdout();
      run(['graph', '--format', 'json', '--disable', 'revocation']);
      const document = JSON.parse(stdout.output()) as {
        endpoints: { id: string; steps: { id: string }[] }[];
      };
      stdout.restore();
      const authorize = document.endpoints.find((e) => e.id === 'authorize');
      authorize!.steps = authorize!.steps.filter((s) => s.id !== 'verify-id-token-hint');
      document.endpoints.reverse();
      const file = join(testDir, 'op.flow.json');
      writeFileSync(file, JSON.stringify(document));

      const drawn = captureStdout();
      run(['graph', '--flow', file, '--format', 'json']);
      const redrawn = JSON.parse(drawn.output()) as { endpoints: { id: string; steps: { id: string }[] }[] };
      drawn.restore();
      expect(redrawn.endpoints.map((e) => e.id)).toEqual([
        'introspection',
        'userinfo',
        'token',
        'consent',
        'login',
        'authorize',
        'jwks',
        'discovery',
      ]);
      expect(
        redrawn.endpoints.find((e) => e.id === 'authorize')?.steps.some((s) => s.id === 'verify-id-token-hint'),
      ).toBe(false);
    });
  });

  // --flow generates from a flow document instead of the feature flags.
  describe('--flow', () => {
    function writeFlowDocument(name: string, edit: (document: any) => void = () => {}): string {
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      run(['graph', 'hono', '--format', 'json']);
      spy.mockRestore();
      const document = JSON.parse(chunks.join(''));
      edit(document);
      const file = join(testDir, name);
      writeFileSync(file, JSON.stringify(document));
      return file;
    }

    it('should generate from the document graph wrote and record its inputs in the manifest', () => {
      const file = writeFlowDocument('op.flow.json');
      const outputDir = join(testDir, 'oidc-provider');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--flow', file]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(undefined);
      const manifest = JSON.parse(readFileSync(join(outputDir, '.maronn-openid-connect.json'), 'utf-8'));
      expect(manifest.features.introspection).toBe(true);
      expect(manifest.steps).toBe(null);
      expect(manifest.endpointOrder).toBe(null);
      vi.restoreAllMocks();
    });

    it('should follow the feature flags of the document', () => {
      const file = writeFlowDocument('op.flow.json', (document) => {
        document.features.revocation = false;
        document.endpoints = document.endpoints.filter((e: { id: string }) => e.id !== 'revocation');
      });
      const outputDir = join(testDir, 'oidc-provider');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--flow', file]);
      expect(existsSync(join(outputDir, 'features', 'revocation'))).toBe(false);
      expect(existsSync(join(outputDir, 'features', 'introspection'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should record a rearranged endpoint order in the manifest', () => {
      const file = writeFlowDocument('op.flow.json', (document) => {
        document.endpoints.reverse();
      });
      const outputDir = join(testDir, 'oidc-provider');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--flow', file]);
      const manifest = JSON.parse(readFileSync(join(outputDir, '.maronn-openid-connect.json'), 'utf-8'));
      expect(manifest.endpointOrder).toEqual([
        'revocation',
        'introspection',
        'userinfo',
        'token',
        'consent',
        'login',
        'authorize',
        'jwks',
        'discovery',
      ]);
      vi.restoreAllMocks();
    });

    it('should refuse a rearranged step order for the Next.js output', () => {
      const file = writeFlowDocument('op.flow.json', (document) => {
        const authorize = document.endpoints.find((e: { id: string }) => e.id === 'authorize');
        authorize.steps = authorize.steps.filter((s: { id: string }) => s.id !== 'verify-id-token-hint');
      });
      const outputDir = join(testDir, 'app');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'nextjs', '-o', outputDir, '--flow', file]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error: The Next.js output does not follow a rearranged step order yet (endpoint "authorize"). Remove the steps changes from the flow document, or generate for hono, express or fastify',
      );
      expect(process.exitCode).toBe(1);
      expect(existsSync(outputDir)).toBe(false);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should error without writing anything when the document is invalid', () => {
      const file = writeFlowDocument('op.flow.json', (document) => {
        const token = document.endpoints.find((e: { id: string }) => e.id === 'token');
        token.steps = token.steps.filter((s: { id: string }) => s.id !== 'authenticate-client');
      });
      const outputDir = join(testDir, 'oidc-provider');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--flow', file]);
      expect(errorSpy).toHaveBeenCalledWith(
        `Error: ${file}: endpoint "token" leaves out step "authenticate-client", which cannot be removed`,
      );
      expect(process.exitCode).toBe(1);
      expect(existsSync(outputDir)).toBe(false);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should error when the flow file does not exist', () => {
      const outputDir = join(testDir, 'oidc-provider');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir, '--flow', join(testDir, 'missing.json')]);
      expect(errorSpy).toHaveBeenCalledWith(`Error: Flow file not found: ${join(testDir, 'missing.json')}`);
      expect(process.exitCode).toBe(1);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should error when --flow has no file', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'hono', '-o', join(testDir, 'oidc-provider'), '--flow']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error: --flow needs a file: --flow <file> (the JSON that `maronn-oidc graph --format json` writes)',
      );
      expect(process.exitCode).toBe(1);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should refuse --flow together with a feature flag', () => {
      const file = writeFlowDocument('op.flow.json');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      run(['generate', 'hono', '-o', join(testDir, 'oidc-provider'), '--flow', file, '--enable', 'par']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Error: --flow cannot be combined with --enable, --disable, --scope or --db: the flow document already carries the features, scopes and db it was drawn with',
      );
      expect(process.exitCode).toBe(1);
      vi.restoreAllMocks();
      process.exitCode = undefined;
    });

    it('should list --flow and the graph command in help output', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['--help']);
      const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('graph [framework]');
      expect(output).toContain('--flow <file>');
      expect(output).toContain('--format <mermaid|json>');
      consoleSpy.mockRestore();
    });
  });
});
