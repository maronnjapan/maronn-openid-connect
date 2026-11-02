import type { FlowEndpoint, MapData } from '../types';
import { commandLine } from '../lib/model';

export interface ConfigPanelProps {
  data: MapData;
  framework: string;
  enabled: ReadonlySet<string>;
  endpoints: readonly FlowEndpoint[];
  selected: string | null;
  onFramework: (framework: string) => void;
  onToggleFeature: (id: string, on: boolean) => void;
  onEndpoint: (id: string) => void;
}

/** The configuration of the provider: framework, features (and the generate command they are), endpoints. */
export function ConfigPanel({ data, framework, enabled, endpoints, selected, onFramework, onToggleFeature, onEndpoint }: ConfigPanelProps) {
  let group: string | null = null;
  const rows: React.ReactNode[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.group.id !== group) {
      group = endpoint.group.id;
      rows.push(
        <li key={`group-${group}`} className="grp">
          {endpoint.group.label}
        </li>,
      );
    }
    rows.push(
      <li key={endpoint.id}>
        <button type="button" aria-current={endpoint.id === selected} onClick={() => onEndpoint(endpoint.id)}>
          <span>
            <strong>{endpoint.label}</strong>
            <br />
            <span className="route mono">
              {endpoint.methods.join('|')} {endpoint.path}
            </span>
          </span>
          <span className="route">{endpoint.steps.length}</span>
        </button>
      </li>,
    );
  }
  return (
    <section className="panel nav" aria-label="Configuration">
      <div className="group">
        <h2>Framework</h2>
        <div className="body">
          <div className="seg">
            {data.frameworks.map((name) => (
              <button key={name} type="button" aria-pressed={name === framework} onClick={() => onFramework(name)}>
                {name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="group">
        <h2>Features</h2>
        <div className="body">
          <div className="features">
            {data.features.map((feature) => (
              <label key={feature.id} title={feature.summary}>
                <input type="checkbox" id={`feature-${feature.id}`} checked={enabled.has(feature.id)} onChange={(event) => onToggleFeature(feature.id, event.target.checked)} />
                <span>{feature.id}</span>
                <span className="tier">{feature.tier}</span>
              </label>
            ))}
          </div>
          <pre className="cmd mono">{commandLine(framework, data.features, enabled)}</pre>
        </div>
      </div>
      <div className="group">
        <h2>Endpoints</h2>
        <div className="body">
          <ul className="endpoints">{rows}</ul>
        </div>
      </div>
    </section>
  );
}
