/**
 * What every screen reads: the indexed data, the view of the hash, the
 * language and the source the reader chose, and how to move to another view.
 */
import type { FileTests, TestCase, TestEntry, TestSource } from '@maronn-openid-connect/test-catalog/model';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { Db } from '../lib/data';
import type { Lang } from '../lib/filter';
import { loadJson } from '../lib/load';
import type { Source, View } from '../lib/route';

export interface AppState {
  db: Db;
  view: View;
  lang: Lang;
  source: Source;
  /** Show a view: a new entry of the history, or in place of the current one (a filter). */
  go: (view: View, options?: { replace?: boolean }) => void;
  /** Choose the source whose endpoints the home and the endpoint page show. */
  chooseSource: (source: Source) => void;
}

/** The width at and below which the page is laid out for a phone (styles.css uses the same). */
export const NARROW_QUERY = '(max-width: 768px)';

function matchesNarrow(): boolean {
  try {
    return window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

/** Whether the window is a phone's, following its changes. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(matchesNarrow);
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(NARROW_QUERY);
    } catch {
      return undefined;
    }
    const follow = () => setNarrow(query.matches);
    follow();
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  return narrow;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (state === null) throw new Error('useApp outside the app');
  return state;
}

/** The title of the browser tab: the screen's name before the page's. */
export function useTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title === undefined || title === '' ? 'テスト · OIDC Provider' : `${title} · テスト`;
  }, [title]);
}

/** A JSON file of the data, fetched once; undefined while it loads, an Error when it could not be read. */
export function useJson<T>(url: string | undefined): T | Error | undefined {
  const [state, setState] = useState<{ url: string | undefined; value: T | Error | undefined }>({ url, value: undefined });
  useEffect(() => {
    if (url === undefined) return undefined;
    let live = true;
    loadJson<T>(url).then(
      (value) => live && setState({ url, value }),
      (error: unknown) => live && setState({ url, value: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return state.url === url ? state.value : undefined;
}

/** The full card of a test, from the cards of its file. */
export function useCard(entry: TestEntry | undefined): TestCase | Error | undefined {
  const file = useJson<FileTests>(entry?.card);
  if (entry?.card === undefined) return new Error('このテストのカードがありません');
  if (file === undefined || file instanceof Error) return file;
  return file.tests.find((test) => test.id === entry.id) ?? new Error('カードの中にこのテストがありません');
}

/**
 * The cards of some files, fetched once each as a list needs them (the
 * routes of its E2E tests): the files that arrived so far, by url. A file
 * that cannot be read is left out, and its rows say what the index knows.
 */
export function useCards(urls: ReadonlyArray<string | undefined>): ReadonlyMap<string, FileTests> {
  const key = useMemo(() => [...new Set(urls.filter((url): url is string => url !== undefined))].sort().join('\n'), [urls]);
  const [cards, setCards] = useState<ReadonlyMap<string, FileTests>>(() => new Map());
  useEffect(() => {
    if (key === '') return undefined;
    let live = true;
    for (const url of key.split('\n')) {
      loadJson<FileTests>(url).then(
        (file) => {
          if (live) setCards((previous) => (previous.get(url) === file ? previous : new Map(previous).set(url, file)));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [key]);
  return cards;
}

/** The text of a file of the data: a test file, a helper, a function, an endpoint. */
export function useSource(path: string | undefined): TestSource | Error | undefined {
  const { db } = useApp();
  const url = path === undefined ? undefined : db.index.sources[path];
  const source = useJson<TestSource>(url);
  if (path !== undefined && url === undefined) return new Error('このファイルのコードがデータにありません');
  return source;
}
