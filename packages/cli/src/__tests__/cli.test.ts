import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run } from '../index.js';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
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
      'Error: Unknown feature: "dpop". Available features: pkce, refresh-token, introspection, revocation, request-object. Experimental features (disabled by default): par, token-exchange, jarm, device-authorization-grant, id-jag, ciba, jwt-introspection-response, rp-initiated-logout. Extension features (disabled by default): google-login',
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
    mkdirSync(join(outputDir, 'routes'), { recursive: true });
    writeFileSync(join(outputDir, 'config.ts'), '// a\n');
    writeFileSync(join(outputDir, 'store.ts'), '// b\n');
    writeFileSync(join(outputDir, 'routes', 'token.ts'), '// c\n');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['generate', 'hono', '-o', outputDir]);
    const output = errorSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toBe(
      [
        `Error: 3 file(s) already exist in ${outputDir}:`,
        '  config.ts',
        '  store.ts',
        '  routes/token.ts',
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

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.map((c) => String(c[0]))[0]).toBe(
      `Error: 20 file(s) already exist in ${outputDir}:`,
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
});
