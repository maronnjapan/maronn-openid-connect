import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChangesScreen } from './components/ChangesScreen';
import { EndpointScreen } from './components/EndpointScreen';
import { FunctionScreen } from './components/FunctionScreen';
import { Search } from './components/Search';
import { Sidebar } from './components/Sidebar';
import { indexChanges } from './lib/changes';
import { buildHash, parseHash, type View } from './lib/hash';
import { defaultEnabled, featuresToShow, visibleEndpoints, type SearchHit } from './lib/model';
import type { MapData } from './types';

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
      .then((data) => setLoaded({ state: 'ready', data }))
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
  return <ProviderMap data={loaded.data} />;
}

/** The depth of the page in the history of the map: the entries a back button can return through. */
function historyDepth(): number {
  const state = history.state as { mapDepth?: number } | null;
  return typeof state?.mapDepth === 'number' ? state.mapDepth : 0;
}

/**
 * The map: the endpoints of a configuration on the left, the open endpoint or
 * function filling the rest. The map of a pull request opens on the changes
 * of the pull request.
 */
function ProviderMap({ data }: { data: MapData }) {
  const changes = useMemo(() => indexChanges(data), [data]);
  const fallbackEndpoint = useCallback(
    (framework: string) => {
      const flow = data.flows[framework];
      return flow?.endpoints.some((endpoint) => endpoint.id === 'token') ? 'token' : (flow?.endpoints[0]?.id ?? null);
    },
    [data],
  );
  const fromHash = useCallback(
    (framework: string): View => {
      const view = parseHash(location.hash, data, { framework, endpoint: null, step: null, fn: null });
      if (view.changes === true && changes === undefined) view.changes = false;
      if (view.endpoint === null && view.fn === null && view.changes !== true) {
        if (changes !== undefined) view.changes = true;
        else view.endpoint = fallbackEndpoint(view.framework);
      }
      return view;
    },
    [data, changes, fallbackEndpoint],
  );
  const [view, setView] = useState<View>(() => fromHash(data.frameworks[0] ?? 'hono'));
  const [depth, setDepth] = useState(historyDepth);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(readSavedFeatures() ?? defaultEnabled(data.features)));
  const [sidebar, setSidebar] = useState(() => readSaved(SIDEBAR_KEY) !== 'closed' && window.matchMedia('(min-width: 900px)').matches);
  const [checked, setChecked] = useState<Record<string, Set<string>>>({});

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
    };
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
    };
  }, [fromHash]);

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
    },
    [data],
  );

  const flow = data.flows[view.framework] ?? (data.flows[data.frameworks[0] as string] as MapData['flows'][string]);
  const endpoints = useMemo(() => visibleEndpoints(flow, data.features, enabled, data.edgeSets), [flow, data.features, enabled, data.edgeSets]);
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
  const onChanges = card === undefined && view.changes === true && changes !== undefined;
  const endpoint = onChanges ? undefined : (endpoints.find((candidate) => candidate.id === view.endpoint) ?? (view.fn === null ? endpoints[0] : undefined));
  const narrow = () => !window.matchMedia('(min-width: 900px)').matches;

  const openEndpoint = (id: string) => {
    navigate({ ...view, endpoint: id, step: null, fn: null, changes: false }, 'push');
    if (narrow()) setSidebar(false);
  };
  const openStep = (endpointId: string, step: string) => navigate({ ...view, endpoint: endpointId, step, fn: null, changes: false }, 'push');
  const openFunction = (id: string) => navigate({ ...view, fn: id }, 'push');
  const openChanges = () => navigate({ ...view, endpoint: null, step: null, fn: null, changes: true }, 'push');
  const onPick = (hit: SearchHit) => {
    if ('fn' in hit.target) openFunction(hit.target.fn);
    else openStep(hit.target.endpoint, hit.target.step);
  };
  const onCases = (key: string, next: Set<string>) => setChecked((current) => ({ ...current, [key]: next }));

  return (
    <div className={`app${sidebar ? ' sidebar-open' : ''}`}>
      <header className="top">
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
        <h1>OIDC Provider Map</h1>
        {changes !== undefined ? (
          <button type="button" className="changes-button" aria-pressed={onChanges} onClick={openChanges} title="このPRで変えた関数と、その説明">
            このPRの変更
            <span className="count">{changes.changes.functions.filter((change) => change.kind !== 'noted').length}</span>
          </button>
        ) : null}
        <div className="seg" role="group" aria-label="フレームワーク">
          {data.frameworks.map((name) => (
            <button key={name} type="button" aria-pressed={name === view.framework} onClick={() => navigate({ ...view, framework: name, step: null }, 'replace')}>
              {name}
            </button>
          ))}
        </div>
        <Search data={data} endpoints={endpoints} onPick={onPick} />
      </header>
      <div className="body">
        {sidebar ? (
          <Sidebar
            data={data}
            changes={changes}
            flow={flow}
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
            onEndpoint={openEndpoint}
          />
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
              checked={checked[`fn:${card.id}`]}
              canGoBack={depth > 0}
              onCases={onCases}
              onBack={() => history.back()}
              onOpenFunction={openFunction}
              onOpenStep={openStep}
              onOpenEndpoint={openEndpoint}
              onFramework={(framework) => navigate({ ...view, framework }, 'replace')}
            />
          ) : onChanges ? (
            <ChangesScreen data={data} index={changes} flow={flow} onOpenFunction={openFunction} onOpenEndpoint={openEndpoint} />
          ) : endpoint !== undefined ? (
            <EndpointScreen
              key={`${view.framework}/${endpoint.id}`}
              data={data}
              changes={changes}
              endpoint={endpoint}
              selected={view.step}
              checked={checked[`endpoint:${endpoint.id}`]}
              onCases={onCases}
              onSelectStep={(step) => navigate({ ...view, endpoint: endpoint.id, step, fn: null }, 'replace')}
              onOpenFunction={openFunction}
            />
          ) : (
            <p className="empty">左の一覧からエンドポイントを選んでください。</p>
          )}
        </main>
      </div>
    </div>
  );
}
