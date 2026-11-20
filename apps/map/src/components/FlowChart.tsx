import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { openingCamera, STAGE_SCALE, type Rect, type Size } from '../lib/camera';
import type { Mark } from '../lib/changes';
import { boxActions, boxOf, spokenLabel, type CardAction, type Diagram, type DiagramNode } from '../lib/diagram';
import { GROUP_HEADER, layoutChart, NODE_INSET, rhombusPoints, wayAt, type Chart, type ChartNode, type ChartWay, type WayEdgeState, type WayNodeState } from '../lib/flowchart';
import { EDGE_LABEL_COLUMNS, textColumns, truncateColumns, type LayoutBox, type LayoutDirection } from '../lib/graph';
import type { SceneTone } from '../lib/playback';
import type { CardContent } from './DiagramCard';
import { DiagramViewport } from './DiagramViewport';
import { useDiagramCards } from './useDiagramCards';

/** Where a playback is on the chart of its frame (see FlowChart). */
export interface ChartPlay {
  /** The way of the playback through this frame (chartWay). */
  way: ChartWay;
  /** The scene shown, by its index in the playback. */
  at: number;
  /** The node (or the region) of the chart the scene is at. */
  shape: string | undefined;
  /** The node the token comes from, when the playback just moved one scene forward: the scene before in this frame, or the start. */
  from: string | undefined;
  tone: SceneTone;
  /** How long the token takes at most to travel to the scene's node, and on to its exit, in milliseconds. */
  duration: number;
}

export interface FlowChartProps {
  chart: Chart;
  /** The diagram the chart draws: what the card of a node says comes from its box. */
  diagram: Diagram;
  play: ChartPlay | undefined;
  /** The node of the tree the chart opens on, and brings into view at each scene (with a key that changes each time). */
  openOn: string | null;
  reveal: { node: string; key: number } | null;
  label: string;
  /** The badges of the boxes and regions the pull request changed, by their id. */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** A node on the way is clicked or tapped, or Enter or Space is pressed on it: go to the scene that reaches it. */
  onScene: (index: number) => void;
  /** The card's 中の流れを見る: look inside a function the box calls (`box.opens` names it). */
  onOpen: (box: DiagramNode, keyboard: boolean) => void;
  /** The card's その場で開く or その場で畳む. */
  onToggleStep: (step: string, keyboard: boolean) => void;
}

/** Whether the reader asked for less motion: the token then does not travel, the links do not flow, and the states change at once. */
function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The straight line a token takes between two nodes no arrow joins: from the middle of the side of one that faces the other to the middle of the facing side of the other. */
function facing(from: Rect, to: Rect): string {
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2;
  const toY = to.y + to.height / 2;
  if (Math.abs(toY - fromY) >= Math.abs(toX - fromX) * 0.25) {
    const down = toY >= fromY;
    return `M${fromX},${down ? from.y + from.height : from.y} L${toX},${down ? to.y : to.y + to.height}`;
  }
  const right = toX >= fromX;
  return `M${right ? from.x + from.width : from.x},${fromY} L${right ? to.x : to.x + to.width},${toY}`;
}

/** The width of a badge (11px text, two columns a wide character). */
function badgeWidth(mark: Mark): number {
  return Math.ceil(textColumns(mark.label) * 5.6) + 14;
}

/**
 * Squeeze the lines of text the font draws wider than their room (data-room,
 * in pixels) so they stay inside their node: the widths that cut them are an
 * estimate. A squeezed line keeps its words and its ellipsis.
 */
function fitLines(svg: SVGSVGElement): void {
  for (const line of svg.querySelectorAll<SVGTextContentElement>('[data-room]')) {
    line.removeAttribute('textLength');
    line.removeAttribute('lengthAdjust');
    const room = Number(line.dataset.room);
    if (line.getComputedTextLength() <= room) continue;
    line.setAttribute('textLength', String(room));
    line.setAttribute('lengthAdjust', 'spacingAndGlyphs');
  }
}

/** The pause of the token on the node of a scene before it goes on to the scene's exit, in milliseconds. */
const EXIT_PAUSE = 220;

/** The words a node's state is read by. */
const STATE_WORDS: Record<WayNodeState, string> = { visited: 'このリクエストが通った', current: 'いまの場所', exit: 'この場面で終わる所', ahead: 'このリクエストがこの先で通る' };

/**
 * The stage of the flow view: the chart of a frame (lib/flowchart.ts) drawn
 * as a Mermaid flowchart reads, and a request played along it. Every node and
 * every arrow is drawn; the colors keep the page's three: grey for what the
 * request does not take, the accent for its way, red for a failure and the
 * arrows of an error.
 *
 * - The arrows the request has taken flow (dashes moving along them, as
 *   Mermaid's animated links do), the one it travels now is thicker, and those
 *   of the way still ahead are dashed and still. The nodes it went through
 *   are lightly filled, the one it is at is filled and pulses, those ahead on
 *   its way are outlined.
 * - A token travels the arrow into the scene's node, and on along the
 *   labeled arrow to the exit where the scene ends the frame, which lights up
 *   (the accent for an end, red for a failure).
 * - With less motion asked for, nothing flows or travels: the states change
 *   at once.
 *
 * Pressing a node on the way goes to its scene. The card of a node (on
 * hover, focus or tap, see useDiagramCards) says what its box says in the
 * side pane's diagram, and offers the same buttons.
 */
export function FlowChart({ chart, diagram, play, openOn, reveal, label, marks, onScene, onOpen, onToggleStep }: FlowChartProps) {
  const [direction, setDirection] = useState<LayoutDirection>('TB');
  const marker = useId();
  const svg = useRef<SVGSVGElement>(null);
  const firstLeg = useRef<SVGPathElement>(null);
  const secondLeg = useRef<SVGPathElement>(null);
  const token = useRef<SVGGElement>(null);
  const placed = useMemo(() => layoutChart(chart, direction), [chart, direction]);
  const nodeById = useMemo(() => new Map(chart.nodes.map((node) => [node.id, node])), [chart]);
  const boxById = useMemo(() => new Map(diagram.nodes.map((box) => [box.id, box])), [diagram]);
  const groupById = useMemo(() => new Map(diagram.groups.map((group) => [group.id, group])), [diagram]);
  const titleOf = useMemo(() => new Map(chart.groups.map((group) => [group.id, group.title])), [chart]);
  const rects = useMemo(() => new Map<string, Rect>([...placed.boxes.map((box) => [box.id, box] as const), ...placed.groups.map((group) => [group.id, group] as const)]), [placed]);
  const arrowOf = useMemo(() => new Map(placed.arrows.map((arrow) => [arrow.index, arrow])), [placed]);
  const states = useMemo(() => (play === undefined ? { nodes: new Map<string, WayNodeState>(), edges: new Map<number, WayEdgeState>() } : wayAt(play.way, play.at)), [play?.way, play?.at]);
  const exit = play === undefined ? undefined : play.way.exits.get(play.at);
  const reduced = reducedMotion();

  // The legs the token travels: the arrow into the scene's node (a straight line where no arrow joins the two), then the arrow to its exit.
  const legs = useMemo(() => {
    if (play === undefined || play.shape === undefined) return { first: undefined, second: undefined };
    const shape = play.shape;
    let first: string | undefined;
    if (play.from !== undefined && play.from !== shape && !groupById.has(shape)) {
      const index = chart.edges.findIndex((edge) => edge.from === play.from && edge.to === shape && edge.exit !== true);
      const arrow = index === -1 ? undefined : arrowOf.get(index);
      const from = rects.get(play.from);
      const to = rects.get(shape);
      first = arrow?.d ?? (from === undefined || to === undefined ? undefined : facing(from, to));
    }
    const out = exit === undefined ? -1 : chart.edges.findIndex((edge) => edge.from === shape && edge.to === exit);
    return { first, second: out === -1 ? undefined : arrowOf.get(out)?.d };
  }, [play?.shape, play?.from, exit, chart, arrowOf, rects, groupById]);

  // Move the token along its legs; the node it reaches and the exit after it light up when it arrives (styles.css waits --arrive and --exit-arrive).
  const playKey = play === undefined ? undefined : `${play.at}|${play.from ?? ''}`;
  const playDuration = play?.duration ?? 0;
  useLayoutEffect(() => {
    const element = svg.current;
    const dot = token.current;
    const one = firstLeg.current;
    const two = secondLeg.current;
    if (element === null || dot === null || one === null || two === null) return undefined;
    const firstLength = legs.first === undefined ? 0 : one.getTotalLength();
    const secondLength = legs.second === undefined ? 0 : two.getTotalLength();
    if (reducedMotion() || (firstLength === 0 && secondLength === 0)) {
      dot.style.opacity = '0';
      element.style.setProperty('--arrive', '0ms');
      element.style.setProperty('--exit-arrive', '0ms');
      return undefined;
    }
    // A short hop is quick, a long arrow takes no more than its share of the scene.
    const spanOf = (pixels: number, share: number) => (pixels === 0 ? 0 : Math.max(180, Math.min(playDuration * share, 160 + pixels * 2.4)));
    const firstSpan = spanOf(firstLength, secondLength === 0 ? 1 : 0.5);
    const pause = firstLength === 0 || secondLength === 0 ? 0 : EXIT_PAUSE;
    const secondSpan = spanOf(secondLength, firstLength === 0 ? 1 : 0.4);
    element.style.setProperty('--arrive', `${Math.round(firstSpan)}ms`);
    element.style.setProperty('--exit-arrive', `${Math.round(firstSpan + pause + secondSpan)}ms`);
    const started = performance.now();
    let frame = 0;
    dot.style.opacity = '1';
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const tick = (now: number) => {
      // A frame's time can come before the time the travel started: it counts as its start.
      const elapsed = Math.max(0, now - started);
      let point: DOMPoint;
      if (firstLength > 0 && elapsed < firstSpan) point = one.getPointAtLength(firstLength * ease(elapsed / firstSpan));
      else if (secondLength === 0) point = one.getPointAtLength(firstLength);
      else if (elapsed < firstSpan + pause) point = firstLength === 0 ? two.getPointAtLength(0) : one.getPointAtLength(firstLength);
      else point = two.getPointAtLength(secondLength * ease(Math.min(1, (elapsed - firstSpan - pause) / secondSpan)));
      dot.setAttribute('transform', `translate(${point.x},${point.y})`);
      if (elapsed < firstSpan + pause + secondSpan) frame = requestAnimationFrame(tick);
      else dot.style.opacity = '0';
    };
    tick(started);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playKey, legs, playDuration]);

  // Fit the lines once they are drawn, and again once the page's font has loaded.
  useLayoutEffect(() => {
    const element = svg.current;
    if (element === null) return undefined;
    fitLines(element);
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) fitLines(element);
    });
    return () => {
      live = false;
    };
  }, [placed, marks]);

  /** The scene a press on a node goes to: the first that reaches it (the start: the first scene of the frame; an exit: the scene that ends there). */
  const sceneOf = (id: string): number | undefined => play?.way.nodes.get(id)?.[0];
  /** What the card of a node offers: the buttons of its box, or for an exit those of its row. */
  const actionsOf = (id: string): CardAction[] => {
    const node = nodeById.get(id);
    const shape = boxById.get(node?.of ?? id) ?? groupById.get(node?.of ?? id);
    if (shape === undefined) return [];
    if (node?.row === undefined) return boxActions(shape);
    return boxActions(shape).flatMap((action) => (action.row === node.row ? [action.kind === 'open' ? { kind: 'open' as const, node: action.node, fn: action.fn, name: action.name } : { kind: 'toggle' as const, step: action.step, open: action.open }] : []));
  };
  /** Do what a button of a card says (see FlowDiagram): open or fold a step, pinned to the step's node, or look inside a call. */
  const act = (id: string, action: CardAction, keyboard: boolean, at: { x: number; y: number }) => {
    if (action.kind === 'toggle') {
      onToggleStep(action.step, keyboard);
      cards.pin(`n:${action.step}`, at);
      return;
    }
    const node = nodeById.get(id);
    const box = boxById.get(node?.of ?? id);
    cards.close();
    if (box !== undefined) onOpen({ ...box, opens: { node: action.node, fn: action.fn } }, keyboard);
  };
  /** What the card of a node or of the title of a region says: what its box says in full, and whether this request takes it. */
  const contentOf = (id: string): CardContent | undefined => {
    const mark = marks?.get(id);
    const node = nodeById.get(id);
    const off = play === undefined || !play.way.nodes.has(id);
    if (node !== undefined && node.row !== undefined) {
      // How the box leaves for it (the label of its arrow) and what it returns or throws there.
      const way = chart.edges.find((edge) => edge.to === id)?.label;
      const said = node.detailFull ?? node.title;
      return {
        name: node.title,
        code: node.exitCode ?? '',
        text: way === undefined ? said : `${way} → ${said}`,
        tag: node.shape === 'failure' ? '失敗' : '終わり',
        rows: [],
        off,
        actions: actionsOf(id),
      };
    }
    const box = boxById.get(id);
    if (box !== undefined) {
      const tag = box.node === undefined ? undefined : box.tone === 'end' ? '終わり' : box.tone === 'error' ? '失敗' : undefined;
      const facts = node?.detailFull !== undefined && node.detailCode !== true ? node.detailFull : undefined;
      const text = [box.text, facts].filter((part): part is string => part !== undefined && part !== '').join(' · ');
      return {
        name: node?.title ?? box.title,
        code: box.code,
        ...(text === '' ? {} : { text }),
        ...(tag === undefined ? {} : { tag }),
        rows: box.rows.map((row, index) => ({ full: row.full, tone: row.tone, on: play?.way.nodes.has(`x:${id}|${index}`) === true })),
        ...(mark === undefined ? {} : { mark }),
        off: box.node !== undefined && off,
        actions: actionsOf(id),
      };
    }
    const group = groupById.get(id);
    if (group === undefined) return undefined;
    return {
      name: titleOf.get(id) ?? group.title,
      code: group.code,
      text: titleOf.get(id) ?? group.title,
      rows: group.rows.length > 0 ? group.rows.map((row, index) => ({ full: row.full, tone: row.tone, on: play?.way.nodes.has(`x:${id}|${index}`) === true })) : [{ full: group.outcome, tone: 'error', on: !off }],
      ...(mark === undefined ? {} : { mark }),
      off,
      actions: boxActions(group),
    };
  };
  const cards = useDiagramCards({ frame: chart.key, svg, exists: (id) => nodeById.has(id) || groupById.has(id), contentOf, onAction: act });

  /**
   * What the chart shows of a node of the tree: the node of the chart that
   * shows it, with the exit the scene ends at beside it; for a region (a
   * catch that takes a failure), the exit alone, where the request goes.
   */
  const viewOf = (node: string | null): Rect | undefined => {
    const shape = node === null ? undefined : boxOf(diagram, node);
    const box = shape === undefined ? undefined : rects.get(shape.id);
    const end = exit === undefined ? undefined : rects.get(exit);
    if (end !== undefined && shape !== undefined && groupById.has(shape.id)) return end;
    if (box === undefined || end === undefined) return box;
    const x = Math.min(box.x, end.x);
    const y = Math.min(box.y, end.y);
    return { x, y, width: Math.max(box.x + box.width, end.x + end.width) - x, height: Math.max(box.y + box.height, end.y + end.height) - y };
  };
  const anchor = viewOf(openOn) ?? rects.get('start');
  const revealRect = reveal === null ? undefined : viewOf(reveal.node);

  /** The classes of a node or a region by where it stands on the way, and whether the token is on its way to it. */
  const stateClass = (id: string): string => {
    const state = states.nodes.get(id);
    if (state === undefined) return ' off';
    const arriving = (state === 'current' && legs.first !== undefined) || (state === 'exit' && (legs.first !== undefined || legs.second !== undefined));
    return ` on ${state}${arriving && !reduced ? ' arriving' : ''}${state === 'current' && play !== undefined ? ` tone-${play.tone}` : ''}`;
  };
  /** The words a node is read by: its words, its detail, where it stands on the way, and what pressing it does. */
  const spoken = (node: ChartNode): string => {
    const state = states.nodes.get(node.id);
    return spokenLabel(
      [
        node.title,
        node.detailFull ?? '',
        marks?.get(node.id)?.title ?? '',
        state === undefined ? 'このリクエストは通らない' : STATE_WORDS[state],
        state !== undefined ? '押すとその場面へ移る' : '',
        actionsOf(node.id).length > 0 ? 'Tab でカードのボタンへ' : '',
      ].filter((line) => line !== ''),
    );
  };

  /** The shape of a node: a stadium, a rounded rectangle, a rhombus, a red rounded node; and its lines. */
  const nodeShape = (box: LayoutBox): ReactNode => {
    const node = nodeById.get(box.id);
    if (node === undefined) return null;
    const scene = sceneOf(node.id);
    const mark = marks?.get(node.id);
    const middle = box.y + box.height / 2;
    const centerX = box.x + box.width / 2;
    const round = node.shape === 'start' || node.shape === 'end' ? box.height / 2 : node.shape === 'failure' ? 10 : 8;
    const centered = node.shape !== 'process';
    const textX = centered ? centerX : box.x + NODE_INSET;
    const anchorText = centered ? 'middle' : 'start';
    const room = node.shape === 'decision' ? undefined : box.width - (centered ? 2 * 20 : 2 * NODE_INSET);
    const titleLines = node.lines;
    // The lines stand around the middle: the title (one line, two for a rhombus), then the detail.
    const rows = titleLines.length + (node.detail === undefined ? 0 : 1);
    const lineHeight = node.shape === 'decision' ? 16 : 17;
    const firstY = middle - ((rows - 1) * lineHeight) / 2;
    return (
      <g
        key={node.id}
        className={`chart-node shape-${node.shape}${stateClass(node.id)}${scene !== undefined ? ' clickable' : ''}`}
        data-box={node.id}
        tabIndex={0}
        role="button"
        aria-label={spoken(node)}
        aria-describedby={cards.shown === node.id ? cards.cardId : undefined}
        {...cards.handlersOf(node.id, scene === undefined ? undefined : () => onScene(scene))}
      >
        {node.shape === 'decision' ? (
          <>
            <polygon className="pulse" points={rhombusPoints(box)} />
            <polygon className="frame" points={rhombusPoints(box)} />
          </>
        ) : (
          <>
            <rect className="pulse" x={box.x} y={box.y} width={box.width} height={box.height} rx={round} />
            <rect className="frame" x={box.x} y={box.y} width={box.width} height={box.height} rx={round} />
          </>
        )}
        {titleLines.map((line, index) => (
          <text key={index} className={`title${node.code ? ' code' : ''}`} x={textX} y={firstY + index * lineHeight} textAnchor={anchorText} dominantBaseline="central" {...(room === undefined ? {} : { 'data-room': room })}>
            {line}
          </text>
        ))}
        {node.detail !== undefined ? (
          <text className={`detail${node.detailCode === true ? ' code' : ''}`} x={textX} y={firstY + titleLines.length * lineHeight} textAnchor={anchorText} dominantBaseline="central" {...(room === undefined ? {} : { 'data-room': room })}>
            {node.detail}
          </text>
        ) : null}
        {mark !== undefined ? (
          <g className={`box-badge badge-${mark.kind}`}>
            <rect x={box.x + box.width - badgeWidth(mark) - 10} y={box.y - 8.5} width={badgeWidth(mark)} height={17} rx={8.5} />
            <text x={box.x + box.width - 10 - badgeWidth(mark) / 2} y={box.y} textAnchor="middle" dominantBaseline="central">
              {mark.label}
            </text>
          </g>
        ) : null}
      </g>
    );
  };

  const style = { '--arrive': '0ms', '--exit-arrive': '0ms' } as CSSProperties;
  return (
    <DiagramViewport
      key={`${chart.key}:${direction}`}
      width={placed.width}
      height={placed.height}
      opening={(view: Size) => openingCamera(view, placed, anchor, STAGE_SCALE)}
      reveal={reveal === null ? null : { box: revealRect, key: reveal.key }}
      overlay={cards.overlay}
      onMove={cards.close}
      onView={cards.follow}
      controls={
        <div className="seg" role="group" aria-label="フローの向き">
          <button type="button" aria-pressed={direction === 'TB'} aria-label="縦方向" title="縦方向" onClick={() => setDirection('TB')}>↓ 縦</button>
          <button type="button" aria-pressed={direction === 'LR'} aria-label="横方向" title="横方向" onClick={() => setDirection('LR')}>→ 横</button>
        </div>
      }
    >
      <svg ref={svg} className={`diagram chart${reduced ? ' still' : ''}`} style={style} viewBox={`0 0 ${placed.width} ${placed.height}`} width={placed.width} height={placed.height} role="group" aria-label={label}>
        <defs>
          {(['off', 'on', 'error'] as const).map((tone) => (
            <marker key={tone} id={`${marker}-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className={`head ${tone}`} />
            </marker>
          ))}
        </defs>
        {placed.groups.map((rect) => {
          const group = groupById.get(rect.id);
          const title = titleOf.get(rect.id) ?? '';
          const mark = marks?.get(rect.id);
          return (
            <g key={rect.id} className={`chart-group${stateClass(rect.id)}`}>
              <rect className="area" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={6} />
              {group !== undefined ? (
                <g
                  className="group-title"
                  data-box={rect.id}
                  tabIndex={0}
                  role="button"
                  aria-label={spokenLabel([`${title}（try）`, group.rows[0]?.full ?? group.outcome, mark?.title ?? ''].filter((line) => line !== ''))}
                  aria-describedby={cards.shown === rect.id ? cards.cardId : undefined}
                  {...cards.handlersOf(rect.id, sceneOf(rect.id) === undefined ? undefined : () => onScene(sceneOf(rect.id) as number))}
                >
                  <rect className="hit" x={rect.x} y={rect.y} width={rect.width} height={GROUP_HEADER - 4} rx={6} />
                  <text className="group-text" x={rect.x + 12} y={rect.y + GROUP_HEADER / 2 - 1} dominantBaseline="central" data-room={rect.width - 24 - (mark === undefined ? 0 : badgeWidth(mark) + 8)}>
                    {title}
                  </text>
                  {mark !== undefined ? (
                    <g className={`box-badge badge-${mark.kind}`}>
                      <rect x={rect.x + rect.width - badgeWidth(mark) - 10} y={rect.y + GROUP_HEADER / 2 - 9.5} width={badgeWidth(mark)} height={17} rx={8.5} />
                      <text x={rect.x + rect.width - 10 - badgeWidth(mark) / 2} y={rect.y + GROUP_HEADER / 2 - 1} textAnchor="middle" dominantBaseline="central">
                        {mark.label}
                      </text>
                    </g>
                  ) : null}
                </g>
              ) : null}
            </g>
          );
        })}
        {placed.arrows.map((arrow) => {
          const state = states.edges.get(arrow.index);
          const head = arrow.kind === 'error' ? 'error' : state === undefined ? 'off' : 'on';
          return (
            <g key={arrow.index} className={`link kind-${arrow.kind} ${state ?? 'off'}`}>
              <path d={arrow.d} markerEnd={`url(#${marker}-${head})`} />
            </g>
          );
        })}
        {/* The labels stand above every arrow, in small boxes, so no arrow crosses one. */}
        {placed.arrows.map((arrow) =>
          arrow.label === undefined ? null : (
            <g key={arrow.index} className={`link-label kind-${arrow.kind} ${states.edges.get(arrow.index) ?? 'off'}`}>
              <rect x={arrow.label.x - arrow.label.width / 2} y={arrow.label.y - arrow.label.height / 2 + 2} width={arrow.label.width} height={arrow.label.height - 4} rx={4} />
              <text x={arrow.label.x} y={arrow.label.y} textAnchor="middle" dominantBaseline="central" data-room={arrow.label.width - 6}>
                {truncateColumns(arrow.label.text, EDGE_LABEL_COLUMNS)}
                <title>{arrow.label.text}</title>
              </text>
            </g>
          ),
        )}
        {placed.boxes.map(nodeShape)}
        {play !== undefined ? (
          <g className={`travel play-${play.tone}`} aria-hidden="true">
            <path ref={firstLeg} className="leg" d={legs.first ?? 'M0,0'} />
            <path ref={secondLeg} className="leg" d={legs.second ?? 'M0,0'} />
            <g ref={token} className={`token${exit !== undefined && nodeById.get(exit)?.shape === 'failure' ? ' to-failure' : ''}`}>
              <circle className="token-glow" r={11} />
              <circle className="token-dot" r={5.5} />
            </g>
          </g>
        ) : null}
      </svg>
    </DiagramViewport>
  );
}
