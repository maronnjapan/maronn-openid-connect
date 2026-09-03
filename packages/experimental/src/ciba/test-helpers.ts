/**
 * テスト専用のフィクスチャ。tsconfig の exclude で dist から除外している。
 *
 * 複数のテストファイルが同じレコード工場とクライアント工場を必要とするため、
 * 機能内で共有する（experimental 機能を跨いだ共通化はしない）。
 */
import type { CibaClientInfo } from './backchannel-authentication-request.js';
import type { CibaAuthenticationRequestRecord } from './store.js';

/** テスト内で時刻を固定するための基準時刻。 */
export const NOW = new Date('2026-09-02T00:00:00.000Z');

/** 既定値つきのレコード工場。上書きしたいフィールドだけ渡す。 */
export function makeRecord(
  overrides: Partial<CibaAuthenticationRequestRecord> = {},
): CibaAuthenticationRequestRecord {
  return {
    authReqId: 'auth-req-id-value',
    clientId: 'ciba-client',
    subject: 'testuser',
    scope: ['openid'],
    status: 'pending',
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 120_000),
    interval: 5,
    lastPolledAt: null,
    csrfToken: null,
    ...overrides,
  };
}

/** 既定値つきのクライアント工場。CIBA grant 登録済みの confidential client。 */
export function makeClient(overrides: Partial<CibaClientInfo> = {}): CibaClientInfo {
  return {
    clientId: 'ciba-client',
    clientSecret: 'secret',
    grantTypes: ['urn:openid:params:grant-type:ciba'],
    tokenEndpointAuthMethod: 'client_secret_post',
    ...overrides,
  };
}
