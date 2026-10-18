import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from './database';
import { createDatabase as createInstanceDatabase } from './instance';
import { createDatabase } from './index';

vi.mock('./instance', () => ({ createDatabase: vi.fn() }));

const openDatabase = vi.mocked(createInstanceDatabase);

beforeEach(() => {
  openDatabase.mockReset();
});

describe('createDatabase', () => {
  // `next build` imports the Route Handlers, and provider.ts creates its database at import:
  // the generated instance.ts throws until it is written.
  it('should not call createDatabase() of instance.ts before the first statement', () => {
    openDatabase.mockImplementation(() => {
      throw new Error('db/instance.ts: createDatabase() is not implemented yet.');
    });

    createDatabase();

    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('should call createDatabase() of instance.ts once and run every statement on its database', async () => {
    const statements: string[] = [];
    const database: SqlDatabase = {
      all: async <Row>(statement: { sql: string }) => {
        statements.push(statement.sql);
        return [{ id: 'client-1' }] as Row[];
      },
      run: async (statement) => {
        statements.push(statement.sql);
        return { changes: 1 };
      },
    };
    openDatabase.mockReturnValue(database);
    const db = createDatabase();

    const rows = await db.all({ sql: 'SELECT id FROM clients', params: [] });
    const result = await db.run({ sql: 'DELETE FROM clients WHERE id = ?', params: ['client-1'] });

    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ id: 'client-1' }]);
    expect(result).toEqual({ changes: 1 });
    expect(statements).toEqual(['SELECT id FROM clients', 'DELETE FROM clients WHERE id = ?']);
  });
});
