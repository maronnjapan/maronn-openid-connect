import type { FlowEndpoint, MapData } from '../types';
import { commandLine } from '../lib/model';

export interface SidebarProps {
  data: MapData;
  framework: string;
  enabled: ReadonlySet<string>;
  endpoints: readonly FlowEndpoint[];
  selected: string | null;
  onToggleFeature: (id: string, on: boolean) => void;
  onEndpoint: (id: string) => void;
}

/** The endpoints of the configuration, grouped by flow, and the features that make the configuration (folded, so the list stays short). */
export function Sidebar({ data, framework, enabled, endpoints, selected, onToggleFeature, onEndpoint }: SidebarProps) {
  const rows: React.ReactNode[] = [];
  let group: string | null = null;
  for (const endpoint of endpoints) {
    if (endpoint.group.id !== group) {
      group = endpoint.group.id;
      rows.push(
        <li key={`group-${group}`} className="group">
          {endpoint.group.label}
        </li>,
      );
    }
    rows.push(
      <li key={endpoint.id}>
        <button type="button" aria-current={endpoint.id === selected ? 'page' : undefined} onClick={() => onEndpoint(endpoint.id)}>
          <span className="endpoint-label">{endpoint.label}</span>
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
      <details className="features">
        <summary>
          機能 <span className="muted">{on} / {data.features.length} 有効</span>
        </summary>
        <div className="feature-list">
          {data.features.map((feature) => (
            <label key={feature.id} title={feature.summary}>
              <input type="checkbox" checked={enabled.has(feature.id)} onChange={(event) => onToggleFeature(feature.id, event.target.checked)} />
              <span>{feature.id}</span>
              <span className="muted">{feature.tier}</span>
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
