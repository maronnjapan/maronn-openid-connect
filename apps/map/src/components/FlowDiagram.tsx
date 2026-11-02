import { useMemo } from 'react';
import type { Diagram, DiagramNode } from '../lib/diagram';
import { BOX_H, layoutGraph, truncateColumns, type Active } from '../lib/graph';

export interface FlowDiagramProps {
  diagram: Diagram;
  active: Active;
  selected: string | null;
  label: string;
  onSelect: (node: DiagramNode) => void;
}

/**
 * The boxes of a diagram in a column, with the arrows of the checked cases
 * only. Three colors: grey for what the checked cases do not use, the accent
 * for what they use, red for the error step, a throw and the arrows of an
 * error.
 */
export function FlowDiagram({ diagram, active, selected, label, onSelect }: FlowDiagramProps) {
  const layout = useMemo(() => layoutGraph(diagram.nodes, diagram.edges, active.edges), [diagram, active]);
  const byId = useMemo(() => new Map(diagram.nodes.map((node) => [node.id, node])), [diagram]);
  return (
    <svg className="diagram" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="group" aria-label={label}>
      <defs>
        <marker id="arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="head on" />
        </marker>
        <marker id="arrow-error" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="head error" />
        </marker>
      </defs>
      {layout.arrows.map((arrow) => (
        <g key={arrow.index} className={`edge ${arrow.kind}`}>
          <path d={arrow.d} markerEnd={arrow.kind === 'error' ? 'url(#arrow-error)' : 'url(#arrow-on)'} />
          {arrow.label ? (
            <text className="edge-label" x={arrow.label.x} y={arrow.label.y}>
              {truncateColumns(arrow.label.text, 48)}
              <title>{arrow.label.text}</title>
            </text>
          ) : null}
        </g>
      ))}
      {layout.boxes.map((box) => {
        const node = byId.get(box.id) as DiagramNode;
        const on = active.nodes.has(node.id);
        const state = `${on ? 'on' : 'off'}${node.id === selected ? ' selected' : ''}`;
        const clickable = node.target !== undefined;
        const activate = () => {
          if (clickable) onSelect(node);
        };
        return (
          <g
            key={node.id}
            className={`box ${state} tone-${node.tone}${clickable ? ' clickable' : ''}`}
            tabIndex={clickable ? 0 : -1}
            role={clickable ? 'button' : undefined}
            aria-label={`${node.title}: ${node.subtitle}${on ? '' : '（選んだケースでは通らない）'}`}
            onClick={activate}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
              }
            }}
          >
            <title>{node.subtitle === '' ? node.title : `${node.title}\n${node.subtitle}`}</title>
            <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={node.tone === 'start' || node.tone === 'end' ? BOX_H / 2 : 6} />
            <text className="title" x={box.x + 12} y={box.y + 20}>
              {truncateColumns(node.title, 48)}
            </text>
            <text className="sub" x={box.x + 12} y={box.y + 38}>
              {truncateColumns(node.subtitle, 54)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
