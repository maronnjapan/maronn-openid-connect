import { describe, expect, it } from 'vitest';
import { fetchJson, MissingData, type Fetch } from './load';

function answers(...responses: Array<{ status: number; body?: string } | Error>): Fetch & { calls: number } {
  const fetcher = Object.assign(
    async () => {
      const next = responses[Math.min(fetcher.calls, responses.length - 1)] as { status: number; body?: string } | Error;
      fetcher.calls += 1;
      if (next instanceof Error) throw next;
      return { ok: next.status >= 200 && next.status < 300, status: next.status, text: async () => next.body ?? '' };
    },
    { calls: 0 },
  );
  return fetcher;
}

describe('fetchJson', () => {
  it('should read the JSON of a file', async () => {
    await expect(fetchJson('./data/tests.json', answers({ status: 200, body: '{"version":1}' }))).resolves.toEqual({ version: 1 });
  });

  it('should try once more after a failure', async () => {
    const fetcher = answers(new Error('reset'), { status: 200, body: '[1]' });
    await expect(fetchJson('./data/tests.json', fetcher)).resolves.toEqual([1]);
    expect(fetcher.calls).toBe(2);
  });

  it('should tell missing data from a 404 or a page of HTML', async () => {
    await expect(fetchJson('./data/tests.json', answers({ status: 404 }))).rejects.toBeInstanceOf(MissingData);
    await expect(fetchJson('./data/tests.json', answers({ status: 200, body: '<!doctype html>' }))).rejects.toBeInstanceOf(MissingData);
  });

  it('should give up after the second failure', async () => {
    const fetcher = answers({ status: 500 });
    await expect(fetchJson('./data/tests.json', fetcher)).rejects.toThrow('HTTP 500');
    expect(fetcher.calls).toBe(2);
  });
});
