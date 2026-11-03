import { describe, expect, it } from 'vitest';
import { evaluateLiteral, jsDocSummaryAbove, literalArgumentOf, readEndpointMeta } from '../extract/meta.js';

const ENDPOINT = [
  "import { defineEndpoint } from '../step.js';",
  '',
  'export const endpoint = defineEndpoint({',
  "  id: 'authorize',",
  "  // The response mode (undefined unless a feature's step sets it) is read by the error step.",
  "  initial: ['issuer'],",
  "  /* A block comment's quote and its brace } do not end the literal. */",
  "  steps: ['parse-request', 'respond-error'],",
  '});',
  '',
].join('\n');

describe('literalArgumentOf', () => {
  it('should skip the comments inside the literal, whatever quotes and braces they hold', () => {
    expect(literalArgumentOf(ENDPOINT, 'defineEndpoint')).toBe(
      [
        '{',
        "  id: 'authorize',",
        "  // The response mode (undefined unless a feature's step sets it) is read by the error step.",
        "  initial: ['issuer'],",
        "  /* A block comment's quote and its brace } do not end the literal. */",
        "  steps: ['parse-request', 'respond-error'],",
        '}',
      ].join('\n'),
    );
  });

  it('should keep a slash inside a string', () => {
    expect(literalArgumentOf("defineEndpoint({ path: '/.well-known/jwks.json' });", 'defineEndpoint')).toBe(
      "{ path: '/.well-known/jwks.json' }",
    );
  });

  it('should return undefined when the source has no such call', () => {
    expect(literalArgumentOf('export const value = 1;\n', 'defineEndpoint')).toBeUndefined();
  });
});

describe('evaluateLiteral', () => {
  it('should read a literal whose comments hold an apostrophe and parentheses', () => {
    expect(evaluateLiteral(literalArgumentOf(ENDPOINT, 'defineEndpoint') ?? '')).toEqual({
      id: 'authorize',
      initial: ['issuer'],
      steps: ['parse-request', 'respond-error'],
    });
  });

  // Reading a description must never run code of the source.
  it('should refuse a call outside the comments and strings', () => {
    expect(() => evaluateLiteral("{ id: 'x', steps: list() }")).toThrow("Not a plain literal: { id: 'x', steps: list() }");
  });

  it('should read parentheses inside a string', () => {
    expect(evaluateLiteral("{ label: 'Token (refresh)' }")).toEqual({ label: 'Token (refresh)' });
  });
});

describe('readEndpointMeta', () => {
  const literal = "{\n  id: 'token',\n  order: 70,\n  label: 'Token endpoint',\n  path: '/token',\n  methods: ['POST'],\n  layer: 'api',\n  group: { id: 'code', label: 'Code' },\n  rearrangeable: true,\n  steps: [],\n  edges: { chain: true },\n}";

  it('should take the summary of the endpoint from the first paragraph of the JSDoc above it', () => {
    const source = `import { defineEndpoint } from '../step.js';\n\n/**\n * Authenticate the client and answer\n * with the tokens.\n *\n * More detail.\n *\n * @spec OIDC Core 1.0 §3.1.3\n */\nexport const endpoint = defineEndpoint(${literal});\n`;
    expect(readEndpointMeta(source)).toMatchObject({ id: 'token', summary: 'Authenticate the client and answer with the tokens.' });
  });

  it('should leave the summary out for an endpoint without a JSDoc', () => {
    const meta = readEndpointMeta(`export const endpoint = defineEndpoint(${literal});\n`);
    expect(meta?.id).toBe('token');
    expect(meta && 'summary' in meta).toBe(false);
  });
});

describe('jsDocSummaryAbove', () => {
  it('should give no summary for a JSDoc that starts with a tag, nor for a comment that is not right above', () => {
    expect(jsDocSummaryAbove('/** @spec RFC 1 */\nx', 19)).toBe(undefined);
    expect(jsDocSummaryAbove('/** Text. */\nconst a = 1;\nx', 26)).toBe(undefined);
  });
});
