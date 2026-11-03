import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Mark } from '../lib/changes';
import type { Diagram, DiagramNode } from '../lib/diagram';
import { BOX_H, BOX_W, EDGE_LABEL_COLUMNS, layoutGraph, textColumns, truncateColumns, type Active, type LayoutDirection } from '../lib/graph';

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
 * An automatically arranged diagram with direction, zoom and fit controls,
 * and the arrows of the checked cases only. Three colors: grey for what
 * the checked cases do not use, the accent
 * for what they use, red for the error step, a throw and the arrows of an
 * error. A box the pull request changed carries a badge in the grey scale
 * (変更, 追加, 中で変更...) at the right of its first line, so the colors keep
 * their meaning.
 */
export function FlowDiagram({ diagram, active, selected, label, marks, onSelect }: FlowDiagramProps) {
  const [direction, setDirection] = useState<LayoutDirection>('TB');
  const [zoom, setZoom] = useState<number | 'width' | 'all'>('width');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const marker = useId();
  // Placement depends on the graph, not on which cases are checked.
  const placed = useMemo(() => layoutGraph(diagram.nodes, diagram.edges, new Set(diagram.edges.map((_, index) => index)), direction), [diagram, direction]);
  const layout = useMemo(() => ({ ...placed, arrows: placed.arrows.filter((arrow) => active.edges.has(arrow.index)) }), [placed, active.edges]);
  const byId = useMemo(() => new Map(diagram.nodes.map((node) => [node.id, node])), [diagram]);
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    viewport.current?.scrollTo(0, 0);
  }, [diagram.key, direction]);
  const fitWidth = size.width === 0 ? 1 : Math.min(1, Math.max(1, size.width - 24) / layout.width);
  const fitAll = size.height === 0 ? fitWidth : Math.min(fitWidth, Math.max(1, size.height - 24) / layout.height);
  const scale = typeof zoom === 'number' ? zoom : zoom === 'all' ? fitAll : fitWidth;
  return (
    <div className="diagram-view">
      <div className="diagram-tools" role="group" aria-label="フローの表示設定">
        <div className="seg" role="group" aria-label="フローの向き">
          <button type="button" aria-pressed={direction === 'TB'} onClick={() => setDirection('TB')}>↓ 縦方向</button>
          <button type="button" aria-pressed={direction === 'LR'} onClick={() => setDirection('LR')}>→ 横方向</button>
        </div>
        <div className="diagram-zoom">
          <button type="button" aria-label="縮小" disabled={scale <= 0.1} onClick={() => setZoom(Math.max(0.1, scale / 1.25))}>−</button>
          <button type="button" aria-label="100%で表示" onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button>
          <button type="button" aria-label="拡大" disabled={scale >= 2} onClick={() => setZoom(Math.min(2, Math.max(0.1, scale * 1.25)))}>＋</button>
        </div>
        <button type="button" aria-pressed={zoom === 'width'} onClick={() => setZoom('width')}>幅に合わせる</button>
        <button type="button" aria-pressed={zoom === 'all'} onClick={() => setZoom('all')}>全体を表示</button>
      </div>
      <div className="diagram-viewport" ref={viewport} tabIndex={0} role="region" aria-label={`${label}の表示領域`}>
        <svg className="diagram" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width * scale} height={layout.height * scale} role="group" aria-label={label}>
          <defs>
            <marker id={`${marker}-on`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="head on" />
            </marker>
            <marker id={`${marker}-error`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="head error" />
            </marker>
          </defs>
          {layout.arrows.map((arrow) => (
            <g key={arrow.index} className={`edge ${arrow.kind}`}>
              <path d={arrow.d} markerEnd={`url(#${marker}-${arrow.kind === 'error' ? 'error' : 'on'})`} />
              {arrow.label ? (
                <g className="edge-caption">
                  <rect x={arrow.label.x - arrow.label.width / 2} y={arrow.label.y - arrow.label.height / 2} width={arrow.label.width} height={arrow.label.height} rx={4} />
                  <text className="edge-label" x={arrow.label.x} y={arrow.label.y} textAnchor="middle" dominantBaseline="central">
                    {truncateColumns(arrow.label.text, EDGE_LABEL_COLUMNS)}
                    <title>{arrow.label.text}</title>
                  </text>
                </g>
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
      </div>
    </div>
  );
}
