import type {
  PushedAuthorizationRecord,
  PushedAuthorizationRequestStore,
} from '@maronn-openid-connect/experimental/par';

/**
 * EXPERIMENTAL — in-memory Pushed Authorization Request store (RFC 9126).
 *
 * Replace with a persistent store (Redis, KV, database) in production. The
 * contract is only two methods:
 *
 * - save(record): persist the pushed request, ideally with a TTL matching
 *   record.expiresAt so entries cannot pile up (RFC 9126 §7.3).
 * - consume(requestUri): fetch AND delete in one atomic operation. A
 *   non-atomic implementation lets the same request_uri be replayed
 *   concurrently. Treat requestUri as an opaque external value: never
 *   interpolate it into a query, always bind it as a parameter.
 */
export class InMemoryPushedAuthorizationRequestStore
  implements PushedAuthorizationRequestStore
{
  private records = new Map<string, PushedAuthorizationRecord>();

  async save(record: PushedAuthorizationRecord): Promise<void> {
    this.records.set(record.requestUri, record);
  }

  async consume(requestUri: string): Promise<PushedAuthorizationRecord | null> {
    const record = this.records.get(requestUri);
    // Single use (RFC 9126 §7.3): delete on read, expired or not, so a replay of
    // the same reference can never succeed.
    this.records.delete(requestUri);
    if (!record) {
      this.evictExpired();
      return null;
    }
    return record;
  }

  /** Drop entries whose lifetime has passed so an idle store cannot grow unbounded. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [requestUri, record] of this.records) {
      if (record.expiresAt.getTime() < now) {
        this.records.delete(requestUri);
      }
    }
  }
}

// Kept on globalThis so every module that asks for the store gets the same one,
// also where a framework loads a module more than once (dev-mode hot reloads,
// separate module layers).
const parStoreRegistry = globalThis as typeof globalThis & {
  __oidcPushedAuthorizationRequestStore?: PushedAuthorizationRequestStore;
};

export const parStore: PushedAuthorizationRequestStore =
  (parStoreRegistry.__oidcPushedAuthorizationRequestStore ??=
    new InMemoryPushedAuthorizationRequestStore());
