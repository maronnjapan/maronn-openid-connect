import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveFeatures } from '../features.js';
import { generate } from '../generator.js';
import { run } from '../index.js';
import { RESERVED_SCOPES, resolveCustomScopes } from '../scopes.js';

// The targets that share the authorize / consent / discovery route templates.
// Next.js applies the same scope policy from its own Route Handlers, page and
// Server Action and is covered separately below.
const FRAMEWORKS = ['hono', 'express', 'fastify'] as const;

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
    const content = fileContent(generateFiles(framework, ['reports.read']), 'scopes.ts');

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
    const content = fileContent(generateFiles(framework, ['reports.read']), 'routes/authorize.ts');

    expect(content).toContain(
      "import { findUnsupportedScopes, resolveGrantableScopes } from '../scopes.js';",
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
      const content = fileContent(generateFiles(framework, ['reports.read']), 'routes/authorize.ts');

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
    const content = fileContent(generateFiles(framework, ['reports.read']), 'routes/consent.ts');

    expect(content).toContain("import { resolveGrantableScopes } from '../scopes.js';");
    expect(content).toContain(
      "const grantedScope = await resolveGrantableScopes(\n    transaction.scope.split(' ').filter(Boolean),\n    session.subject,\n  );",
    );
  });

  // prepareConsent() (routes/consent.ts) applies the same policy to the scopes
  // it hands the consent screen, so the End-User never sees a scope they
  // cannot be granted — and pages/consent.ts only displays what it is given.
  it.each(FRAMEWORKS)('should display only the grantable scopes on %s', (framework) => {
    const content = fileContent(generateFiles(framework, ['reports.read']), 'routes/consent.ts');

    expect(content).toContain('const consentSession = await authSessionStore.get(transactionId);');
    expect(content).toContain('scopes: displayedScopes,');
  });
});

describe('generated discovery metadata', () => {
  it.each(FRAMEWORKS)('should advertise the declared scopes on %s', (framework) => {
    const content = fileContent(generateFiles(framework, ['reports.read']), 'routes/discovery.ts');

    expect(content).toContain("import { SUPPORTED_SCOPES } from '../scopes.js';");
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
      'conformance.test.ts',
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

// Next.js applies the same policy module (_oidc-provider/scopes.ts) from its own
// files: the authorization Route Handler, the consent page and its Server
// Action, discovery, and the device / CIBA Route Handlers.
describe('generate nextjs with --scope', () => {
  const nextJsFile = (path: string, scopes: string[] = ['reports.read'], enable: string[] = []) =>
    fileContent(generateFiles('nextjs', scopes, enable), path);

  describe('Generation without custom scopes', () => {
    it('should not generate a scope policy module', () => {
      const paths = generateFiles('nextjs', []).map((file) => file.path);

      expect(paths.filter((path) => path.endsWith('scopes.ts'))).toEqual([]);
    });

    // The whole feature is opt-in: without a declaration the provider keeps
    // accepting arbitrary scope values.
    it('should not reference the scope policy anywhere', () => {
      const referencing = generateFiles('nextjs', [], [
        'par',
        'device-authorization-grant',
        'ciba',
        'jarm',
        'transaction-binding',
      ])
        .filter(
          (file) =>
            file.content.includes('findUnsupportedScopes') ||
            file.content.includes('resolveGrantableScopes') ||
            file.content.includes("_oidc-provider/scopes'") ||
            file.content.includes("from './scopes'"),
        )
        .map((file) => file.path);

      expect(referencing).toEqual([]);
    });

    it('should keep the literal scope list in discovery', () => {
      expect(nextJsFile('.well-known/openid-configuration/route.ts', [])).toContain(
        "scopesSupported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access'],",
      );
    });

    it('should not generate the custom scope contract block', () => {
      expect(nextJsFile('_oidc-provider/conformance.test.ts', [])).not.toContain("describe('Custom scopes");
    });
  });

  describe('Scope policy module (_oidc-provider/scopes.ts)', () => {
    it('should generate the allow list and the filtering seam', () => {
      const content = nextJsFile('_oidc-provider/scopes.ts');

      expect(content).toContain("export const CUSTOM_SCOPES: readonly string[] = ['reports.read'];");
      expect(content).toContain(
        'export const SUPPORTED_SCOPES: readonly string[] = [...STANDARD_SCOPES, ...CUSTOM_SCOPES];',
      );
      expect(content).toContain('export function findUnsupportedScopes(');
      expect(content).toContain(
        'export async function resolveGrantableScopes(\n  requested: readonly string[],\n  subject: string,\n): Promise<string[]> {',
      );
    });

    // scopes.ts tells the reader where the policy is called, so it must name the
    // App Router files, not the routes/ modules of the other targets.
    it('should point readers to the Next.js files that call the policy', () => {
      const content = nextJsFile('_oidc-provider/scopes.ts');

      expect(content).toContain(
        ' * - consent/page.tsx + consent/actions.ts — the consent screen (what is displayed) and the approval',
      );
      expect(content).toContain(' * - authorize/route.ts — the SSO fast path and prompt=none, which grant without');
      expect(content).toContain(
        ' * - device/approve/route.ts / ciba/approve/route.ts — the device and CIBA approval',
      );
      expect(content).toContain(' * ignores them. Return your own claims for a custom scope by editing\n * userinfo/route.ts.');
      expect(content).not.toContain('routes/');
    });
  });

  describe('Authorization endpoint (authorize/route.ts)', () => {
    it('should reject an undeclared scope with invalid_scope', () => {
      const content = nextJsFile('authorize/route.ts');

      expect(content).toContain(
        "import { findUnsupportedScopes, resolveGrantableScopes } from '../_oidc-provider/scopes';",
      );
      expect(content).toContain('    const unsupportedScopes = findUnsupportedScopes(scope);');
      expect(content).toContain(
        "        AuthorizationErrorCode.InvalidScope,\n        'Unsupported scope: ' + unsupportedScopes.join(' '),",
      );
    });

    // OIDC Core 1.0 §11 requires ignoring an offline_access that cannot be granted,
    // so the allow-list check must run after applyOfflineAccessPolicy dropped it.
    it('should check the allow list after the offline_access policy', () => {
      const content = nextJsFile('authorize/route.ts');
      const offlineAccessIndex = content.indexOf(
        'scope = await applyOfflineAccessPolicy(scope, effectiveParams, prompt, client);',
      );

      expect(offlineAccessIndex > 0).toBe(true);
      expect(offlineAccessIndex).toBeLessThan(content.indexOf('const unsupportedScopes = findUnsupportedScopes(scope);'));
    });

    // Both grant without showing consent, and both look consent up by scope, so
    // each has to apply the policy before that lookup or it could never match.
    it('should apply the policy before the consent lookup of prompt=none and SSO', () => {
      const content = nextJsFile('authorize/route.ts');
      const promptNonePolicy =
        "        transaction.scope = (await resolveGrantableScopes(\n          transaction.scope.split(' ').filter(Boolean),\n          session.subject,\n        )).join(' ');";
      const ssoPolicy =
        "        transaction.scope = (await resolveGrantableScopes(\n          transaction.scope.split(' ').filter(Boolean),\n          existingSession.subject,\n        )).join(' ');";
      const promptNoneIndex = content.indexOf(promptNonePolicy);
      const ssoBranchIndex = content.indexOf('if (existingSession && sessionIsFresh && hintMatchesSession) {');
      const ssoIndex = content.indexOf(ssoPolicy);

      expect(promptNoneIndex > 0).toBe(true);
      expect(promptNoneIndex).toBeLessThan(content.indexOf('await validatePromptNoneConsent('));
      expect(ssoBranchIndex > 0).toBe(true);
      expect(ssoBranchIndex).toBeLessThan(ssoIndex);
      expect(ssoIndex).toBeLessThan(content.indexOf('await consentResolver.hasConsent('));
    });
  });

  describe('Consent page and Server Action', () => {
    // The page shows the End-User only the scopes they can be granted.
    it('should display only the grantable scopes on the consent page', () => {
      const content = nextJsFile('consent/page.tsx');

      expect(content).toContain("import { resolveGrantableScopes } from '../_oidc-provider/scopes';");
      expect(content).toContain('  const consentSession = await stores.authSessionStore.get(transactionId);');
      expect(content).toContain(
        '  const scopes = consentSession\n    ? await resolveGrantableScopes(requestedScopes, consentSession.subject)\n    : requestedScopes;',
      );
    });

    // The Server Action mints the code, so the policy result is what is granted
    // and what is recorded as consent.
    it('should apply the policy to the scope the consent Server Action grants', () => {
      const content = nextJsFile('consent/actions.ts');

      expect(content).toContain("import { resolveGrantableScopes } from '../_oidc-provider/scopes';");
      expect(content).toContain(
        "  const grantedScope = await resolveGrantableScopes(\n    transaction.scope.split(' ').filter(Boolean),\n    session.subject,\n  );",
      );
      expect(content).toContain('    authorizationResponse: { ...responseParams, scope: grantedScope },');
      expect(content).toContain(
        'await resolvers.consentResolver.recordConsent?.(session.subject, transaction.clientId, grantedScope);',
      );
    });
  });

  describe('Device and CIBA Route Handlers', () => {
    it('should apply the allow list to the device and backchannel authentication requests', () => {
      const enable = ['device-authorization-grant', 'ciba'];

      expect(nextJsFile('device_authorization/route.ts', ['reports.read'], enable)).toContain(
        '    const unsupportedScopes = findUnsupportedScopes(scope);',
      );
      // CIBA §7.1 leaves offline_access to the pipeline's own policy, so the
      // pre-check must not turn an ignorable offline_access into invalid_scope.
      expect(nextJsFile('backchannel_authentication/route.ts', ['reports.read'], enable)).toContain(
        ".filter((scope) => scope.length > 0 && scope !== 'offline_access'),",
      );
    });

    it('should apply the policy to the device and CIBA approvals', () => {
      const enable = ['device-authorization-grant', 'ciba'];
      const approval =
        '      approved.approvedScope = await resolveGrantableScopes(\n        approved.approvedScope ?? approved.scope,\n        session.subject,\n      );';

      expect(nextJsFile('device/approve/route.ts', ['reports.read'], enable)).toContain(approval);
      expect(nextJsFile('ciba/approve/route.ts', ['reports.read'], enable)).toContain(approval);
    });
  });

  describe('Discovery and contract test', () => {
    it('should advertise the declared scopes in discovery', () => {
      const content = nextJsFile('.well-known/openid-configuration/route.ts');

      expect(content).toContain("import { SUPPORTED_SCOPES } from '../../_oidc-provider/scopes';");
      expect(content).toContain('    scopesSupported: [...SUPPORTED_SCOPES],');
    });

    it('should pin the declared scopes in scopes_supported in the contract test', () => {
      expect(nextJsFile('_oidc-provider/conformance.test.ts', ['reports.read', 'reports.write'])).toContain(
        "      scopes_supported: ['openid', 'profile', 'email', 'address', 'phone', 'offline_access', 'reports.read', 'reports.write'],",
      );
    });

    it('should pin the allow list and the filtering seam in the contract test', () => {
      const content = nextJsFile('_oidc-provider/conformance.test.ts');

      expect(content).toContain("import { RESTRICTED_SCOPE_SUBJECTS } from './scopes';");
      expect(content).toContain("describe('Custom scopes (scopes.ts)', () => {");
      expect(content).toContain("it('should reject a scope that was not declared (RFC 6749 §3.3)', async () => {");
      expect(content).toContain(
        "it('should drop a scope the End-User may not be granted (resolveGrantableScopes)', async () => {",
      );
      expect(content).toContain("RESTRICTED_SCOPE_SUBJECTS['reports.read'] = ['otheruser'];");
    });
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
