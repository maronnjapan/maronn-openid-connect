import { describe, expect, it } from 'vitest';
import { formatHash, parseHash, samePage, withoutTest, type View } from './route';

describe('parseHash', () => {
  it('should read an empty or unknown hash as the home page', () => {
    expect(parseHash('')).toEqual({ page: 'home' });
    expect(parseHash('#/')).toEqual({ page: 'home' });
    expect(parseHash('#/nowhere/at/all')).toEqual({ page: 'home' });
    expect(parseHash('#/endpoint/express/token')).toEqual({ page: 'home' });
  });

  it('should read an endpoint with its step, filters and the open test', () => {
    expect(parseHash('#/endpoint/hono/token?step=parse-request&kind=unit&outcome=failure&test=abc')).toEqual({
      page: 'endpoint',
      source: 'hono',
      endpoint: 'token',
      step: 'parse-request',
      kind: 'unit',
      outcome: 'failure',
      test: 'abc',
    });
  });

  it('should keep a function filter only when no step is named', () => {
    expect(parseHash('#/endpoint/nextjs/token?fn=core%3Ajwt.ts%23sign')).toMatchObject({ fn: 'core:jwt.ts#sign' });
    expect(parseHash('#/endpoint/nextjs/token?step=a&fn=b')).not.toHaveProperty('fn');
  });

  it('should drop filter values it does not know and the defaults', () => {
    expect(parseHash('#/endpoint/hono/token?kind=everything&outcome=both')).toEqual({ page: 'endpoint', source: 'hono', endpoint: 'token' });
  });

  it('should read a file path with its slashes and encoded parts', () => {
    expect(parseHash('#/file/apps/nextjs/app/(ciba)/route.test.ts')).toEqual({ page: 'file', file: 'apps/nextjs/app/(ciba)/route.test.ts' });
    expect(parseHash('#/file/a%20b/c.test.ts?test=x')).toEqual({ page: 'file', file: 'a b/c.test.ts', test: 'x' });
  });

  it('should read the search, the files, the pull request and a test page', () => {
    expect(parseHash('#/search?q=token%20client')).toEqual({ page: 'search', q: 'token client' });
    expect(parseHash('#/files')).toEqual({ page: 'files' });
    expect(parseHash('#/pr?kind=api')).toEqual({ page: 'pr', kind: 'api' });
    expect(parseHash('#/test/auth-code-flow-online-refresh')).toEqual({ page: 'test', test: 'auth-code-flow-online-refresh' });
  });
});

describe('formatHash', () => {
  const views: View[] = [
    { page: 'home' },
    { page: 'endpoint', source: 'hono', endpoint: 'token' },
    { page: 'endpoint', source: 'nextjs', endpoint: 'token', step: 'parse-request', kind: 'unit', outcome: 'success', test: 'abc' },
    { page: 'endpoint', source: 'hono', endpoint: 'token', fn: 'core:jwt.ts#sign' },
    { page: 'files' },
    { page: 'file', file: 'apps/nextjs/app/(ciba)/a b.test.ts', test: 'x' },
    { page: 'pr', outcome: 'failure' },
    { page: 'search', q: 'トークン client' },
    { page: 'test', test: 'id-1' },
  ];

  it('should write a hash that reads back as the same view', () => {
    for (const view of views) expect(parseHash(formatHash(view))).toEqual(view);
  });

  it('should leave the defaults out', () => {
    expect(formatHash({ page: 'endpoint', source: 'hono', endpoint: 'token', kind: 'all', outcome: 'both' })).toBe('#/endpoint/hono/token');
    expect(formatHash({ page: 'home' })).toBe('#/');
  });

  it('should keep the slashes of a file path', () => {
    expect(formatHash({ page: 'file', file: 'packages/core/src/jwt.test.ts' })).toBe('#/file/packages/core/src/jwt.test.ts');
  });
});

describe('samePage and withoutTest', () => {
  it('should tell a change of filter or panel from a change of page', () => {
    const base: View = { page: 'endpoint', source: 'hono', endpoint: 'token' };
    expect(samePage(base, { ...base, kind: 'unit', test: 'x' })).toBe(true);
    expect(samePage(base, { ...base, endpoint: 'par' })).toBe(false);
    expect(samePage({ page: 'test', test: 'a' }, { page: 'test', test: 'b' })).toBe(false);
  });

  it('should close the panel and keep the filters', () => {
    expect(withoutTest({ page: 'endpoint', source: 'hono', endpoint: 'token', kind: 'unit', test: 'x' })).toEqual({ page: 'endpoint', source: 'hono', endpoint: 'token', kind: 'unit' });
    expect(withoutTest({ page: 'test', test: 'x' })).toEqual({ page: 'home' });
  });
});
