import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADVERTISED_SCOPES,
  CUSTOM_SCOPES,
  RESTRICTED_SCOPE_SUBJECTS,
  findUnsupportedScopes,
  resolveGrantableScopes,
} from './scopes.js';

describe('resolveGrantableScopes', () => {
  it('should grant every requested scope when no scope is restricted', async () => {
    expect(await resolveGrantableScopes(['openid', 'profile', 'offline_access'], 'alice')).toEqual([
      'openid',
      'profile',
      'offline_access',
    ]);
  });

  describe('RESTRICTED_SCOPE_SUBJECTS', () => {
    beforeEach(() => {
      RESTRICTED_SCOPE_SUBJECTS['reports.read'] = ['alice'];
    });
    afterEach(() => {
      delete RESTRICTED_SCOPE_SUBJECTS['reports.read'];
    });

    // RFC 6749 §3.3: the AS may issue a narrower scope than requested.
    it('should drop a restricted scope for a subject that is not listed', async () => {
      expect(await resolveGrantableScopes(['openid', 'reports.read'], 'bob')).toEqual(['openid']);
    });

    it('should keep a restricted scope for a listed subject', async () => {
      expect(await resolveGrantableScopes(['openid', 'reports.read'], 'alice')).toEqual(['openid', 'reports.read']);
    });
  });
});

describe('findUnsupportedScopes', () => {
  it('should accept every value while no custom scope is declared', () => {
    expect(findUnsupportedScopes(['openid', 'anything'])).toEqual([]);
  });

  describe('with a declared custom scope', () => {
    beforeEach(() => {
      (CUSTOM_SCOPES as string[]).push('reports.read');
    });
    afterEach(() => {
      (CUSTOM_SCOPES as string[]).length = 0;
    });

    // RFC 6749 §3.3 / §4.1.2.1: a value neither standard nor declared is invalid_scope.
    it('should report the values that are neither standard nor declared', () => {
      expect(findUnsupportedScopes(['openid', 'offline_access', 'reports.read', 'admin', 'debug'])).toEqual([
        'admin',
        'debug',
      ]);
    });
  });
});

describe('ADVERTISED_SCOPES', () => {
  // OIDC Discovery 1.0 §3: offline_access is advertised by the refresh-token feature instead.
  it('should list the scopes of OIDC Core without offline_access', () => {
    expect(ADVERTISED_SCOPES).toEqual(['openid', 'profile', 'email', 'address', 'phone']);
  });
});
