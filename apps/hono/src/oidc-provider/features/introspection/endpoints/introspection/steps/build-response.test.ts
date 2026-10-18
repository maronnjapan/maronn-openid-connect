import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessTokenInfo, refreshTokenInfo } from '../../../../../../test-support/feature-endpoints.js';
import { describeIntrospectedToken } from './build-response.js';

/** 2026-01-01T00:00:00Z in Unix seconds. */
const NOW = 1767225600;

describe('describeIntrospectedToken', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Active Tokens', () => {
    // RFC 7662 §2.2: the members of an active access token.
    it('should describe an active access token with its stored members', () => {
      const accessToken = accessTokenInfo({
        sub: 'user-1',
        scope: ['openid', 'profile'],
        clientId: 'client-1',
        expiresAt: NOW + 600,
        iat: NOW - 60,
        audience: ['https://api.example.com'],
        issuer: 'https://op.example.com',
        jti: 'jti-1',
      });

      expect(describeIntrospectedToken({ tokenType: 'access_token', accessToken })).toEqual({
        active: true,
        scope: 'openid profile',
        client_id: 'client-1',
        token_type: 'Bearer',
        sub: 'user-1',
        exp: NOW + 600,
        iat: NOW - 60,
        aud: ['https://api.example.com'],
        iss: 'https://op.example.com',
        jti: 'jti-1',
      });
    });

    it('should describe an unused refresh token within its lifetime', () => {
      const refreshToken = refreshTokenInfo({ subject: 'user-1', clientId: 'client-1', expiresAt: NOW + 600 });

      expect(describeIntrospectedToken({ tokenType: 'refresh_token', refreshToken })).toEqual({
        active: true,
        scope: 'openid',
        client_id: 'client-1',
        token_type: 'refresh_token',
        sub: 'user-1',
        exp: NOW + 600,
      });
    });
  });

  // RFC 7662 §2.2: anything not active is { active: false } with no other member.
  describe('Inactive Tokens', () => {
    it('should answer { active: false } for an unknown token', () => {
      expect(describeIntrospectedToken(null)).toEqual({ active: false });
    });

    it('should answer { active: false } for an expired access token', () => {
      const accessToken = accessTokenInfo({ expiresAt: NOW });

      expect(describeIntrospectedToken({ tokenType: 'access_token', accessToken })).toEqual({ active: false });
    });

    // RFC 7519 §4.1.5: not valid before nbf.
    it('should answer { active: false } for an access token whose nbf is in the future', () => {
      const accessToken = accessTokenInfo({ expiresAt: NOW + 600, nbf: NOW + 60 });

      expect(describeIntrospectedToken({ tokenType: 'access_token', accessToken })).toEqual({ active: false });
    });

    // OAuth 2.1 §4.3.1: a rotated refresh token is no longer valid.
    it('should answer { active: false } for a rotated refresh token', () => {
      const refreshToken = refreshTokenInfo({ expiresAt: NOW + 600, used: true });

      expect(describeIntrospectedToken({ tokenType: 'refresh_token', refreshToken })).toEqual({ active: false });
    });
  });
});
