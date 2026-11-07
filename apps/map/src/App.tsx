import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChangesScreen } from './components/ChangesScreen';
import { EndpointScreen } from './components/EndpointScreen';
import { FunctionScreen } from './components/FunctionScreen';
import { MobileMenu, MobileMenuSection, useMobileMenu } from './components/MobileMenu';
import { Search } from './components/Search';
import { Sidebar } from './components/Sidebar';
import { TestsScreen } from './components/TestsScreen';
import { useTestsIndex } from './components/useTests';
import { WiringScreen } from './components/WiringScreen';
import { indexChanges } from './lib/changes';
import { buildHash, parseHash, plainView, type View } from './lib/hash';
import { defaultEnabled, enabledMarkers, featuresMissing, featuresToShow, visibleEndpoints, type SearchHit } from './lib/model';
import { EMPTY_TRACE, sourceOf, type TraceState } from './lib/trace';
import type { MapData, Reach } from './types';

const FEATURES_KEY = 'oidc-map-features';
const SIDEBAR_KEY = 'oidc-map-sidebar';

/** A value the browser kept for this page, or undefined (no storage, a private window). */
function readSaved(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keep a value for the next visit; without storage the page works for this visit only. */
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // no storage: the setting lasts for this visit
  }
}

/** The features a reader turned on last time, if they did. */
function readSavedFeatures(): string[] | undefined {
  const saved = readSaved(FEATURES_KEY);
  if (saved === undefined) return undefined;
  try {
    return JSON.parse(saved) as string[];
  } catch {
    return undefined;
  }
}

type Loaded = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ready'; data: MapData };

/** Load the data of the map and show it, or say why it cannot. */
export function App() {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    fetch('./data/map.json')
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return (await response.json()) as MapData;
      })
      .then((data) => {
        if (data.version !== 4) throw new Error(`地図のデータの版（${String(data.version)}）がこのページ（4）と合いません`);
        setLoaded({ state: 'ready', data });
      })
      .catch((error: unknown) => setLoaded({ state: 'failed', message: error instanceof Error ? error.message : String(error) }));
  }, []);
  if (loaded.state === 'loading') return <p className="empty">地図を読み込んでいます…</p>;
  if (loaded.state === 'failed') {
    return (
      <p className="empty">
        地図のデータ（data/map.json）を読み込めませんでした: {loaded.message}。<code>pnpm run build:map</code> でビルドしてください。
      </p>
    );
  }
  return (
    <MobileMenu>
      <ProviderMap data={loaded.data} />
    </MobileMenu>
  );
}

/** The depth of the page in the history of the map: the entries a back button can return through. */
function historyDepth(): number {
  const state = history.state as { mapDepth?: number } | null;
  return typeof state?.mapDepth === 'number' ? state.mapDepth : 0;
}

/**
 * The map: the endpoints of a configuration on the left, the open endpoint or
 * function filling the rest. The map of a pull request opens on the changes
 * of the pull request. The tests (tests.json) are read after the map, so the
 * first view never waits for them, and the page is whole without them.
 */
function ProviderMap({ data }: { data: MapData }) {
  const { mobile, close: closeMenu } = useMobileMenu();
  const tests = useTestsIndex(data);
  const testsIndex = tests.state === 'ready' ? tests.value : undefined;
  // Whether the map is of a pull request is known before a view is: the changes as the default framework reaches them.
  const anyChanges = useMemo(() => indexChanges(data), [data]);
  const fallbackEndpoint = useCallback(
    (framework: string) => {
      const flow = data.flows[framework];
      return flow?.endpoints.some((endpoint) => endpoint.id === 'token') ? 'token' : (flow?.endpoints[0]?.id ?? null);
    },
    [data],
  );
  const fromHash = useCallback(
    (framework: string): View => {
      const view = parseHash(location.hash, data, { framework, endpoint: null, step: null, fn: null, trace: EMPTY_TRACE });
      if (view.changes === true && anyChanges === undefined) view.changes = false;
      if (view.endpoint === null && view.fn === null && view.changes !== true && view.wiring !== true && view.tests !== true) {
        if (anyChanges !== undefined) view.changes = true;
        else view.endpoint = fallbackEndpoint(view.framework);
      }
      return view;
    },
    [data, anyChanges, fallbackEndpoint],
  );
  const [view, setView] = useState<View>(() => fromHash(data.frameworks[0] ?? 'hono'));
  // The changes as the endpoints of the framework shown reach them: an implementation in hono or nextjs reaches only its own endpoints.
  const changes = useMemo(() => indexChanges(data, sourceOf(view.framework)), [data, view.framework]);
  const [depth, setDepth] = useState(historyDepth);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(readSavedFeatures() ?? defaultEnabled(data.features)));
  const [sidebar, setSidebar] = useState(() => readSaved(SIDEBAR_KEY) !== 'closed' && window.matchMedia('(min-width: 900px)').matches);

  // The first entry names the view, so a reload or a shared link opens the same page.
  useEffect(() => {
    const hash = buildHash(view, data);
    if (hash && location.hash !== `#${hash}`) history.replaceState({ mapDepth: historyDepth() }, '', `#${hash}`);
  }, []);
  // Back, forward, or a hash typed by hand.
  useEffect(() => {
    const onChange = () => {
      setView((current) => fromHash(current.framework));
      setDepth(historyDepth());
      closeMenu();
    };
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
    };
  }, [fromHash, closeMenu]);

  /** Show a view: a new page (push) leaves an entry the back button returns to; a step of the same endpoint (replace) does not. */
  const navigate = useCallback(
    (next: View, mode: 'push' | 'replace') => {
      const hash = `#${buildHash(next, data)}`;
      if (hash !== location.hash) {
        if (mode === 'push') {
          history.pushState({ mapDepth: historyDepth() + 1 }, '', hash);
        } else {
          history.replaceState({ mapDepth: historyDepth() }, '', hash);
        }
      }
      setDepth(historyDepth());
      setView(next);
      if (mode === 'push') closeMenu();
    },
    [data, closeMenu],
  );

  const flow = data.flows[view.framework] ?? (data.flows[data.frameworks[0] as string] as MapData['flows'][string]);
  const endpoints = useMemo(() => visibleEndpoints(flow, data.features, enabled), [flow, data.features, enabled]);
  const markers = useMemo(() => enabledMarkers(data.features, enabled), [data.features, enabled]);
  // A link or a caller may name an endpoint or a step of a feature that is off: turn the feature on to show it.
  useEffect(() => {
    if (view.fn !== null) return;
    const missing = featuresToShow(flow, data.features, enabled, view.endpoint, view.step);
    if (missing.length === 0) return;
    const next = new Set([...enabled, ...missing]);
    save(FEATURES_KEY, JSON.stringify([...next]));
    setEnabled(next);
  }, [flow, data.features, enabled, view]);
  const card = view.fn === null ? undefined : data.functions[view.fn];
  const onWiring = card === undefined && view.wiring === true;
  const onChanges = card === undefined && !onWiring && view.changes === true && changes !== undefined;
  const onTests = card === undefined && !onWiring && !onChanges && view.tests === true;
  const endpoint = onChanges || onWiring || onTests ? undefined : (endpoints.find((candidate) => candidate.id === view.endpoint) ?? (view.fn === null ? endpoints[0] : undefined));
  const narrow = () => !window.matchMedia('(min-width: 900px)').matches;

  /** Open an endpoint, on the tab of the pane a page asks for (テスト from the list of the tests). */
  const openEndpoint = (id: string, tab?: string) => {
    navigate({ ...plainView(view), endpoint: id, step: null, fn: null, changes: false, wiring: false, tests: false, trace: EMPTY_TRACE, ...(tab === undefined ? {} : { tab }) }, 'push');
    if (narrow()) setSidebar(false);
  };
  const openStep = (endpointId: string, step: string) => navigate({ ...plainView(view), endpoint: endpointId, step, fn: null, changes: false, wiring: false, tests: false, trace: EMPTY_TRACE }, 'push');
  const openFunction = (id: string, tab?: string) => navigate({ ...plainView(view), fn: id, changes: false, wiring: false, tests: false, trace: EMPTY_TRACE, ...(tab === undefined ? {} : { tab }) }, 'push');
  const openChanges = () => navigate({ ...plainView(view), endpoint: null, step: null, fn: null, changes: true, wiring: false, tests: false, trace: EMPTY_TRACE }, 'push');
  const openWiring = () => navigate({ ...plainView(view), endpoint: null, step: null, fn: null, changes: false, wiring: true, tests: false, trace: EMPTY_TRACE }, 'push');
  const openTests = () => navigate({ ...plainView(view), endpoint: null, step: null, fn: null, changes: false, wiring: false, tests: true, trace: EMPTY_TRACE }, 'push');
  /** Open an endpoint's trace along a way to a change: its frames open, its sides chosen, the features it needs on, the diagram on the changed frame. */
  const openWay = (way: Reach) => {
    // A way through a feature that is off turns it on: the trace shows only the frames of the features that are on.
    const missing = featuresMissing(data.features, enabled, way.features);
    if (missing.length > 0) {
      const next = new Set([...enabled, ...missing]);
      save(FEATURES_KEY, JSON.stringify([...next]));
      setEnabled(next);
    }
    const framework = way.frameworks.includes(view.framework) ? view.framework : (way.frameworks[0] ?? view.framework);
    const trace: TraceState = { open: way.frames, choices: Object.keys(way.decisions).length === 0 ? [] : [way.decisions], errors: false, focus: way.frames[way.frames.length - 1] ?? '' };
    navigate({ framework, endpoint: way.endpoint, step: null, fn: null, changes: false, trace, target: way.target }, 'push');
  };
  /** Change the trace of the open page: its frames, choices and focus, kept in the hash without a new entry of the history. */
  const onTrace = (trace: TraceState) => navigate({ ...view, trace }, 'replace');
  const onPick = (hit: SearchHit) => {
    if ('fn' in hit.target) openFunction(hit.target.fn);
    else openStep(hit.target.endpoint, hit.target.step);
  };

  return (
    <div className={`app${sidebar ? ' sidebar-open' : ''}`}>
      <MobileMenuSection section="navigation">
        <header className="top">
          {!mobile ? (
            <button
              type="button"
              className="icon"
              aria-label={sidebar ? 'エンドポイントの一覧を閉じる' : 'エンドポイントの一覧を開く'}
              aria-expanded={sidebar}
              onClick={() => {
                save(SIDEBAR_KEY, sidebar ? 'closed' : 'open');
                setSidebar(!sidebar);
              }}
            >
              ☰
            </button>
          ) : null}
          <h1>OIDC Provider Map</h1>
          {changes !== undefined ? (
            <button type="button" className="changes-button" aria-pressed={onChanges} onClick={openChanges} title="このPRで変えた関数と、その説明">
              このPRの変更
              <span className="count">{changes.changes.frames.filter((change) => change.kind !== 'noted').length}</span>
            </button>
          ) : null}
          <button type="button" className="changes-button" aria-pressed={onWiring} onClick={openWiring} title="型や呼び出しから届く先を確定できない配線">
            追えない配線<span className="count">{data.wiring?.length ?? 0}</span>
          </button>
          {data.tests !== undefined ? (
            <button type="button" className="changes-button" aria-pressed={onTests} onClick={openTests} title="テストの一覧: エンドポイントと機能ごとの数、不足、規則で読めなかったテスト">
              テスト<span className="count">{data.tests.count}</span>
            </button>
          ) : null}
          <div className="seg" role="group" aria-label="フレームワーク">
            {data.frameworks.map((name) => (
              <button key={name} type="button" aria-pressed={name === view.framework} onClick={() => navigate({ ...plainView(view), framework: name, step: null, trace: EMPTY_TRACE }, 'replace')}>
                {name}
              </button>
            ))}
          </div>
          <Search data={data} endpoints={endpoints} onPick={onPick} />
        </header>
      </MobileMenuSection>
      <div className="body">
        {sidebar || mobile ? (
          <MobileMenuSection section="endpoints">
            <Sidebar
              data={data}
              changes={changes}
              framework={view.framework}
              enabled={enabled}
              endpoints={endpoints}
              selected={view.fn === null ? (endpoint?.id ?? null) : null}
              onToggleFeature={(id, on) => {
                const next = new Set(enabled);
                if (on) next.add(id);
                else next.delete(id);
                save(FEATURES_KEY, JSON.stringify([...next]));
                setEnabled(next);
              }}
              onEndpoint={(id) => openEndpoint(id)}
              tests={testsIndex}
            />
          </MobileMenuSection>
        ) : null}
        <main className="main">
          {card !== undefined ? (
            <FunctionScreen
              key={card.id}
              data={data}
              changes={changes}
              framework={view.framework}
              flow={flow}
              card={card}
              trace={view.trace}
              enabled={markers}
              canGoBack={depth > 0}
              onTrace={onTrace}
              onBack={() => history.back()}
              onOpenFunction={(id) => openFunction(id)}
              onOpenStep={openStep}
              onOpenEndpoint={(id) => openEndpoint(id)}
              onFramework={(framework) => navigate({ ...view, framework }, 'replace')}
              tests={tests}
              tab={view.tab}
            />
          ) : onWiring ? (
            <WiringScreen data={data} framework={view.framework} onOpenFunction={(id) => openFunction(id)} />
          ) : onChanges ? (
            <ChangesScreen data={data} index={changes} framework={view.framework} tests={testsIndex} onOpenFunction={(id) => openFunction(id)} onOpenEndpoint={(id) => openEndpoint(id)} onOpenWay={openWay} />
          ) : onTests ? (
            <TestsScreen data={data} index={tests} framework={view.framework} onOpenEndpoint={(id) => openEndpoint(id, 'tests')} onOpenFunction={(id) => openFunction(id, 'tests')} />
          ) : endpoint !== undefined ? (
            <EndpointScreen
              key={`${view.framework}/${endpoint.id}`}
              data={data}
              changes={changes}
              framework={view.framework}
              endpoint={endpoint}
              trace={view.trace}
              enabled={markers}
              step={view.step}
              target={view.target ?? null}
              onTrace={onTrace}
              onOpenFunction={(id) => openFunction(id)}
              onOpenEndpoint={(id) => openEndpoint(id)}
              tests={tests}
              tab={view.tab}
            />
          ) : (
            <p className="empty">左の一覧からエンドポイントを選んでください。</p>
          )}
        </main>
      </div>
    </div>
  );
}
