import { useMemo } from 'react';
import type { Mark } from '../lib/changes';
import type { Diagram, DiagramNode } from '../lib/diagram';
import { BOX_H, BOX_W, layoutGraph, textColumns, truncateColumns, type Active } from '../lib/graph';

export interface FlowDiagramProps {
  diagram: Diagram;
  active: Active;
  selected: string | null;
  label: string;
  /** The badges of the boxes the pull request changed, by the id of the box (a map of a pull request). */
  marks?: ReadonlyMap<string, Mark> | undefined;
  onSelect: (node: DiagramNode) => void;
}

/** The columns the title of a box takes: all of them, or what a badge at the right of the first line leaves. */
const TITLE_COLUMNS = 48;

/** The width of a badge (11px text, two columns a wide character). */
function badgeWidth(mark: Mark): number {
  return Math.ceil(textColumns(mark.label) * 5.6) + 14;
}

/**
 * The boxes of a diagram in a column, with the arrows of the checked cases
 * only. Three colors: grey for what the checked cases do not use, the accent
 * for what they use, red for the error step, a throw and the arrows of an
 * error. A box the pull request changed carries a badge in the grey scale
 * (変更, 追加, 中で変更...) at the right of its first line, so the colors keep
 * their meaning.
 */
export function FlowDiagram({ diagram, active, selected, label, marks, onSelect }: FlowDiagramProps) {
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
        const mark = marks?.get(node.id);
        const badge = mark === undefined ? 0 : badgeWidth(mark);
        const titleColumns = mark === undefined ? TITLE_COLUMNS : Math.min(TITLE_COLUMNS, Math.floor((BOX_W - 24 - badge - 8) / 7));
        const activate = () => {
          if (clickable) onSelect(node);
        };
        return (
          <g
            key={node.id}
            className={`box ${state} tone-${node.tone}${clickable ? ' clickable' : ''}`}
            tabIndex={clickable ? 0 : -1}
            role={clickable ? 'button' : undefined}
            aria-label={`${node.title}: ${node.subtitle}${mark === undefined ? '' : `（${mark.title}）`}${on ? '' : '（選んだケースでは通らない）'}`}
            onClick={activate}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activate();
              }
            }}
          >
            <title>{[node.title, node.subtitle, mark?.title ?? ''].filter((line) => line !== '').join('\n')}</title>
            <rect className="frame" x={box.x} y={box.y} width={box.width} height={box.height} rx={node.tone === 'start' || node.tone === 'end' ? BOX_H / 2 : 6} />
            <text className="title" x={box.x + 12} y={box.y + 20}>
              {truncateColumns(node.title, titleColumns)}
            </text>
            <text className="sub" x={box.x + 12} y={box.y + 38}>
              {truncateColumns(node.subtitle, 54)}
            </text>
            {mark !== undefined ? (
              <g className={`box-badge badge-${mark.kind}`}>
                <rect x={box.x + box.width - badge - 8} y={box.y + 6} width={badge} height={17} rx={8.5} />
                <text x={box.x + box.width - 8 - badge / 2} y={box.y + 18.5} textAnchor="middle">
                  {mark.label}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
