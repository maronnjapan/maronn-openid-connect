import { describe, expect, it } from 'vitest';
import { formatCode, formatHash, panelOf, parseCode, parseHash, samePage, withoutPanel, type CodeTarget, type View } from './route';

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

  it('should read a kind page with its package and the code in its panel', () => {
    expect(parseHash('#/kind/e2e')).toEqual({ page: 'kind', testKind: 'e2e' });
    expect(parseHash('#/kind/unit?pkg=hono&outcome=failure')).toEqual({ page: 'kind', testKind: 'unit', pkg: 'hono', outcome: 'failure' });
    expect(parseHash('#/kind/unit?code=fn%3Acore%3Ajwt.ts%23sign')).toEqual({ page: 'kind', testKind: 'unit', code: 'fn:core:jwt.ts#sign' });
    // Only the unit tests have packages, and a kind page has no filter by kind.
    expect(parseHash('#/kind/api?pkg=core&kind=unit')).toEqual({ page: 'kind', testKind: 'api' });
    expect(parseHash('#/kind/tool')).toEqual({ page: 'home' });
    expect(parseHash('#/kind')).toEqual({ page: 'home' });
  });

  it('should keep a test before some code, and leave out code it cannot read', () => {
    expect(parseHash('#/endpoint/hono/token?test=a&code=endpoint%3Ahono%3Atoken')).toMatchObject({ test: 'a' });
    expect(parseHash('#/endpoint/hono/token?test=a&code=endpoint%3Ahono%3Atoken')).not.toHaveProperty('code');
    expect(parseHash('#/endpoint/hono/token?code=nothing')).toEqual({ page: 'endpoint', source: 'hono', endpoint: 'token' });
    expect(parseHash('#/test/x?code=fn%3Aa')).toEqual({ page: 'test', test: 'x' });
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
    { page: 'kind', testKind: 'api' },
    { page: 'kind', testKind: 'unit', pkg: 'core', outcome: 'success', test: 't' },
    { page: 'kind', testKind: 'e2e', code: 'endpoint:nextjs:token' },
    { page: 'endpoint', source: 'hono', endpoint: 'token', step: 'parse-request', code: 'step:hono:token:parse-request' },
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

describe('samePage, panelOf and withoutPanel', () => {
  it('should tell a change of filter or panel from a change of page', () => {
    const base: View = { page: 'endpoint', source: 'hono', endpoint: 'token' };
    expect(samePage(base, { ...base, kind: 'unit', test: 'x' })).toBe(true);
    expect(samePage(base, { ...base, code: 'endpoint:hono:token' })).toBe(true);
    expect(samePage(base, { ...base, endpoint: 'par' })).toBe(false);
    expect(samePage({ page: 'test', test: 'a' }, { page: 'test', test: 'b' })).toBe(false);
    expect(samePage({ page: 'kind', testKind: 'unit' }, { page: 'kind', testKind: 'unit', pkg: 'hono' })).toBe(true);
    expect(samePage({ page: 'kind', testKind: 'unit' }, { page: 'kind', testKind: 'api' })).toBe(false);
  });

  it('should tell what the panel shows: a test, or some code, never on the page of a test', () => {
    expect(panelOf({ page: 'endpoint', test: 'x' })).toBe('x');
    expect(panelOf({ page: 'kind', testKind: 'unit', code: 'fn:a' })).toBe('fn:a');
    expect(panelOf({ page: 'test', test: 'x' })).toBeUndefined();
    expect(panelOf({ page: 'home' })).toBeUndefined();
  });

  it('should close the panel and keep the filters', () => {
    expect(withoutPanel({ page: 'endpoint', source: 'hono', endpoint: 'token', kind: 'unit', test: 'x' })).toEqual({ page: 'endpoint', source: 'hono', endpoint: 'token', kind: 'unit' });
    expect(withoutPanel({ page: 'kind', testKind: 'unit', pkg: 'hono', code: 'fn:a' })).toEqual({ page: 'kind', testKind: 'unit', pkg: 'hono' });
    expect(withoutPanel({ page: 'test', test: 'x' })).toEqual({ page: 'home' });
  });
});

describe('formatCode and parseCode', () => {
  const targets: CodeTarget[] = [
    { kind: 'fn', id: 'hono:oidc-provider/endpoints/token/steps/parse-request.ts#parseTokenRequest' },
    { kind: 'fn', id: 'nextjs:app/(ciba)/ciba/route.ts#GET' },
    { kind: 'endpoint', key: 'nextjs:token' },
    { kind: 'step', key: 'hono:token', step: 'authenticate-client' },
  ];

  it('should write the code of the panel so that it reads back the same', () => {
    for (const target of targets) expect(parseCode(formatCode(target))).toEqual(target);
    expect(formatCode({ kind: 'step', key: 'hono:token', step: 'respond' })).toBe('step:hono:token:respond');
  });

  it('should read nothing it does not know', () => {
    for (const value of [undefined, '', 'fn:', 'fn', 'endpoint:express:token', 'endpoint:hono', 'endpoint:hono:token:x', 'step:hono:token', 'step:hono:token:', 'class:x']) {
      expect(parseCode(value)).toBeUndefined();
    }
  });
});
