/**
 * テスト専用のフィクスチャ。tsconfig の exclude で dist から除外している。
 *
 * 4 つのテストファイルが同じストア実装とレコード工場を必要とするため、機能内で
 * 共有する（experimental 機能を跨いだ共通化はしない）。
 */
import type {
  DeviceAuthorizationRecord,
  DeviceAuthorizationStore,
} from './store.js';

/** テスト内で時刻を固定するための基準時刻。 */
export const NOW = new Date('2026-08-07T00:00:00.000Z');

/** 既定値つきのレコード工場。上書きしたいフィールドだけ渡す。 */
export function makeRecord(
  overrides: Partial<DeviceAuthorizationRecord> = {},
): DeviceAuthorizationRecord {
  return {
    deviceCode: 'device-code-value',
    userCode: 'WDJBMJHT',
    userCodeDisplay: 'WDJB-MJHT',
    clientId: 'device-client',
    scope: ['openid'],
    status: 'pending',
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 600_000),
    interval: 5,
    lastPolledAt: null,
    csrfToken: null,
    bindingHash: null,
    loginAttempts: 0,
    ...overrides,
  };
}

/** テスト用のインメモリ実装。契約どおり consume は取得と削除を同時に行う。 */
export function createInMemoryDeviceAuthorizationStore(): DeviceAuthorizationStore & {
  records: Map<string, DeviceAuthorizationRecord>;
} {
  const records = new Map<string, DeviceAuthorizationRecord>();
  return {
    records,
    async save(record) {
      records.set(record.deviceCode, record);
    },
    async findByDeviceCode(deviceCode) {
      return records.get(deviceCode) ?? null;
    },
    async findByUserCode(userCode) {
      for (const record of records.values()) {
        if (record.userCode === userCode) return record;
      }
      return null;
    },
    async update(record) {
      records.set(record.deviceCode, record);
    },
    async delete(deviceCode) {
      records.delete(deviceCode);
    },
    async consume(deviceCode) {
      const record = records.get(deviceCode) ?? null;
      records.delete(deviceCode);
      return record;
    },
  };
}
