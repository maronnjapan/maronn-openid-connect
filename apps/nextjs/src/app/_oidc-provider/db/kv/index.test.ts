import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMapKvDatabase } from '../../../../test-support/databases';
import { createDatabase as createInstanceDatabase } from './instance';
import { createDatabase } from './index';

vi.mock('./instance', () => ({ createDatabase: vi.fn() }));

const openStore = vi.mocked(createInstanceDatabase);

beforeEach(() => {
  openStore.mockReset();
});

describe('createDatabase', () => {
  // `next build` imports the Route Handlers, and provider.ts creates its database at import.
  it('should not open the store of instance.ts before the first call to a method', () => {
    createDatabase();

    expect(openStore).not.toHaveBeenCalled();
  });

  it('should open the store of instance.ts once and pass every method to it', async () => {
    const store = createMapKvDatabase();
    openStore.mockReturnValue(store);
    const db = createDatabase();

    await db.set('oidc:user:alice', '{"email":"alice@example.com"}', 60);
    const inserted = await db.setIfAbsent('oidc:user:bob', '{"email":"bob@example.com"}');
    const alice = await db.get('oidc:user:alice');
    await db.delete('oidc:user:bob');

    expect(openStore).toHaveBeenCalledTimes(1);
    expect(inserted).toBe(true);
    expect(alice).toBe('{"email":"alice@example.com"}');
    expect(store.entries()).toEqual([['oidc:user:alice', '{"email":"alice@example.com"}']]);
  });
});
