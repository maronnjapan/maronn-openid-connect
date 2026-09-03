import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveFeatures } from '../features.js';
import { generate } from '../generator.js';
import { run } from '../index.js';
import { RESERVED_SCOPES, resolveCustomScopes } from '../scopes.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;

function generateFiles(
  framework: string,
  scopes: string[],
  enable: string[] = [],
  disable: string[] = [],
) {
  return generate({
    framework,
    outputDir: './out',
    features: resolveFeatures({ enable, disable }),
    scopes,
  }).files;
}

function fileContent(files: Array<{ path: string; content: string }>, path: string): string {
  return files.find((file) => file.path === path)?.content ?? '';
}

/** Next.js keeps the framework-neutral modules under _oidc-provider/. */
function internalPath(framework: string, path: string): string {
  return framework === 'nextjs' ? `_oidc-provider/${path}` : path;
}

/** Next.js modules import without the .js extension (bundler resolution). */
function scopeModuleSpecifier(framework: string): string {
  return framework === 'nextjs' ? '../scopes' : '../scopes.js';
}

describe('resolveCustomScopes', () => {
  it('should declare no custom scope by default', () => {
    expect(resolveCustomScopes({})).toEqual([]);
  });

  it('should split a comma-separated --scope list', () => {
    expect(resolveCustomScopes({ scope: ['reports.read, reports.write'] })).toEqual([
      'reports.read',
      'reports.write',
    ]);
  });

  it('should accept --scope repeatedly and drop duplicates', () => {
    expect(resolveCustomScopes({ scope: ['reports.read', 'reports.read,billing.read'] })).toEqual([
      'reports.read',
      'billing.read',
    ]);
  });

  // RFC 6749 §3.3 allows ':' inside a scope token, so URN-shaped names work.
  it('should accept a URN-shaped scope name', () => {
    expect(resolveCustomScopes({ scope: ['urn:example:reports'] })).toEqual([
      'urn:example:reports',
    ]);
  });

  it('should reject a standard scope declared as custom', () => {
    for (const reserved of RESERVED_SCOPES) {
      expect(() => resolveCustomScopes({ scope: [reserved] })).toThrow(
        `Scope "${reserved}" is a standard scope`,
      );
    }
  });

  it('should reject a scope value outside the RFC 6749 scope-token charset', () => {
    expect(() => resolveCustomScopes({ scope: ['reports read'] })).toThrow(
      'Invalid scope value for --scope',
    );
    expect(() => resolveCustomScopes({ scope: ['reports"read'] })).toThrow(
      'Invalid scope value for --scope',
    );
    expect(() => resolveCustomScopes({ scope: ['reports\\read'] })).toThrow(
      'Invalid scope value for --scope',
    );
  });

  it('should reject an empty --scope value', () => {
    expect(() => resolveCustomScopes({ scope: [' , '] })).toThrow(
      '--scope requires at least one scope name',
    );
  });
});

describe('generation without custom scopes', () => {
  it.each(FRAMEWORKS)('should not generate a scope policy module for %s', (framework) => {
    const files = generateFiles(framework, []);

    expect(files.some((file) => file.path.endsWith('scopes.ts'))).toBe(false);
  });

  // The whole feature is opt-in: a provider generated without a declaration must
  // not gain a scope allow list, so it keeps accepting arbitrary scope values.
  it.each(FRAMEWORKS)('should not reference the scope policy anywhere for %s', (framework) => {
    const files = generateFiles(framework, [], [
      'par',
      'device-authorization-grant',
      'ciba',
      'jarm',
      'transaction-binding',
    ]);

    for (const file of files) {
      expect(file.content).not.toContain('findUnsupportedScopes');
      expect(file.content).not.toContain('resolveGrantableScopes');
      expect(file.content).not.toContain('scopes.js');
    }
  });
});

describe('generated scopes.ts', () => {
  it.each(FRAMEWORKS)('should generate the scope policy module for %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, ['reports.read']),
      internalPath(framework, 'scopes.ts'),
    );

    expect(content).toContain(
      "export const CUSTOM_SCOPES: readonly string[] = ['reports.read'];",
    );
    expect(content).toContain(
      'export const SUPPORTED_SCOPES: readonly string[] = [...STANDARD_SCOPES, ...CUSTOM_SCOPES];',
    );
    expect(content).toContain('export function findUnsupportedScopes(');
  });

  // The seam the CLI deliberately does NOT model: which End-User may hold which
  // scope is written here, not passed as a flag.
  it('should expose an async per-End-User filtering seam with an empty default', () => {
    const content = fileContent(generateFiles('hono', ['reports.read']), 'scopes.ts');

    expect(content).toContain(
      'export const RESTRICTED_SCOPE_SUBJECTS: Record<string, readonly string[]> = {',
    );
    expect(content).toContain("  // 'reports.read': ['testuser'],");
    expect(content).toContain(
      'export async function resolveGrantableScopes(\n  requested: readonly string[],\n  subject: string,\n): Promise<string[]> {',
    );
  });

  it('should advertise offline_access as a standard scope with the refresh-token feature on', () => {
    const content = fileContent(generateFiles('hono', ['reports.read']), 'scopes.ts');

    expect(content).toContain(
      "export const STANDARD_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'];",
    );
  });

  // OIDC Core 1.0 §11: without the refresh-token feature offline_access is never
  // granted, so it must not become part of the advertised allow list either.
  it('should drop offline_access from the standard scopes with --disable refresh-token', () => {
    const content = fileContent(
      generateFiles('hono', ['reports.read'], [], ['refresh-token']),
      'scopes.ts',
    );

    expect(content).toContain(
      "export const STANDARD_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'address', 'phone'];",
    );
  });

  it('should escape a scope name that contains a quote', () => {
    const content = fileContent(generateFiles('hono', ["reports'read"]), 'scopes.ts');

    expect(content).toContain("['reports\\'read']");
  });
});

describe('generated authorization endpoint', () => {
  it.each(FRAMEWORKS)('should reject an undeclared scope with invalid_scope on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, ['reports.read']),
      internalPath(framework, 'routes/authorize.ts'),
    );

    expect(content).toContain(
      `import { findUnsupportedScopes, resolveGrantableScopes } from '${scopeModuleSpecifier(framework)}';`,
    );
    expect(content).toContain('const unsupportedScopes = findUnsupportedScopes(scope);');
    expect(content).toContain('AuthorizationErrorCode.InvalidScope');
  });

  // OIDC Core 1.0 §11 requires ignoring an offline_access that cannot be granted,
  // so the allow-list check must run after applyOfflineAccessPolicy dropped it.
  it('should check the allow list after the offline_access policy', () => {
    const content = fileContent(generateFiles('hono', ['reports.read']), 'routes/authorize.ts');

    expect(content.indexOf('scope = await applyOfflineAccessPolicy')).toBeLessThan(
      content.indexOf('const unsupportedScopes = findUnsupportedScopes(scope)'),
    );
  });

  // Both grant without showing consent, and both look consent up by scope, so
  // each has to apply the policy before that lookup or it could never match.
  it.each(FRAMEWORKS)(
    'should apply the policy before the consent lookup of prompt=none and SSO on %s',
    (framework) => {
      const content = fileContent(
        generateFiles(framework, ['reports.read']),
        internalPath(framework, 'routes/authorize.ts'),
      );

      expect(content).toContain('transaction.scope = (await resolveGrantableScopes(');
      expect(content.indexOf("session.subject,\n        )).join(' ');")).toBeLessThan(
        content.indexOf('await validatePromptNoneConsent('),
      );
      expect(content.indexOf("existingSession.subject,\n          )).join(' ');")).toBeLessThan(
        content.indexOf('await consentResolver.hasConsent('),
      );
    },
  );
});

describe('generated consent step', () => {
  it.each(FRAMEWORKS)('should apply the policy to the granted scope on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, ['reports.read']),
      internalPath(framework, 'routes/consent.ts'),
    );

    expect(content).toContain(
      `import { resolveGrantableScopes } from '${scopeModuleSpecifier(framework)}';`,
    );
    expect(content).toContain(
      "const grantedScope = await resolveGrantableScopes(\n    transaction.scope.split(' ').filter(Boolean),\n    session.subject,\n  );",
    );
  });

  it.each(FRAMEWORKS)('should display only the grantable scopes on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, ['reports.read']),
      internalPath(framework, 'routes/consent.ts'),
    );

    expect(content).toContain('const consentSession = await authSessionStore.get(transactionId);');
    expect(content).toContain('scopes: displayedScopes,');
  });

  // Next.js drives consent through a page + Server Action instead of the
  // framework-neutral route, so both need the same policy call.
  it('should apply the policy in the Next.js consent page and Server Action', () => {
    const files = generateFiles('nextjs', ['reports.read']);

    expect(fileContent(files, 'consent/page.tsx')).toContain(
      "import { resolveGrantableScopes } from '../_oidc-provider/scopes';",
    );
    expect(fileContent(files, 'consent/actions.ts')).toContain(
      'const grantedScope = await resolveGrantableScopes(',
    );
  });
});

describe('generated discovery metadata', () => {
  it.each(FRAMEWORKS)('should advertise the declared scopes on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, ['reports.read']),
      internalPath(framework, 'routes/discovery.ts'),
    );

    expect(content).toContain(
      `import { SUPPORTED_SCOPES } from '${scopeModuleSpecifier(framework)}';`,
    );
    expect(content).toContain('scopesSupported: [...SUPPORTED_SCOPES],');
  });

  it('should keep the literal scope list without custom scopes', () => {
    const content = fileContent(generateFiles('hono', []), 'routes/discovery.ts');

    expect(content).toContain(
      "scopesSupported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],",
    );
  });
});

describe('generated experimental endpoints', () => {
  it('should apply the allow list to the device authorization endpoint', () => {
    const content = fileContent(
      generateFiles('hono', ['reports.read'], ['device-authorization-grant']),
      'routes/device-authorization.ts',
    );

    expect(content).toContain('const unsupportedScopes = findUnsupportedScopes(scope);');
    expect(content).toContain("throw new DeviceAuthorizationError(\n        'invalid_scope',");
  });

  it('should apply the policy to the device approval', () => {
    const content = fileContent(
      generateFiles('hono', ['reports.read'], ['device-authorization-grant']),
      'routes/device.ts',
    );

    expect(content).toContain('approved.approvedScope = await resolveGrantableScopes(');
    expect(content).toContain('await deviceStore.update(approved);');
    expect(content).toContain(
      'scopes: await resolveGrantableScopes(record.scope, session.subject),',
    );
  });

  // CIBA §7.1 leaves offline_access to the pipeline's own policy, so the
  // pre-check must not turn an ignorable offline_access into invalid_scope.
  it('should apply the allow list to the backchannel authentication endpoint', () => {
    const content = fileContent(
      generateFiles('hono', ['reports.read'], ['ciba']),
      'routes/backchannel-authentication.ts',
    );

    expect(content).toContain("scope.length > 0 && scope !== 'offline_access'");
    expect(content).toContain("throw new BackchannelAuthenticationError(\n        'invalid_scope',");
  });

  it('should apply the policy to the CIBA approval and pending listing', () => {
    const content = fileContent(
      generateFiles('hono', ['reports.read'], ['ciba']),
      'routes/ciba-verification.ts',
    );

    expect(content).toContain('approved.approvedScope = await resolveGrantableScopes(');
    expect(content).toContain('await cibaStore.update(approved);');
    expect(content).toContain('scopes: await resolveGrantableScopes(record.scope, subject),');
  });
});

describe('generated conformance test', () => {
  it.each(FRAMEWORKS)('should pin the declared scopes in scopes_supported on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, ['reports.read', 'reports.write']),
      internalPath(framework, 'conformance.test.ts'),
    );

    expect(content).toContain(
      "        'offline_access',\n        'reports.read',\n        'reports.write',\n",
    );
  });

  it('should pin the allow list and the filtering seam', () => {
    const content = fileContent(generateFiles('hono', ['reports.read']), 'conformance.test.ts');

    expect(content).toContain("describe('Custom scopes', () => {");
    expect(content).toContain('should reject a scope that was never declared with invalid_scope');
    expect(content).toContain(
      'should grant the declared scope reports.read to an authenticated End-User',
    );
    expect(content).toContain('should honor a per-End-User restriction written in scopes.ts');
    expect(content).toContain("RESTRICTED_SCOPE_SUBJECTS['reports.read'] = ['otheruser'];");
  });

  it('should not generate the custom scope block without a declaration', () => {
    const content = fileContent(generateFiles('hono', []), 'conformance.test.ts');

    expect(content).not.toContain("describe('Custom scopes'");
  });
});

describe('CLI', () => {
  let testDir: string | undefined;

  afterEach(() => {
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    testDir = undefined;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('should write scopes.ts for --scope', () => {
    testDir = mkdtempSync(join(tmpdir(), 'maronn-cli-scope-'));
    const outputDir = join(testDir, 'out');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    run(['generate', 'hono', '-o', outputDir, '--scope', 'reports.read,reports.write']);

    expect(existsSync(join(outputDir, 'scopes.ts'))).toBe(true);
    expect(readFileSync(join(outputDir, 'scopes.ts'), 'utf-8')).toContain(
      "['reports.read', 'reports.write']",
    );
  });

  it('should report the declared scopes and where the filtering goes', () => {
    testDir = mkdtempSync(join(tmpdir(), 'maronn-cli-scope-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    run(['generate', 'hono', '-o', join(testDir, 'out'), '--scope', 'reports.read']);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('Custom scopes: reports.read');
    expect(output).toContain('resolveGrantableScopes()');
  });

  it('should fail on an invalid scope declaration without writing files', () => {
    testDir = mkdtempSync(join(tmpdir(), 'maronn-cli-scope-'));
    const outputDir = join(testDir, 'out');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    run(['generate', 'hono', '-o', outputDir, '--scope', 'openid']);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('is a standard scope handled by the generated provider'),
    );
    expect(process.exitCode).toBe(1);
    expect(existsSync(outputDir)).toBe(false);
  });

  it('should document --scope in the help output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    run(['--help']);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('--scope <scopes>');
    expect(output).toContain('resolveGrantableScopes()');
  });
});
