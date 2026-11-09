import { useMemo } from 'react';
import type { FlowEndpoint, MapData, MapFeature } from '../types';
import { endpointMark, type ChangeIndex } from '../lib/changes';
import { commandLine } from '../lib/model';
import { Badge } from './ChangeParts';
import { FeatureBadge } from './FeatureBadge';

export interface SidebarProps {
  data: MapData;
  /** The changes of the pull request, in the map of one: the endpoints they show in get a badge. */
  changes: ChangeIndex | undefined;
  framework: string;
  enabled: ReadonlySet<string>;
  endpoints: readonly FlowEndpoint[];
  selected: string | null;
  onToggleFeature: (id: string, on: boolean) => void;
  onEndpoint: (id: string) => void;
  onChanges: () => void;
  onWiring: () => void;
  page: 'endpoint' | 'changes' | 'wiring';
}

/** The tier of a feature in words: on by default, of the experimental package, or a login method of an extension. */
const TIER_LABELS: Record<MapFeature['tier'], string> = { stable: '既定', experimental: '実験的', extension: '拡張' };

/**
 * The endpoints of the configuration, grouped by flow, and the features that
 * make the configuration (folded, so the list stays short). In the map of a
 * pull request, an endpoint whose diagram shows a change carries its badge.
 */
export function Sidebar({ data, changes, framework, enabled, endpoints, selected, onToggleFeature, onEndpoint, onChanges, onWiring, page }: SidebarProps) {
  const marks = useMemo(() => new Map(endpoints.map((endpoint) => [endpoint.id, endpointMark(changes, endpoint)])), [changes, endpoints]);
  const rows: React.ReactNode[] = [];
  let group: string | null = null;
  for (const endpoint of endpoints) {
    if (endpoint.group.id !== group) {
      group = endpoint.group.id;
      rows.push(
        // A group can come back later in the list (google-login sits among the authorization code endpoints): key the run, not the group.
        <li key={`group-${group}-${endpoint.id}`} className="group">
          {endpoint.group.label}
        </li>,
      );
    }
    const mark = marks.get(endpoint.id);
    rows.push(
      <li key={endpoint.id}>
        <button type="button" aria-current={endpoint.id === selected ? 'page' : undefined} onClick={() => onEndpoint(endpoint.id)}>
          <span className="endpoint-label">
            {endpoint.label}
            {' '}<FeatureBadge features={data.features} feature={endpoint.feature} />
            {mark === undefined ? null : (
              <>
                {' '}
                <Badge mark={mark} />
              </>
            )}
          </span>
          <span className="route mono">
            {endpoint.methods.join(' | ')} {endpoint.path}
          </span>
        </button>
      </li>,
    );
  }
  const on = data.features.filter((feature) => enabled.has(feature.id)).length;
  return (
    <nav className="sidebar" aria-label="構成">
      <div className="sidebar-pages">
        {changes !== undefined ? (
          <button type="button" aria-current={page === 'changes' ? 'page' : undefined} onClick={onChanges}>
            このPRの変更 <span className="count">{changes.changes.frames.filter((change) => change.kind !== 'noted').length}</span>
          </button>
        ) : null}
        <button type="button" aria-current={page === 'wiring' ? 'page' : undefined} onClick={onWiring}>
          追えない配線 <span className="count">{data.wiring?.length ?? 0}</span>
        </button>
      </div>
      <details className="features">
        <summary>
          機能 <span className="muted">{on} / {data.features.length} 有効</span>
        </summary>
        <div className="feature-list">
          {data.features.map((feature) => (
            <label key={feature.id} title={feature.summary}>
              <input type="checkbox" checked={enabled.has(feature.id)} onChange={(event) => onToggleFeature(feature.id, event.target.checked)} />
              <span>{feature.id}</span>
              <span className="muted">{TIER_LABELS[feature.tier]}</span>
            </label>
          ))}
        </div>
        <pre className="cmd mono">{commandLine(framework, data.features, enabled)}</pre>
      </details>
      <h2>エンドポイント</h2>
      <ul className="endpoints">{rows}</ul>
    </nav>
  );
}
