import type { PushedAuthorizationRecord } from '@maronn-openid-connect/experimental/par';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryPushedAuthorizationRequestStore, parStore } from './store';

function record(requestUri: string, expiresInMs: number): PushedAuthorizationRecord {
  const createdAt = new Date();
  return {
    requestUri,
    clientId: 'client-1',
    params: { client_id: 'client-1', scope: 'openid' },
    createdAt,
    expiresAt: new Date(createdAt.getTime() + expiresInMs),
  };
}

describe('InMemoryPushedAuthorizationRequestStore', () => {
  describe('consume', () => {
    it('should return the saved record on the first consume', async () => {
      const store = new InMemoryPushedAuthorizationRequestStore();
      const saved = record('urn:ietf:params:oauth:request_uri:first', 60_000);
      await store.save(saved);

      expect(await store.consume('urn:ietf:params:oauth:request_uri:first')).toEqual(saved);
    });

    // RFC 9126 §7.3: a request_uri is single use.
    it('should return null when the same request_uri is consumed again', async () => {
      const store = new InMemoryPushedAuthorizationRequestStore();
      await store.save(record('urn:ietf:params:oauth:request_uri:once', 60_000));
      await store.consume('urn:ietf:params:oauth:request_uri:once');

      expect(await store.consume('urn:ietf:params:oauth:request_uri:once')).toBeNull();
    });

    it('should return null for a request_uri that was never saved', async () => {
      const store = new InMemoryPushedAuthorizationRequestStore();

      expect(await store.consume('urn:ietf:params:oauth:request_uri:unknown')).toBeNull();
    });
  });

  // RFC 9126 §7.3: expired entries must not pile up.
  describe('Eviction', () => {
    it('should drop expired records when a lookup misses', async () => {
      const store = new InMemoryPushedAuthorizationRequestStore();
      await store.save(record('urn:ietf:params:oauth:request_uri:expired', -1000));

      await store.consume('urn:ietf:params:oauth:request_uri:unknown');

      expect(await store.consume('urn:ietf:params:oauth:request_uri:expired')).toBeNull();
    });

    it('should keep unexpired records when a lookup misses', async () => {
      const store = new InMemoryPushedAuthorizationRequestStore();
      const live = record('urn:ietf:params:oauth:request_uri:live', 60_000);
      await store.save(live);

      await store.consume('urn:ietf:params:oauth:request_uri:unknown');

      expect(await store.consume('urn:ietf:params:oauth:request_uri:live')).toEqual(live);
    });
  });
});

describe('parStore', () => {
  it('should be the same store when the module is loaded again', async () => {
    vi.resetModules();

    const reloaded = await import('./store');

    expect(reloaded.parStore).toBe(parStore);
  });
});
