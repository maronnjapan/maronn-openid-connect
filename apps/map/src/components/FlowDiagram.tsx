import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { openingCamera, type Size } from '../lib/camera';
import type { Mark } from '../lib/changes';
import { boxAction, boxHeight, boxOf, spokenLabel, type BoxAction, type Diagram, type DiagramNode, type DiagramRow } from '../lib/diagram';
import { BOX_HEIGHT, compactArguments, EDGE_LABEL_COLUMNS, layoutGraph, textColumns, truncateColumns, wrapColumns, type LayoutBox, type LayoutDirection } from '../lib/graph';
import { DiagramViewport } from './DiagramViewport';

/** The boxes, arrows and rows (`<box id>|<index>`) the chosen way runs through (see activeOf). */
export interface Active {
  nodes: Set<string>;
  edges: Set<number>;
  rows: Set<string>;
}

export interface FlowDiagramProps {
  diagram: Diagram;
  active: Active;
  /** The node selected in this frame, by its id in the tree: the box that shows it is highlighted, and the diagram opens on it. */
  selected: string | null;
  /** The node whose box to bring into view at the same scale, and a key that changes each time it should be (a selection, a step opened or folded). */
  reveal?: { node: string; key: number } | null | undefined;
  /** What to give the keyboard focus once it is drawn: the box that shows a node, or the diagram itself for null (the element the reader activated went away). onFocused says it has it. */
  focus?: { node: string | null } | null | undefined;
  label: string;
  /** The badges of the boxes the pull request changed, by the id of the box (a map of a pull request). */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** Click a box, or press Enter or Space on it (keyboard): what it does follows boxAction (open the frame of its call, open or fold its step, select its row of the outline). */
  onSelect: (box: DiagramNode, keyboard: boolean) => void;
  /** Open or fold a step in place, from a row that names it, clicked or pressed from the keyboard. */
  onToggleStep: (step: string, keyboard: boolean) => void;
  /** The focus asked for (see focus) is given. */
  onFocused?: () => void;
}

/** The pixels a column of text takes (a wide character takes two): titles are 12.5px, subtitles 11.5px, rows 12px. */
const TITLE_COLUMN = 7;
const SUBTITLE_COLUMN = 6.2;
const ROW_COLUMN = 6.7;
/** The room between the edges of a box and its text. */
const INSET = 12;
/** The height of a line of the title, of the subtitle and of a row, and the room above and below them (boxHeight adds them up the same way). */
const TITLE_LINE = 17;
const SUBTITLE_LINE = 15;
const ROW_LINE = 16;
const PADDING = 8;

/** The width of a badge (11px text, two columns a wide character). */
function badgeWidth(mark: Mark): number {
  return Math.ceil(textColumns(mark.label) * 5.6) + 14;
}

/** The room a badge takes from the first line of the title: the badge and the gap before it. */
function badgeRoom(mark: Mark | undefined): number {
  return mark === undefined ? 0 : badgeWidth(mark) + 8;
}

/** The lines of the title of a box at a width: at most two, as boxHeight counts them; the start keeps one. */
function titleLines(node: DiagramNode, width: number, mark: Mark | undefined): string[] {
  const columns = Math.floor((width - 2 * INSET - badgeRoom(mark)) / TITLE_COLUMN);
  return node.tone === 'start' ? [truncateColumns(node.title, columns)] : wrapColumns(node.title, columns, 2);
}

/**
 * A row as it fits a number of columns: whole when it fits, else with the
 * arguments of its calls left out, else, for a guard that calls something
 * before it ends (`→ <calls>、<exit>`), the way it ends alone (`→ throw x(…)`),
 * cut at the end when even that is too long. The tooltip keeps the full row.
 */
function rowLine(text: string, columns: number): string {
  if (textColumns(text) <= columns) return text;
  const compact = compactArguments(text);
  if (textColumns(compact) <= columns) return compact;
  const exit = Math.max(compact.lastIndexOf('、return'), compact.lastIndexOf('、throw'));
  return truncateColumns(compact.startsWith('→ ') && exit > 0 ? `→ ${compact.slice(exit + 1)}` : compact, columns);
}

/** What clicking a box does, in words, for its tooltip and its label. */
function actionWords(node: DiagramNode, action: BoxAction): string {
  switch (action) {
    case 'open':
      return node.opens === undefined ? '押すと中を開く' : `押すと ${node.opens.fn.slice(node.opens.fn.indexOf('#') + 1)}() の中を開く`;
    case 'toggle':
      return node.step?.open === true ? '押すとその場で畳む' : '押すとその場で開く';
    case 'select':
      return '押すとアウトラインの行を選ぶ';
    case 'none':
      return '';
  }
}

/** The lines that describe a box, for its tooltip and its label: its code, its words, every row in full, its badge, whether the chosen way runs it, and what clicking it does. */
function boxWords(node: DiagramNode, mark: Mark | undefined, on: boolean, action: BoxAction): string[] {
  const name = node.title.replace(/^[▸▾] /, '');
  const lines = [node.code, node.code.includes(name) ? '' : name, node.subtitle, ...node.rows.map((row) => row.full), mark?.title ?? '', on ? '' : '選んだ道筋では通らない', actionWords(node, action)];
  return [...new Set(lines.filter((line) => line !== ''))];
}

/**
 * Squeeze the lines of text the font draws wider than their room (data-room,
 * in pixels) so they stay inside their box: the columns that cut them are an
 * estimate, and a run of capitals is wider. A squeezed line keeps its words
 * and its ellipsis.
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

/** Run an action from the keyboard as a button does: Enter and Space. */
function onActivateKey(activate: () => void) {
  return (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  };
}

/**
 * An automatically arranged diagram of one frame with direction, zoom and
 * fit controls, and the arrows of the chosen way only. Three colors: grey
 * for what the chosen way does not run, the accent for what it runs, red for
 * a throw, a row that ends in a throw or a catch, and the arrows of an error.
 * A box the pull request changed carries a badge in the grey scale (変更,
 * 追加, 下で変更...) at the right of its first line, so the colors keep their
 * meaning. Each box is as tall as its title (at most two lines), its subtitle
 * and its rows; a row that names a step opens it in place.
 */
export function FlowDiagram({ diagram, active, selected, reveal, focus, label, marks, onSelect, onToggleStep, onFocused }: FlowDiagramProps) {
  const [direction, setDirection] = useState<LayoutDirection>('TB');
  const marker = useId();
  const svg = useRef<SVGSVGElement>(null);
  const byId = useMemo(() => new Map(diagram.nodes.map((node) => [node.id, node])), [diagram]);
  // Placement depends on the graph, the badges and the steps opened, never on what is chosen.
  const placed = useMemo(
    () =>
      layoutGraph(diagram.nodes, diagram.edges, new Set(diagram.edges.map((_, index) => index)), direction, {
        height: (id, width) => {
          const node = byId.get(id);
          return node === undefined ? BOX_HEIGHT : boxHeight(node, width, badgeRoom(marks?.get(id)));
        },
      }),
    [diagram, byId, direction, marks],
  );
  const arrows = useMemo(() => placed.arrows.filter((arrow) => active.edges.has(arrow.index)), [placed, active.edges]);
  const placedById = useMemo(() => new Map(placed.boxes.map((box) => [box.id, box])), [placed]);
  const selectedBox = selected === null ? undefined : boxOf(diagram, selected);
  const anchor: LayoutBox | undefined = placedById.get(selectedBox?.id ?? 'start') ?? placedById.get('start');
  const revealBox = reveal == null ? undefined : boxOf(diagram, reveal.node);
  const focusBox = focus == null || focus.node === null ? undefined : boxOf(diagram, focus.node)?.id;
  // Give the focus asked for once its element is drawn, without scrolling: a reveal brings a box into view.
  useLayoutEffect(() => {
    const element = svg.current;
    if (focus == null || element === null) return;
    const target = focus.node === null ? element.closest<HTMLElement>('.diagram-gestures') : [...element.querySelectorAll<SVGGElement>('g.box')].find((box) => box.dataset.box === focusBox);
    if (target == null) return;
    target.focus({ preventScroll: true });
    onFocused?.();
  }, [focus, focusBox]);
  // Fit the lines once they are drawn, and again once the page's font has loaded.
  useLayoutEffect(() => {
    const element = svg.current;
    if (element === null) return;
    fitLines(element);
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) fitLines(element);
    });
    return () => {
      live = false;
    };
  }, [placed, marks]);
  return (
    <DiagramViewport
      key={`${diagram.key}:${direction}`}
      width={placed.width}
      height={placed.height}
      opening={(view: Size) => openingCamera(view, placed, anchor)}
      reveal={reveal == null ? null : { box: revealBox === undefined ? undefined : placedById.get(revealBox.id), key: reveal.key }}
      controls={
        <div className="seg" role="group" aria-label="フローの向き">
          <button type="button" aria-pressed={direction === 'TB'} aria-label="縦方向" title="縦方向" onClick={() => setDirection('TB')}>↓ 縦</button>
          <button type="button" aria-pressed={direction === 'LR'} aria-label="横方向" title="横方向" onClick={() => setDirection('LR')}>→ 横</button>
        </div>
      }
    >
      <svg ref={svg} className="diagram" viewBox={`0 0 ${placed.width} ${placed.height}`} width={placed.width} height={placed.height} role="group" aria-label={label}>
        <defs>
          <marker id={`${marker}-on`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="head on" />
          </marker>
          <marker id={`${marker}-error`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="head error" />
          </marker>
        </defs>
        {arrows.map((arrow) => (
          <g key={arrow.index} className={`edge ${arrow.kind}`}>
            <path d={arrow.d} markerEnd={`url(#${marker}-${arrow.kind === 'error' ? 'error' : 'on'})`} />
            {arrow.label ? (
              <g className="edge-caption">
                <rect x={arrow.label.x - arrow.label.width / 2} y={arrow.label.y - arrow.label.height / 2} width={arrow.label.width} height={arrow.label.height} rx={4} />
                <text className="edge-label" x={arrow.label.x} y={arrow.label.y} textAnchor="middle" dominantBaseline="central" data-room={arrow.label.width - 6}>
                  {truncateColumns(arrow.label.text, EDGE_LABEL_COLUMNS)}
                  <title>{arrow.label.text}</title>
                </text>
              </g>
            ) : null}
          </g>
        ))}
        {placed.boxes.map((box) => {
          const node = byId.get(box.id) as DiagramNode;
          const on = active.nodes.has(node.id);
          const action = boxAction(node);
          const clickable = action !== 'none';
          const mark = marks?.get(node.id);
          const badge = mark === undefined ? 0 : badgeWidth(mark);
          const lines = titleLines(node, box.width, mark);
          const subtitle = lines.length === 1 && node.subtitle !== '' ? truncateColumns(node.subtitle, Math.floor((box.width - 2 * INSET) / SUBTITLE_COLUMN)) : undefined;
          // The text sits in the middle of a box made taller than it (the 36px minimum).
          const content = 2 * PADDING + TITLE_LINE * lines.length + (subtitle === undefined ? 0 : SUBTITLE_LINE) + ROW_LINE * node.rows.length;
          const top = box.y + Math.max(0, (box.height - content) / 2) + PADDING;
          const rowsTop = top + TITLE_LINE * lines.length + (subtitle === undefined ? 0 : SUBTITLE_LINE);
          const rowColumns = Math.floor((box.width - 2 * INSET) / ROW_COLUMN);
          const room = box.width - 2 * INSET;
          const pill = node.tone === 'start' || ((node.tone === 'end' || node.tone === 'error') && node.rows.length === 0);
          const words = boxWords(node, mark, on, action);
          const activate = (keyboard: boolean) => onSelect(node, keyboard);
          const rowText = (row: DiagramRow, index: number) => (
            <text key={index} className={`box-row tone-${row.tone} ${active.rows.has(`${node.id}|${index}`) ? 'on' : 'off'}${row.step === undefined ? '' : ' step'}`} x={box.x + INSET} y={rowsTop + ROW_LINE * index + 13} data-room={room}>
              {rowLine(row.text, rowColumns)}
            </text>
          );
          return (
            <Fragment key={node.id}>
              <g
                className={`box ${on ? 'on' : 'off'}${selectedBox?.id === node.id ? ' selected' : ''} tone-${node.tone}${clickable ? ' clickable' : ''}`}
                data-box={node.id}
                tabIndex={clickable ? 0 : -1}
                role={clickable ? 'button' : undefined}
                aria-label={spokenLabel(words)}
                onClick={clickable ? () => activate(false) : undefined}
                onKeyDown={clickable ? onActivateKey(() => activate(true)) : undefined}
              >
                <title>{words.join('\n')}</title>
                <rect className="frame" x={box.x} y={box.y} width={box.width} height={box.height} rx={pill ? box.height / 2 : 6} />
                <text className="title" x={box.x + INSET} y={top + 13}>
                  {lines.map((line, index) => (
                    <tspan key={index} x={box.x + INSET} dy={index === 0 ? 0 : TITLE_LINE} data-room={index === 0 ? room - badgeRoom(mark) : room}>
                      {line}
                    </tspan>
                  ))}
                </text>
                {subtitle !== undefined ? (
                  <text className="sub" x={box.x + INSET} y={top + TITLE_LINE + 11} data-room={room}>
                    {subtitle}
                  </text>
                ) : null}
                {node.rows.map((row, index) => (row.step === undefined ? rowText(row, index) : null))}
                {mark !== undefined ? (
                  <g className={`box-badge badge-${mark.kind}`}>
                    <rect x={box.x + box.width - badge - 8} y={top - 1} width={badge} height={17} rx={8.5} />
                    <text x={box.x + box.width - 8 - badge / 2} y={top + 11.5} textAnchor="middle">
                      {mark.label}
                    </text>
                  </g>
                ) : null}
              </g>
              {node.rows.map((row, index) => {
                const step = row.step;
                if (step === undefined) return null;
                const open = (keyboard: boolean) => onToggleStep(step, keyboard);
                // A row that names a step is a button of its own beside the box's: it opens the step in place.
                return (
                  <g key={`step-${index}`} className="box-step" role="button" tabIndex={0} aria-label={spokenLabel([row.full, '押すとその場で開く'])} onClick={() => open(false)} onKeyDown={onActivateKey(() => open(true))}>
                    <title>{`${row.full}\n押すとその場で開く`}</title>
                    <rect className="hit" x={box.x + INSET / 2} y={rowsTop + ROW_LINE * index} width={box.width - INSET} height={ROW_LINE} rx={3} />
                    {rowText(row, index)}
                  </g>
                );
              })}
            </Fragment>
          );
        })}
      </svg>
    </DiagramViewport>
  );
}
