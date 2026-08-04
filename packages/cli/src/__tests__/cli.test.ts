import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { run } from '../index.js';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `maronn-cli-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('run', () => {
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

    it('should generate files with generate command', () => {
      const outputDir = join(testDir, 'output');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir]);
      expect(existsSync(join(outputDir, 'app.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'config.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'store.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'resolvers.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'views.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/authorize.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/token.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/userinfo.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/jwks.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/discovery.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/login.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/consent.ts'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should generate Express files with generate command', () => {
      const outputDir = join(testDir, 'express-output');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'express', '-o', outputDir]);
      expect(existsSync(join(outputDir, 'app.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'apply.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'node-adapter.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'web-router.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/authorize.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/token.ts'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should generate Fastify files with generate command', () => {
      const outputDir = join(testDir, 'fastify-output');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'fastify', '-o', outputDir]);
      expect(existsSync(join(outputDir, 'app.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'apply.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'node-adapter.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'web-router.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/userinfo.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'routes/jwks.ts'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should generate Next.js files with generate command', () => {
      const outputDir = join(testDir, 'next-output');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'nextjs', '-o', outputDir]);
      expect(existsSync(join(outputDir, '_oidc-provider/app.ts'))).toBe(true);
      expect(existsSync(join(outputDir, '_oidc-provider/next.ts'))).toBe(true);
      expect(existsSync(join(outputDir, '_oidc-provider/runtime.ts'))).toBe(true);
      expect(existsSync(join(outputDir, '_oidc-provider/web-router.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'authorize/route.ts'))).toBe(true);
      expect(existsSync(join(outputDir, 'token/route.ts'))).toBe(true);
      expect(existsSync(join(outputDir, '.well-known/openid-configuration/route.ts'))).toBe(true);
      vi.restoreAllMocks();
    });

    it('should generate files with correct core package import', () => {
      const outputDir = join(testDir, 'output');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      run(['generate', 'hono', '-o', outputDir]);
      const resolversContent = readFileSync(join(outputDir, 'resolvers.ts'), 'utf-8');
      expect(resolversContent).toContain('@maronn-openid-connect/core');
      vi.restoreAllMocks();
    });

    it('should instruct generated apps to inject persistent provider stores', () => {
      const outputDir = join(testDir, 'persistent-output');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      run(['generate', 'hono', '-o', outputDir]);

      expect(consoleSpy).toHaveBeenCalledWith(
        '  2. Inject persistent ProviderStores through the generated JsonStoreBackend contract',
      );
      vi.restoreAllMocks();
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

    describe('feature flags', () => {
      it('should skip disabled endpoint files with --disable', () => {
        const outputDir = join(testDir, 'features-output');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['generate', 'hono', '-o', outputDir, '--disable', 'introspection,revocation']);
        expect(existsSync(join(outputDir, 'routes/authorize.ts'))).toBe(true);
        expect(existsSync(join(outputDir, 'routes/introspection.ts'))).toBe(false);
        expect(existsSync(join(outputDir, 'routes/revocation.ts'))).toBe(false);
        vi.restoreAllMocks();
      });

      it('should accept repeated --disable flags', () => {
        const outputDir = join(testDir, 'features-repeat-output');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['generate', 'hono', '-o', outputDir, '--disable', 'introspection', '--disable', 'revocation']);
        expect(existsSync(join(outputDir, 'routes/introspection.ts'))).toBe(false);
        expect(existsSync(join(outputDir, 'routes/revocation.ts'))).toBe(false);
        vi.restoreAllMocks();
      });

      it('should error on an unknown feature name', () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['generate', 'hono', '-o', join(testDir, 'unused'), '--disable', 'dpop']);
        expect(consoleSpy).toHaveBeenCalledWith(
          'Error: Unknown feature: "dpop". Available features: pkce, refresh-token, introspection, revocation, request-object. Experimental features (disabled by default): par, token-exchange',
        );
        expect(process.exitCode).toBe(1);
        vi.restoreAllMocks();
        process.exitCode = undefined;
      });

      it('should generate the PAR route only when par is explicitly enabled', () => {
        const outputDir = join(testDir, 'par-enabled-output');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['generate', 'hono', '-o', outputDir, '--enable', 'par']);
        expect(existsSync(join(outputDir, 'routes/par.ts'))).toBe(true);
        vi.restoreAllMocks();
      });

      it('should not generate the PAR route by default', () => {
        const outputDir = join(testDir, 'par-default-output');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['generate', 'hono', '-o', outputDir]);
        expect(existsSync(join(outputDir, 'routes/par.ts'))).toBe(false);
        vi.restoreAllMocks();
      });

      it('should add the experimental package to the install guidance only when par is enabled', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['generate', 'hono', '-o', join(testDir, 'par-install-output'), '--enable', 'par']);
        const logged = consoleSpy.mock.calls.map((call) => String(call[0]));
        expect(logged.includes('  4. Install dependencies: pnpm add hono @maronn-openid-connect/core @maronn-openid-connect/experimental')).toBe(true);
        vi.restoreAllMocks();
      });

      it('should keep the install guidance unchanged when no experimental feature is enabled', () => {
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['generate', 'hono', '-o', join(testDir, 'default-install-output')]);
        const logged = consoleSpy.mock.calls.map((call) => String(call[0]));
        expect(logged.includes('  4. Install dependencies: pnpm add hono @maronn-openid-connect/core')).toBe(true);
        expect(logged.some((line) => line.includes('@maronn-openid-connect/experimental'))).toBe(false);
        vi.restoreAllMocks();
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
    });

    describe('setup command', () => {
      it('should generate OIDC files including apply.ts', () => {
        const outputDir = join(testDir, 'oidc-provider');
        const srcDir = join(testDir, 'src');
        const entryFile = join(srcDir, 'index.ts');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(entryFile, '// <!-- OIDC_IMPORT_PLACEHOLDER -->\n// <!-- OIDC_SETUP_PLACEHOLDER -->\n');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
        expect(existsSync(join(outputDir, 'apply.ts'))).toBe(true);
        expect(existsSync(join(outputDir, 'config.ts'))).toBe(true);
        expect(existsSync(join(outputDir, 'store.ts'))).toBe(true);
        vi.restoreAllMocks();
      });

      it('should patch entry file with both the applyOidc import and the applyOidc call', () => {
        const outputDir = join(testDir, 'oidc-provider');
        const srcDir = join(testDir, 'src');
        const entryFile = join(srcDir, 'index.ts');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
          entryFile,
          "import { Hono } from 'hono';\n// <!-- OIDC_IMPORT_PLACEHOLDER -->\nconst app = new Hono();\n// <!-- OIDC_SETUP_PLACEHOLDER -->\nexport default app;\n",
        );
        vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
        const content = readFileSync(entryFile, 'utf-8');
        expect(content).toBe(
          "import { Hono } from 'hono';\nimport { applyOidc } from '../oidc-provider/apply.js';\nconst app = new Hono();\napplyOidc(app);\nexport default app;\n",
        );
        expect(process.exitCode).toBe(undefined);
        vi.restoreAllMocks();
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

      // Writing `applyOidc(app);` without its import used to leave the user's entry
      // file in a state that does not type-check, while the CLI reported success.
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

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        run(['setup', 'hono', '-o', outputDir, '-e', entryFile]);
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
    });
  });
});
