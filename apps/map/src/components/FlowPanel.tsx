import type { FlowEndpoint, MapData } from '../types';
import { KINDS, featureOf, layoutFlow, truncate } from '../lib/model';

export interface FlowPanelProps {
  endpoint: FlowEndpoint | undefined;
  data: MapData;
  selected: string | null;
  showErrors: boolean;
  onToggleErrors: (value: boolean) => void;
  onSelect: (step: string) => void;
}

/** The steps of an endpoint as the boxes of `maronn-oidc graph --detail steps`, with the arrows of its pipeline. */
export function FlowPanel({ endpoint, data, selected, showErrors, onToggleErrors, onSelect }: FlowPanelProps) {
  if (endpoint === undefined) {
    return (
      <section className="panel flow" aria-label="Steps">
        <h2>Steps</h2>
        <div className="body">
          <div className="empty">Pick an endpoint on the left.</div>
        </div>
      </section>
    );
  }
  const layout = layoutFlow(endpoint, showErrors);
  const used = new Set(endpoint.steps.map((step) => step.kind));
  return (
    <section className="panel flow" aria-label="Steps">
      <h2>
        {endpoint.methods.join('|')} {endpoint.path} · {endpoint.steps.length} steps{endpoint.rearrangeable ? '' : ' (a screen: fixed order)'}
      </h2>
      <div className="toolbar">
        <label>
          <input type="checkbox" id="show-errors" checked={showErrors} onChange={(event) => onToggleErrors(event.target.checked)} /> show the arrows into the error step
        </label>
        {endpoint.module ? <span>module: {endpoint.module}</span> : null}
      </div>
      <div className="body">
        <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="img" aria-label={`The steps of ${endpoint.path}`}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="arrow" />
            </marker>
          </defs>
          {layout.arrows.map((arrow, index) => (
            <g key={index}>
              <path className={`edge ${arrow.edge.kind}`} d={arrow.d} markerEnd="url(#arrow)" />
              {arrow.label ? (
                <text className="edge-label" x={arrow.label.x} y={arrow.label.y}>
                  {arrow.label.text}
                </text>
              ) : null}
            </g>
          ))}
          {layout.boxes.map((box) => {
            const kind = (KINDS as readonly string[]).includes(box.step.kind) ? box.step.kind : 'other';
            const color = `var(--k-${kind})`;
            const feature = box.step.feature ? `  (${featureOf(data.features, box.step.feature)?.id ?? box.step.feature})` : '';
            return (
              <g
                key={box.step.id}
                className={`box${box.step.id === selected ? ' selected' : ''}`}
                tabIndex={0}
                role="button"
                aria-label={`${box.step.id}: ${box.step.label}`}
                onClick={() => onSelect(box.step.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(box.step.id);
                  }
                }}
              >
                <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={6} stroke={color} fill={`color-mix(in srgb, ${color} 14%, var(--surface))`} />
                <text x={box.x + 10} y={box.y + 18}>
                  {truncate(`${box.step.label}${feature}`, 52)}
                </text>
                <text className="fn" x={box.x + 10} y={box.y + 35}>
                  {truncate(`[${box.step.id}] ${box.step.function}()`, 50)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="legend">
        {KINDS.filter((kind) => used.has(kind)).map((kind) => (
          <span key={kind} style={{ ['--k' as string]: `var(--k-${kind})` }}>
            {kind}
          </span>
        ))}
      </div>
    </section>
  );
}
