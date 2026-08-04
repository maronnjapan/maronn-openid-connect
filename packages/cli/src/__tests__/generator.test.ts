import { describe, it, expect } from 'vitest';
import { generate, getAvailableFrameworks } from '../generator.js';

describe('generate', () => {
  describe('framework selection', () => {
    it('should throw error for unknown framework', () => {
      expect(() =>
        generate({ framework: 'unknown', outputDir: './out' }),
      ).toThrow('Unknown framework: "unknown"');
    });

    it('should include available frameworks in error message', () => {
      expect(() =>
        generate({ framework: 'unknown', outputDir: './out' }),
      ).toThrow('Available frameworks: hono, express, fastify, nextjs');
    });

    it('should generate files for hono framework', () => {
      const result = generate({ framework: 'hono', outputDir: './out' });
      expect(result.framework).toBe('hono');
      expect(result.files.length).toBeGreaterThan(0);
    });

    it('should generate files for express framework', () => {
      const result = generate({ framework: 'express', outputDir: './out' });
      expect(result.framework).toBe('express');
      expect(result.files.map((f) => f.path).sort()).toEqual([
        'app.ts',
        'apply.ts',
        'config.ts',
        'conformance.test.ts',
        'node-adapter.ts',
        'resolvers.ts',
        'routes/authorize.ts',
        'routes/consent.ts',
        'routes/discovery.ts',
        'routes/introspection.ts',
        'routes/jwks.ts',
        'routes/login.ts',
        'routes/revocation.ts',
        'routes/token.ts',
        'routes/userinfo.ts',
        'store.ts',
        'views.ts',
        'web-router.ts',
      ]);
    });

    it('should generate files for fastify framework', () => {
      const result = generate({ framework: 'fastify', outputDir: './out' });
      expect(result.framework).toBe('fastify');
      expect(result.files.map((f) => f.path).sort()).toEqual([
        'app.ts',
        'apply.ts',
        'config.ts',
        'conformance.test.ts',
        'node-adapter.ts',
        'resolvers.ts',
        'routes/authorize.ts',
        'routes/consent.ts',
        'routes/discovery.ts',
        'routes/introspection.ts',
        'routes/jwks.ts',
        'routes/login.ts',
        'routes/revocation.ts',
        'routes/token.ts',
        'routes/userinfo.ts',
        'store.ts',
        'views.ts',
        'web-router.ts',
      ]);
    });

    it('should generate files for nextjs framework', () => {
      const result = generate({ framework: 'nextjs', outputDir: './out' });
      expect(result.framework).toBe('nextjs');
      expect(result.files.map((f) => f.path).sort()).toEqual([
        '.well-known/jwks.json/route.ts',
        '.well-known/openid-configuration/route.ts',
        '_oidc-provider/app.ts',
        '_oidc-provider/config.ts',
        '_oidc-provider/conformance.test.ts',
        '_oidc-provider/next.ts',
        '_oidc-provider/resolvers.ts',
        '_oidc-provider/routes/authorize.ts',
        '_oidc-provider/routes/consent.ts',
        '_oidc-provider/routes/discovery.ts',
        '_oidc-provider/routes/introspection.ts',
        '_oidc-provider/routes/jwks.ts',
        '_oidc-provider/routes/login.ts',
        '_oidc-provider/routes/revocation.ts',
        '_oidc-provider/routes/token.ts',
        '_oidc-provider/routes/userinfo.ts',
        '_oidc-provider/runtime.ts',
        '_oidc-provider/storage-backend.ts',
        '_oidc-provider/store.ts',
        '_oidc-provider/views.ts',
        '_oidc-provider/web-router.ts',
        'authorize/route.ts',
        'consent/actions.ts',
        'consent/page.tsx',
        'introspect/route.ts',
        'login/actions.ts',
        'login/page.tsx',
        'oidc-error/error.tsx',
        'oidc-error/page.tsx',
        'revoke/route.ts',
        'token/route.ts',
        'userinfo/route.ts',
      ]);
    });
  });

  describe('core package name', () => {
    it('should use default core package name', () => {
      const result = generate({ framework: 'hono', outputDir: './out' });
      const resolversFile = result.files.find((f) => f.path === 'resolvers.ts');
      expect(resolversFile?.content).toContain('@maronn-openid-connect/core');
    });

    it('should use custom core package name when provided', () => {
      const result = generate({
        framework: 'hono',
        outputDir: './out',
        corePackageName: 'my-custom-core',
      });
      const resolversFile = result.files.find((f) => f.path === 'resolvers.ts');
      expect(resolversFile?.content).toContain('my-custom-core');
      expect(resolversFile?.content).not.toContain('@maronn-openid-connect/core');
    });
  });
});

describe('getAvailableFrameworks', () => {
  it('should list supported frameworks in registration order', () => {
    expect(getAvailableFrameworks()).toEqual(['hono', 'express', 'fastify', 'nextjs']);
  });
});
