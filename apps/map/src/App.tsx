import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfigPanel } from './components/ConfigPanel';
import { DetailPanel } from './components/DetailPanel';
import { FlowPanel } from './components/FlowPanel';
import { Search } from './components/Search';
import { buildHash, parseHash, type View } from './lib/hash';
import { defaultEnabled, visibleEndpoints, type SearchHit } from './lib/model';
import type { MapData } from './types';

const FEATURES_KEY = 'oidc-map-features';

function readSavedFeatures(): string[] | undefined {
  try {
    const saved = localStorage.getItem(FEATURES_KEY);
    return saved ? (JSON.parse(saved) as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function saveFeatures(enabled: ReadonlySet<string>): void {
  try {
    localStorage.setItem(FEATURES_KEY, JSON.stringify([...enabled]));
  } catch {
    // no storage: the toggles still work for this visit
  }
}

type Loaded = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ready'; data: MapData };

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
  if (loaded.state === 'loading') return <div className="wrap"><p className="empty">Loading the map…</p></div>;
  if (loaded.state === 'failed') {
    return (
      <div className="wrap">
        <p className="empty">
          The map data (data/map.json) could not be loaded: {loaded.message}. Build it with <code>pnpm run build:map</code>.
        </p>
      </div>
    );
  }
  return <Map data={loaded.data} />;
}

function Map({ data }: { data: MapData }) {
  const [view, setView] = useState<View>(() => {
    const defaults: View = { framework: data.frameworks[0] ?? 'hono', endpoint: null, step: null, fn: null };
    const fromHash = parseHash(location.hash, data, defaults);
    if (fromHash.endpoint === null && fromHash.fn === null) {
      const flow = data.flows[fromHash.framework];
      fromHash.endpoint = flow?.endpoints.some((endpoint) => endpoint.id === 'token') ? 'token' : (flow?.endpoints[0]?.id ?? null);
    }
    return fromHash;
  });
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(readSavedFeatures() ?? defaultEnabled(data.features)));
  const [showErrors, setShowErrors] = useState(false);

  // The hash follows the view, and the view follows the hash (a link, the back button).
  useEffect(() => {
    const hash = buildHash(view, data);
    if (hash && location.hash !== `#${hash}`) history.replaceState(null, '', `#${hash}`);
  }, [view, data]);
  useEffect(() => {
    const onHash = () => setView((current) => parseHash(location.hash, data, { ...current, endpoint: null, step: null, fn: null }));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [data]);

  const flow = data.flows[view.framework] ?? data.flows[data.frameworks[0] as string]!;
  const endpoints = useMemo(() => visibleEndpoints(flow, data.features, enabled), [flow, data.features, enabled]);
  const endpoint = endpoints.find((candidate) => candidate.id === view.endpoint);
  const step = endpoint?.steps.find((candidate) => candidate.id === view.step);
  const fn = view.fn === null ? undefined : data.functions[view.fn];

  const openStep = useCallback((endpointId: string, stepId: string) => setView((current) => ({ ...current, endpoint: endpointId, step: stepId, fn: null })), []);
  const openFunction = useCallback((id: string) => {
    setView((current) => ({ ...current, fn: id }));
    document.querySelector('.detail')?.scrollIntoView({ block: 'nearest' });
  }, []);
  const onPick = (hit: SearchHit) => {
    if ('fn' in hit.target) openFunction(hit.target.fn);
    else openStep(hit.target.endpoint, hit.target.step);
  };

  return (
    <div className="wrap">
      <header className="top">
        <h1>OIDC Provider Map</h1>
        <span className="sub">
          What <code>maronn-oidc generate</code> produces: endpoints, their steps, and the functions down to core.
        </span>
        <Search data={data} endpoints={endpoints} onPick={onPick} />
      </header>
      <div className="cols">
        <ConfigPanel
          data={data}
          framework={view.framework}
          enabled={enabled}
          endpoints={endpoints}
          selected={endpoint?.id ?? null}
          onFramework={(framework) => setView((current) => ({ ...current, framework, fn: null }))}
          onToggleFeature={(id, on) => {
            const next = new Set(enabled);
            if (on) next.add(id);
            else next.delete(id);
            saveFeatures(next);
            setEnabled(next);
          }}
          onEndpoint={(id) => setView((current) => ({ ...current, endpoint: id, step: null, fn: null }))}
        />
        <FlowPanel endpoint={endpoint} data={data} selected={step?.id ?? null} showErrors={showErrors} onToggleErrors={setShowErrors} onSelect={(id) => setView((current) => ({ ...current, step: id, fn: null }))} />
        <DetailPanel
          data={data}
          framework={view.framework}
          flow={flow}
          endpoint={endpoint}
          step={step}
          fn={fn}
          onOpenFunction={openFunction}
          onOpenStep={openStep}
          onBack={() => setView((current) => (current.fn !== null ? { ...current, fn: null } : { ...current, step: null }))}
        />
      </div>
    </div>
  );
}
