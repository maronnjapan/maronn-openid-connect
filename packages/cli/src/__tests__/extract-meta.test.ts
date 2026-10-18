import { describe, expect, it } from 'vitest';
import { evaluateLiteral, literalArgumentOf } from '../extract/meta.js';

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
