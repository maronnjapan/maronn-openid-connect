import { useCallback, useEffect, useState } from 'react';
import type { FrameTests, MapData, TestDiff, TestsIndex, TestSource } from '../types';
import type { TestLanguage } from '../lib/tests';

/** The files of the tests fetched so far, by url, shared by every screen (a file never changes for its url, the index aside within a visit). */
const pending = new Map<string, Promise<unknown>>();
const ready = new Map<string, unknown>();

/** Fetch a JSON file of the tests once. */
export function fetchTestFile<T>(url: string): Promise<T> {
  let known = pending.get(url);
  if (known === undefined) {
    known = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const value = (await response.json()) as unknown;
      ready.set(url, value);
      return value;
    });
    known.catch(() => pending.delete(url));
    pending.set(url, known);
  }
  return known as Promise<T>;
}

/** A file of the tests as a screen sees it: not asked for, on its way, read, or not readable (with why). */
export type Loaded<T> = { state: 'none' } | { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed'; message: string };

/** A JSON file of the tests, read when a screen needs it (none for no url); a file read before is there at once. */
export function useTestFile<T>(url: string | undefined): Loaded<T> {
  const [, setRead] = useState(0);
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (url === undefined || ready.has(url)) return;
    let live = true;
    fetchTestFile<T>(url)
      .then(() => {
        if (live) setRead((count) => count + 1);
      })
      .catch((error: unknown) => {
        if (live) setFailed((current) => new Map(current).set(url, error instanceof Error ? error.message : String(error)));
      });
    return () => {
      live = false;
    };
  }, [url]);
  if (url === undefined) return { state: 'none' };
  if (ready.has(url)) return { state: 'ready', value: ready.get(url) as T };
  const message = failed.get(url);
  return message === undefined ? { state: 'loading' } : { state: 'failed', message };
}

/**
 * The index of the tests (tests.json), read after map.json so it never holds
 * the first view back; none when the map has no tests, and a failure when
 * the file is not of the version the page reads.
 */
export function useTestsIndex(data: MapData): Loaded<TestsIndex> {
  const loaded = useTestFile<TestsIndex>(data.tests?.index);
  if (loaded.state === 'ready' && loaded.value.version !== 1) return { state: 'failed', message: `テストのデータの版（${String(loaded.value.version)}）がこのページ（1）と合いません` };
  return loaded;
}

/** The cards of a frame or an endpoint (tests/by-frame, tests/by-endpoint). */
export function useFrameTests(url: string | undefined): Loaded<FrameTests> {
  return useTestFile<FrameTests>(url);
}

/** The text of a test file (tests/sources). */
export function useTestSource(url: string | undefined): Loaded<TestSource> {
  return useTestFile<TestSource>(url);
}

/** The diff of the tests of a pull request (tests/diff.json), in the map of one. */
export function useTestDiff(data: MapData): Loaded<TestDiff> {
  return useTestFile<TestDiff>(data.tests?.diff);
}

/** Where the reader's choice of the language of the tests is kept (a convenience of this browser only, like map.outline.code). */
const LANGUAGE_KEY = 'map.tests.language';

function readLanguage(): TestLanguage {
  try {
    return globalThis.localStorage?.getItem(LANGUAGE_KEY) === 'ja' ? 'ja' : 'en';
  } catch {
    return 'en';
  }
}

function writeLanguage(value: TestLanguage): void {
  try {
    globalThis.localStorage?.setItem(LANGUAGE_KEY, value);
  } catch {
    // Storage may be unavailable (a private window); the choice then lasts for this page only.
  }
}

/** The language the reader reads the tests in (English / 日本語), kept for this browser; a tab mounted again reads it again. */
export function useTestLanguage(): [TestLanguage, (next: TestLanguage) => void] {
  const [language, setLanguage] = useState<TestLanguage>(readLanguage);
  const choose = useCallback((next: TestLanguage) => {
    setLanguage(next);
    writeLanguage(next);
  }, []);
  return [language, choose];
}
