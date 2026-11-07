/**
 * The files of the page's data, fetched once each: tests.json and
 * outline.json when the page opens, and the cards and the text of a test
 * file when a test is opened. The data step of the map may be rewriting them
 * while the page loads, so a failed fetch is tried once more before it counts.
 */

/** The diff of the tests of a pull request, there when tests.json says `diff: true`. */
export const DIFF_URL = './data/tests/diff.json';

/** The data is not there: the page was built without running the map's data step. */
export class MissingData extends Error {
  constructor(readonly url: string) {
    super(`${url} がありません`);
    this.name = 'MissingData';
  }
}

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Fetch and read a JSON file, trying once more after a failure. A 404, or a
 * page of HTML where the JSON should be (a dev server answers a missing file
 * with its index.html), is MissingData.
 */
export async function fetchJson<T>(url: string, fetcher: Fetch = (input) => fetch(input), retries = 1): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetcher(url);
      if (response.status === 404) throw new MissingData(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      const text = await response.text();
      if (/^\s*</.test(text)) throw new MissingData(url);
      return JSON.parse(text) as T;
    } catch (error) {
      if (attempt >= retries) throw error;
    }
  }
}

const cache = new Map<string, Promise<unknown>>();

/** Fetch a JSON file once; a failure is forgotten, so opening it again tries again. */
export function loadJson<T>(url: string): Promise<T> {
  let promise = cache.get(url) as Promise<T> | undefined;
  if (promise === undefined) {
    promise = fetchJson<T>(url);
    cache.set(url, promise);
    promise.catch(() => cache.delete(url));
  }
  return promise;
}
