import { describe, expect, it } from 'vitest';
import { exampleTestId, fileTestId, hashedTestId } from '../id.js';

describe('hashedTestId', () => {
  it('should give the same id to the same root, describe path and title, and another to another title', () => {
    const id = hashedTestId('hono', ['authenticateTokenClient'], 'should reject invalid client credentials');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(hashedTestId('hono', ['authenticateTokenClient'], 'should reject invalid client credentials')).toBe(id);
    expect(hashedTestId('hono', ['authenticateTokenClient'], 'should accept valid client credentials')).not.toBe(id);
  });

  it('should keep the parts apart, so a describe and a title do not run into one another', () => {
    expect(hashedTestId('core', ['a b'], 'c')).not.toBe(hashedTestId('core', ['a'], 'b c'));
  });
});

describe('fileTestId', () => {
  it('should tell apart two tests with the same path and title in two files of a root', () => {
    expect(fileTestId('e2e', 'tests/e2e/specs/a.spec.ts', [], 't')).not.toBe(fileTestId('e2e', 'tests/e2e/specs/b.spec.ts', [], 't'));
  });
});

describe('exampleTestId', () => {
  it('should number the rows of the examples of an outline from 1', () => {
    expect(exampleTestId('token-missing-required-parameter', 2)).toBe('token-missing-required-parameter-2');
  });
});
