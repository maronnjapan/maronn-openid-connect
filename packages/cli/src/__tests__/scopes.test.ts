import { describe, it, expect } from 'vitest';
import { RESERVED_SCOPES, resolveCustomScopes } from '../scopes.js';

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
