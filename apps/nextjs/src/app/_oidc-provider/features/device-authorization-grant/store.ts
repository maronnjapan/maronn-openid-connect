import type {
  DeviceAuthorizationRecord,
  DeviceAuthorizationStore,
} from '@maronn-openid-connect/experimental/device-authorization-grant';

/**
 * EXPERIMENTAL — in-memory device authorization store (RFC 8628).
 *
 * Replace with a persistent store (Redis, KV, database) in production. Treat
 * deviceCode and userCode as opaque external values: never interpolate them into
 * a query, always bind them as parameters.
 *
 * - save / update: persist the record, ideally with a TTL derived from
 *   record.expiresAt so entries cannot pile up.
 * - consume(deviceCode): fetch AND delete in one atomic operation. A non-atomic
 *   implementation lets the same device_code be redeemed concurrently.
 * - Expired records whose device stopped polling are never reclaimed by the
 *   token endpoint. A persistent implementation MAY drop them on its own after a
 *   grace period (roughly one TTL); polling after that answers invalid_grant
 *   instead of expired_token, which ends the client's flow just the same.
 */
export class InMemoryDeviceAuthorizationStore implements DeviceAuthorizationStore {
  private records = new Map<string, DeviceAuthorizationRecord>();

  async save(record: DeviceAuthorizationRecord): Promise<void> {
    this.evictExpired();
    this.records.set(record.deviceCode, record);
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    return this.records.get(deviceCode) ?? null;
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null> {
    for (const record of this.records.values()) {
      if (record.userCode === userCode) return record;
    }
    return null;
  }

  async update(record: DeviceAuthorizationRecord): Promise<void> {
    this.records.set(record.deviceCode, record);
  }

  async delete(deviceCode: string): Promise<void> {
    this.records.delete(deviceCode);
  }

  async consume(deviceCode: string): Promise<DeviceAuthorizationRecord | null> {
    const record = this.records.get(deviceCode) ?? null;
    // Single use (RFC 8628 §3.5): delete on read so a replay of the same
    // device_code can never mint a second token.
    this.records.delete(deviceCode);
    return record;
  }

  /**
   * Drop records whose lifetime passed long enough ago that no device is still
   * polling them, so an idle store cannot grow unbounded. The grace period keeps
   * expired_token answerable for one more TTL after expiry.
   */
  private evictExpired(): void {
    const cutoff = Date.now() - DEVICE_RECORD_EVICTION_GRACE_MS;
    for (const [deviceCode, record] of this.records) {
      if (record.expiresAt.getTime() < cutoff) {
        this.records.delete(deviceCode);
      }
    }
  }
}

/** Grace period before an expired record is reclaimed (one default TTL). */
const DEVICE_RECORD_EVICTION_GRACE_MS = 600 * 1000;

// Kept on globalThis so every module that asks for the store gets the same one,
// also where a framework loads a module more than once (dev-mode hot reloads,
// separate module layers).
const deviceStoreRegistry = globalThis as typeof globalThis & {
  __oidcDeviceAuthorizationStore?: DeviceAuthorizationStore;
};

export const deviceAuthorizationStore: DeviceAuthorizationStore =
  (deviceStoreRegistry.__oidcDeviceAuthorizationStore ??=
    new InMemoryDeviceAuthorizationStore());
