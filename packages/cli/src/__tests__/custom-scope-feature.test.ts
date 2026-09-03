import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveFeatures } from '../features.js';
import { generate } from '../generator.js';
import { run } from '../index.js';
import {
  NO_CUSTOM_SCOPES,
  RESERVED_SCOPES,
  hasCustomScopes,
  hasPerUserScopes,
  listCustomScopes,
  listRestrictedScopes,
  resolveCustomScopes,
} from '../scopes.js';
import type { CustomScopeConfig } from '../scopes.js';

const FRAMEWORKS = ['hono', 'express', 'fastify', 'nextjs'] as const;

function generateFiles(
  framework: string,
  scopes: CustomScopeConfig,
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
    expect(resolveCustomScopes({})).toEqual(NO_CUSTOM_SCOPES);
    expect(hasCustomScopes(NO_CUSTOM_SCOPES)).toBe(false);
    expect(hasPerUserScopes(NO_CUSTOM_SCOPES)).toBe(false);
  });

  it('should split a comma-separated --scope list', () => {
    expect(resolveCustomScopes({ scope: ['reports.read, reports.write'] })).toEqual({
      global: ['reports.read', 'reports.write'],
      perUser: {},
    });
  });

  it('should accept --scope repeatedly and drop duplicates', () => {
    expect(resolveCustomScopes({ scope: ['reports.read', 'reports.read,billing.read'] })).toEqual({
      global: ['reports.read', 'billing.read'],
      perUser: {},
    });
  });

  it('should parse --user-scope as <subject>:<scope list>', () => {
    expect(
      resolveCustomScopes({ userScope: ['alice:admin.write,billing.read', 'bob:billing.read'] }),
    ).toEqual({
      global: [],
      perUser: { alice: ['admin.write', 'billing.read'], bob: ['billing.read'] },
    });
  });

  it('should merge repeated --user-scope declarations for the same subject', () => {
    expect(
      resolveCustomScopes({ userScope: ['alice:admin.write', 'alice:admin.write,billing.read'] }),
    ).toEqual({ global: [], perUser: { alice: ['admin.write', 'billing.read'] } });
  });

  // The split is on the FIRST colon, which is what lets a URN-shaped scope name
  // survive (RFC 6749 §3.3 allows ':' inside a scope token).
  it('should split on the first colon so a scope name may contain colons', () => {
    expect(resolveCustomScopes({ userScope: ['alice:urn:example:reports'] })).toEqual({
      global: [],
      perUser: { alice: ['urn:example:reports'] },
    });
  });

  it('should reject a standard scope declared as custom', () => {
    for (const reserved of RESERVED_SCOPES) {
      expect(() => resolveCustomScopes({ scope: [reserved] })).toThrow(
        `Scope "${reserved}" is a standard scope`,
      );
    }
    expect(() => resolveCustomScopes({ userScope: ['alice:email'] })).toThrow(
      'Scope "email" is a standard scope',
    );
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

  it('should reject a --user-scope value without a subject', () => {
    expect(() => resolveCustomScopes({ userScope: ['admin.write'] })).toThrow(
      'Expected <subject>:<scope>',
    );
    expect(() => resolveCustomScopes({ userScope: [':admin.write'] })).toThrow(
      'Expected <subject>:<scope>',
    );
    expect(() => resolveCustomScopes({ userScope: ['  :admin.write'] })).toThrow(
      'Invalid --user-scope subject',
    );
  });

  it('should reject a --user-scope value without a scope', () => {
    expect(() => resolveCustomScopes({ userScope: ['alice:'] })).toThrow(
      '--user-scope requires at least one scope name',
    );
  });

  // Declaring both would be a contradiction: the global declaration already
  // grants it to everyone, so the per-user restriction could never apply.
  it('should reject a scope declared both globally and per user, in either order', () => {
    expect(() =>
      resolveCustomScopes({ scope: ['admin.write'], userScope: ['alice:admin.write'] }),
    ).toThrow('has no effect');
    expect(() =>
      resolveCustomScopes({ userScope: ['alice:admin.write'], scope: ['admin.write'] }),
    ).toThrow('has no effect');
  });

  it('should report which scopes are restricted to specific subjects', () => {
    const scopes = resolveCustomScopes({
      scope: ['reports.read'],
      userScope: ['alice:admin.write', 'bob:billing.read'],
    });

    expect(listCustomScopes(scopes)).toEqual(['reports.read', 'admin.write', 'billing.read']);
    expect(listRestrictedScopes(scopes)).toEqual(['admin.write', 'billing.read']);
    expect(hasPerUserScopes(scopes)).toBe(true);
  });
});

describe('generation without custom scopes', () => {
  it.each(FRAMEWORKS)('should not generate a scope policy module for %s', (framework) => {
    const files = generateFiles(framework, NO_CUSTOM_SCOPES);

    expect(files.some((file) => file.path.endsWith('scopes.ts'))).toBe(false);
  });

  // The whole feature is opt-in: a provider generated without a declaration must
  // not gain a scope allow list, so it keeps accepting arbitrary scope values.
  it.each(FRAMEWORKS)('should not reference the scope policy anywhere for %s', (framework) => {
    const files = generateFiles(framework, NO_CUSTOM_SCOPES, [
      'par',
      'device-authorization-grant',
      'ciba',
      'jarm',
      'transaction-binding',
    ]);

    for (const file of files) {
      expect(file.content).not.toContain('findUnsupportedScopes');
      expect(file.content).not.toContain('resolveGrantableScopes');
      expect(file.content).not.toContain("from '../scopes.js'");
    }
  });
});

describe('generated scopes.ts', () => {
  const scopes = resolveCustomScopes({
    scope: ['reports.read'],
    userScope: ['alice:admin.write'],
  });

  it.each(FRAMEWORKS)('should generate the policy module for %s', (framework) => {
    const files = generateFiles(framework, scopes);
    const content = fileContent(files, internalPath(framework, 'scopes.ts'));

    expect(content).toContain(
      "export const GLOBAL_CUSTOM_SCOPES: readonly string[] = ['reports.read'];",
    );
    expect(content).toContain("'alice': ['admin.write'],");
    expect(content).toContain('export function findUnsupportedScopes(');
    expect(content).toContain('export function resolveGrantableScopes(');
  });

  it('should advertise offline_access as a standard scope with the refresh-token feature on', () => {
    const content = fileContent(generateFiles('hono', scopes), 'scopes.ts');

    expect(content).toContain(
      "export const STANDARD_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'];",
    );
  });

  // OIDC Core 1.0 §11: without the refresh-token feature offline_access is never
  // granted, so it must not become part of the advertised allow list either.
  it('should drop offline_access from the standard scopes with --disable refresh-token', () => {
    const content = fileContent(
      generateFiles('hono', scopes, [], ['refresh-token']),
      'scopes.ts',
    );

    expect(content).toContain(
      "export const STANDARD_SCOPES: readonly string[] = ['openid', 'profile', 'email', 'address', 'phone'];",
    );
  });

  it('should escape a scope name that contains a quote', () => {
    const content = fileContent(
      generateFiles('hono', { global: ["reports'read"], perUser: {} }),
      'scopes.ts',
    );

    expect(content).toContain("['reports\\'read']");
  });
});

describe('generated authorization endpoint', () => {
  const globalOnly = resolveCustomScopes({ scope: ['reports.read'] });
  const perUser = resolveCustomScopes({ userScope: ['alice:admin.write'] });

  it.each(FRAMEWORKS)('should reject an undeclared scope with invalid_scope on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, globalOnly),
      internalPath(framework, 'routes/authorize.ts'),
    );

    expect(content).toContain("import {\n  findUnsupportedScopes,\n}");
    expect(content).toContain('const unsupportedScopes = findUnsupportedScopes(scope);');
    expect(content).toContain('AuthorizationErrorCode.InvalidScope');
  });

  // OIDC Core 1.0 §11 requires ignoring an offline_access that cannot be granted,
  // so the allow-list check must run after applyOfflineAccessPolicy dropped it.
  it('should check the allow list after the offline_access policy', () => {
    const content = fileContent(generateFiles('hono', globalOnly), 'routes/authorize.ts');

    expect(content.indexOf('scope = await applyOfflineAccessPolicy')).toBeLessThan(
      content.indexOf('const unsupportedScopes = findUnsupportedScopes(scope)'),
    );
  });

  it('should not narrow per user when only --scope was declared', () => {
    const content = fileContent(generateFiles('hono', globalOnly), 'routes/authorize.ts');

    expect(content).not.toContain('resolveGrantableScopes');
  });

  // Both non-interactive paths decide the grant without reaching /consent, and
  // both look up consent by scope, so each has to narrow before that lookup.
  it.each(FRAMEWORKS)('should narrow prompt=none and SSO by subject on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, perUser),
      internalPath(framework, 'routes/authorize.ts'),
    );

    expect(content).toContain('resolveGrantableScopes(\n          transaction.scope');
    expect(content.indexOf('session.subject,\n        ).join(\' \');')).toBeLessThan(
      content.indexOf('await validatePromptNoneConsent('),
    );
    expect(content.indexOf('existingSession.subject,\n          ).join(\' \');')).toBeLessThan(
      content.indexOf('await consentResolver.hasConsent('),
    );
  });
});

describe('generated consent step', () => {
  const perUser = resolveCustomScopes({ userScope: ['alice:admin.write'] });

  it.each(FRAMEWORKS)('should narrow the granted scope by subject on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, perUser),
      internalPath(framework, 'routes/consent.ts'),
    );

    expect(content).toContain(
      `import { resolveGrantableScopes } from '${scopeModuleSpecifier(framework)}';`,
    );
    expect(content).toContain(
      'const grantedScope = resolveGrantableScopes(\n    transaction.scope.split(\' \').filter(Boolean),\n    session.subject,\n  );',
    );
  });

  it.each(FRAMEWORKS)('should display only the grantable scopes on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, perUser),
      internalPath(framework, 'routes/consent.ts'),
    );

    expect(content).toContain('const consentSession = await authSessionStore.get(transactionId);');
    expect(content).toContain('scopes: displayedScopes,');
  });

  it('should not touch the consent route when only --scope was declared', () => {
    const content = fileContent(
      generateFiles('hono', resolveCustomScopes({ scope: ['reports.read'] })),
      'routes/consent.ts',
    );

    expect(content).not.toContain('resolveGrantableScopes');
  });

  // Next.js drives consent through a page + Server Action instead of the
  // framework-neutral route, so both need the same narrowing.
  it('should narrow the Next.js consent page and Server Action', () => {
    const files = generateFiles('nextjs', perUser);

    expect(fileContent(files, 'consent/page.tsx')).toContain(
      "import { resolveGrantableScopes } from '../_oidc-provider/scopes';",
    );
    expect(fileContent(files, 'consent/actions.ts')).toContain(
      'const grantedScope = resolveGrantableScopes(',
    );
  });
});

describe('generated discovery metadata', () => {
  it.each(FRAMEWORKS)('should advertise the declared scopes on %s', (framework) => {
    const content = fileContent(
      generateFiles(
        framework,
        resolveCustomScopes({ scope: ['reports.read'], userScope: ['alice:admin.write'] }),
      ),
      internalPath(framework, 'routes/discovery.ts'),
    );

    expect(content).toContain(
      `import { SUPPORTED_SCOPES } from '${scopeModuleSpecifier(framework)}';`,
    );
    expect(content).toContain('scopesSupported: [...SUPPORTED_SCOPES],');
  });

  it('should keep the literal scope list without custom scopes', () => {
    const content = fileContent(generateFiles('hono', NO_CUSTOM_SCOPES), 'routes/discovery.ts');

    expect(content).toContain(
      "scopesSupported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],",
    );
  });
});

describe('generated experimental request endpoints', () => {
  const scopes = resolveCustomScopes({
    scope: ['reports.read'],
    userScope: ['alice:admin.write'],
  });

  it('should apply the allow list to the device authorization endpoint', () => {
    const content = fileContent(
      generateFiles('hono', scopes, ['device-authorization-grant']),
      'routes/device-authorization.ts',
    );

    expect(content).toContain('const unsupportedScopes = findUnsupportedScopes(scope);');
    expect(content).toContain("throw new DeviceAuthorizationError(\n        'invalid_scope',");
  });

  it('should narrow the device approval by subject', () => {
    const content = fileContent(
      generateFiles('hono', scopes, ['device-authorization-grant']),
      'routes/device.ts',
    );

    expect(content).toContain('approved.approvedScope = resolveGrantableScopes(');
    expect(content).toContain('await deviceStore.update(approved);');
    expect(content).toContain('scopes: resolveGrantableScopes(record.scope, session.subject),');
  });

  // CIBA §7.1 leaves offline_access to the pipeline's own policy, so the
  // pre-check must not turn an ignorable offline_access into invalid_scope.
  it('should apply the allow list to the backchannel authentication endpoint', () => {
    const content = fileContent(
      generateFiles('hono', scopes, ['ciba']),
      'routes/backchannel-authentication.ts',
    );

    expect(content).toContain("scope.length > 0 && scope !== 'offline_access'");
    expect(content).toContain("throw new BackchannelAuthenticationError(\n        'invalid_scope',");
  });

  it('should narrow the CIBA approval by subject', () => {
    const content = fileContent(
      generateFiles('hono', scopes, ['ciba']),
      'routes/ciba-verification.ts',
    );

    expect(content).toContain('approved.approvedScope = resolveGrantableScopes(');
    expect(content).toContain('await cibaStore.update(approved);');
  });
});

describe('generated conformance test', () => {
  const scopes = resolveCustomScopes({
    scope: ['reports.read'],
    userScope: ['alice:admin.write', 'testuser:billing.read'],
  });

  it.each(FRAMEWORKS)('should pin the declared scopes in scopes_supported on %s', (framework) => {
    const content = fileContent(
      generateFiles(framework, scopes),
      internalPath(framework, 'conformance.test.ts'),
    );

    expect(content).toContain("        'offline_access',\n        'reports.read',\n        'admin.write',\n        'billing.read',\n");
  });

  it('should pin both directions of the per-user policy', () => {
    const content = fileContent(generateFiles('hono', scopes), 'conformance.test.ts');

    expect(content).toContain("describe('Custom scopes', () => {");
    expect(content).toContain('should reject a scope that was never declared with invalid_scope');
    expect(content).toContain(
      'should grant the globally declared scope reports.read to an authenticated End-User',
    );
    expect(content).toContain('should grant billing.read to testuser, who was declared for it');
    expect(content).toContain(
      'should drop admin.write from the grant of an End-User it was not declared for',
    );
    expect(content).toContain("resolveGrantableScopes(requested, 'alice')");
  });

  it('should not generate the custom scope block without a declaration', () => {
    const content = fileContent(generateFiles('hono', NO_CUSTOM_SCOPES), 'conformance.test.ts');

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

  it('should write scopes.ts for --scope and --user-scope', () => {
    testDir = mkdtempSync(join(tmpdir(), 'maronn-cli-scope-'));
    const outputDir = join(testDir, 'out');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    run([
      'generate',
      'hono',
      '-o',
      outputDir,
      '--scope',
      'reports.read',
      '--user-scope',
      'alice:admin.write',
    ]);

    expect(existsSync(join(outputDir, 'scopes.ts'))).toBe(true);
    const content = readFileSync(join(outputDir, 'scopes.ts'), 'utf-8');
    expect(content).toContain("['reports.read']");
    expect(content).toContain("'alice': ['admin.write'],");
  });

  it('should report the declared scopes', () => {
    testDir = mkdtempSync(join(tmpdir(), 'maronn-cli-scope-'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    run([
      'generate',
      'hono',
      '-o',
      join(testDir, 'out'),
      '--scope',
      'reports.read',
      '--user-scope',
      'alice:admin.write',
    ]);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('Custom scopes: reports.read, admin.write');
    expect(output).toContain('Allowed only for alice: admin.write');
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

  it('should document both options in the help output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    run(['--help']);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('--scope <scopes>');
    expect(output).toContain('--user-scope <value>');
  });
});
