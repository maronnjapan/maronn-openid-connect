/**
 * The tests viewer: loads tests.json and outline.json once (and in the build
 * of a pull request its diff, tests/diff.json, which marks the tests it
 * touched), follows the view in the hash and shows its screen, with the
 * panel of a test over a list.
 */
import type { TestDiff, TestsIndex, TestsOutline } from '@maronn-openid-connect/test-catalog/model';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppContext, useNarrow, type AppState } from './components/app-context';
import { EndpointPage } from './components/EndpointPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FilePage, FilesPage } from './components/FilesPage';
import { Header } from './components/Header';
import { Home } from './components/Home';
import { KindPage } from './components/KindPage';
import { Panel, TestPage } from './components/Panel';
import { PrPage } from './components/PrPage';
import { SearchPage } from './components/SearchPage';
import { SourceSwitch } from './components/ui';
import { buildDb, type Db } from './lib/data';
import type { Lang } from './lib/filter';
import { DIFF_URL, loadJson, MissingData } from './lib/load';
import { formatHash, panelOf, parseHash, samePage, type Source, type View } from './lib/route';

const TESTS_URL = './data/tests.json';
const OUTLINE_URL = './data/outline.json';

/** A preference of this reader (the language, the source), kept in this browser when it can be. */
function remembered<T extends string>(key: string, values: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return values.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A private window or blocked storage: the choice lasts until the page closes.
  }
}

type Loaded = { db: Db } | { error: Error } | undefined;

function NoData({ error }: { error: Error }) {
  if (error instanceof MissingData) {
    return (
      <div className="page no-data">
        <h1>テストのデータがありません</h1>
        <p>
          <code>./data/tests.json</code> が見つかりませんでした。データは地図のデータの手順が作ります。リポジトリのルートで次を実行してください。
        </p>
        <pre className="command">pnpm run build:map</pre>
        <p className="muted">
          地図のパッケージだけを作り直すなら <code>pnpm --filter @maronn-openid-connect/map run data</code>。データは apps/tests/public/data に書き出されます。
        </p>
      </div>
    );
  }
  return (
    <div className="page no-data">
      <h1>データを読み込めませんでした</h1>
      <p className="muted">{error.message}</p>
      <button type="button" className="more" onClick={() => window.location.reload()}>
        もう一度読み込む
      </button>
    </div>
  );
}

function Screen({ view }: { view: View }) {
  switch (view.page) {
    case 'kind':
      return <KindPage />;
    case 'endpoint':
      return <EndpointPage />;
    case 'files':
      return <FilesPage />;
    case 'file':
      return <FilePage />;
    case 'pr':
      return <PrPage />;
    case 'search':
      return <SearchPage />;
    case 'test':
      return <TestPage />;
    default:
      return <Home />;
  }
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded>(undefined);
  const [view, setView] = useState<View>(() => parseHash(window.location.hash));
  const [lang, setLang] = useState<Lang>(() => remembered('tests.lang', ['ja', 'en'], 'ja'));
  const [source, setSource] = useState<Source>(() => remembered('tests.source', ['hono', 'nextjs'], 'hono'));
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    // The diff of a pull request is small and read before the first screen, so its marks are there from the start; a
    // diff that cannot be read leaves the tests unmarked and the page of the pull request says why.
    const index = loadJson<TestsIndex>(TESTS_URL);
    const diff = index.then((value) =>
      value.diff === true ? loadJson<TestDiff>(DIFF_URL).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))) : undefined,
    );
    // Indexing data the page cannot read fails here too, and says so rather than loading for ever.
    Promise.all([index, loadJson<TestsOutline>(OUTLINE_URL).catch(() => undefined), diff])
      .then(([value, outline, changes]) => buildDb(value, outline, changes))
      .then(
        (db) => setLoaded({ db }),
        (error: unknown) => setLoaded({ error: error instanceof Error ? error : new Error(String(error)) }),
      );
  }, []);

  useEffect(() => {
    const follow = () => setView(parseHash(window.location.hash));
    window.addEventListener('popstate', follow);
    window.addEventListener('hashchange', follow);
    return () => {
      window.removeEventListener('popstate', follow);
      window.removeEventListener('hashchange', follow);
    };
  }, []);

  // The endpoint page names its source: the switch follows it.
  useEffect(() => {
    if (view.page === 'endpoint' && view.source !== undefined) setSource(view.source);
  }, [view.page, view.source]);

  // A new screen starts at its top; a filter or the panel keeps the place.
  const previous = useRef(view);
  useLayoutEffect(() => {
    if (!samePage(previous.current, view)) window.scrollTo({ top: 0 });
    previous.current = view;
  }, [view]);

  const go = useCallback((next: View, options?: { replace?: boolean }) => {
    const current = viewRef.current;
    const hash = formatHash(next);
    if (hash === window.location.hash) return;
    // Closing a panel this page opened goes back, so the back button does not open it again.
    if (panelOf(current) !== undefined && panelOf(next) === undefined && samePage(current, next) && window.history.state?.panel === true) {
      window.history.back();
      return;
    }
    const panel = panelOf(next) !== undefined && panelOf(current) === undefined && samePage(current, next);
    if (options?.replace === true) window.history.replaceState(window.history.state, '', hash);
    else window.history.pushState({ panel }, '', hash);
    setView(parseHash(hash));
  }, []);

  const chooseLang = useCallback((next: Lang) => {
    setLang(next);
    remember('tests.lang', next);
  }, []);

  const chooseSource = useCallback(
    (next: Source) => {
      setSource(next);
      remember('tests.source', next);
      const current = viewRef.current;
      if (current.page === 'endpoint' && current.source !== next) go({ page: 'endpoint', source: next, endpoint: current.endpoint }, { replace: true });
    },
    [go],
  );

  const narrow = useNarrow();
  const state = useMemo<AppState | undefined>(
    () => (loaded !== undefined && 'db' in loaded ? { db: loaded.db, view, lang, source, go, chooseSource } : undefined),
    [loaded, view, lang, source, go, chooseSource],
  );
  // The panel of a test or of some code over a list; the file page shows the test in its own code on a desk, but a test a
  // pull request removed has no code, and opens in the panel there too.
  const removed = view.test !== undefined && state?.db.pr?.removedById.has(view.test) === true;
  const panelTest = view.page === 'test' || (view.page === 'file' && !narrow && !removed) ? undefined : view.test;
  const panelCode = view.page === 'test' || panelTest !== undefined ? undefined : view.code;
  const panel = panelTest ?? panelCode;
  // The source chooses the endpoints of home, the endpoint page and the API tests.
  const showsSource = view.page === 'home' || view.page === 'endpoint' || (view.page === 'kind' && view.testKind === 'api');

  // While the panel is open the page under it is inert: Tab stays in the panel.
  const shell = (
    <div className="shell" inert={state !== undefined && panel !== undefined}>
      <Header view={view} lang={lang} onLang={chooseLang} go={go} source={state !== undefined && showsSource ? <SourceSwitch place="header" /> : undefined} />
      <main className="main">
        {loaded === undefined && <p className="note page">テストを読み込んでいます…</p>}
        {loaded !== undefined && 'error' in loaded && <NoData error={loaded.error} />}
        {state !== undefined && (
          <ErrorBoundary reset={formatHash(view)}>
            <Screen view={view} />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
  if (state === undefined) return shell;
  return (
    <AppContext.Provider value={state}>
      {shell}
      {panel !== undefined && <Panel test={panelTest} code={panelCode} />}
    </AppContext.Provider>
  );
}

