import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { openingCamera, type Rect, type Size } from '../lib/camera';
import type { Mark } from '../lib/changes';
import { BOX_INSET, boxActions, boxLine, boxOf, isRegion, layoutDiagram, REGION_HEADER, REGION_INSET, regionLine, spokenLabel, type CardAction, type Diagram, type DiagramGroup, type DiagramNode, type ExitTag } from '../lib/diagram';
import { EDGE_LABEL_COLUMNS, textColumns, truncateColumns, type LayoutBox, type LayoutDirection, type LayoutGroup } from '../lib/graph';
import { DiagramCard, type CardContent } from './DiagramCard';
import { DiagramViewport } from './DiagramViewport';

/** The boxes, regions, arrows and rows (`<box or region id>|<index>`) the chosen way runs through (see activeOf). */
export interface Active {
  nodes: Set<string>;
  edges: Set<number>;
  rows: Set<string>;
  groups: Set<string>;
}

export interface FlowDiagramProps {
  diagram: Diagram;
  active: Active;
  /** The node selected in this frame, by its id in the tree: the box or the region that shows it is highlighted, and the diagram opens on it. */
  selected: string | null;
  /** The node whose box to bring into view at the same scale, and a key that changes each time it should be (a selection, a step opened or folded). */
  reveal?: { node: string; key: number } | null | undefined;
  /** What to give the keyboard focus once it is drawn: the box that shows a node, or the diagram itself for null (the element the reader activated went away). onFocused says it has it. */
  focus?: { node: string | null } | null | undefined;
  label: string;
  /** The badges of the boxes and regions the pull request changed, by their id (a map of a pull request). */
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** A box or the label of a region is clicked or tapped, or Enter or Space is pressed on it (keyboard): select its row of the outline, nothing else. */
  onSelect: (shape: DiagramNode | DiagramGroup, keyboard: boolean) => void;
  /** The card's 中の流れを見る: look inside a function the box calls, from the keyboard or not; `box.opens` names the call the button names (its own, or one of box.alsoOpens). The card closes first. */
  onOpen?: (box: DiagramNode, keyboard: boolean) => void;
  /** The card's その場で開く or その場で畳む: open or fold a step in place (the box's own, or the step a row names). */
  onToggleStep: (step: string, keyboard: boolean) => void;
  /** The focus asked for (see focus) is given. */
  onFocused?: () => void;
}

/** How long the pointer rests on a box before its card shows, and how long a card shown by hovering stays once the pointer leaves (time to move onto it). */
const SHOW_DELAY = 150;
const HIDE_DELAY = 150;
/** The room between the tags at the end of a line. */
const GAP = 8;

/** The width of a badge (11px text, two columns a wide character). */
function badgeWidth(mark: Mark): number {
  return Math.ceil(textColumns(mark.label) * 5.6) + 14;
}

/** The room a badge takes from the end of a line: the badge and the gap before it. */
function badgeRoom(mark: Mark | undefined): number {
  return mark === undefined ? 0 : badgeWidth(mark) + 8;
}

/**
 * Squeeze the lines of text the font draws wider than their room (data-room,
 * in pixels) so they stay inside their box: the widths that cut them are an
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

/** The element that draws a box or the label of a region, by its id. */
function shapeElement(svg: SVGSVGElement | null, id: string): SVGGElement | null {
  return svg?.querySelector<SVGGElement>(`[data-box="${CSS.escape(id)}"]`) ?? null;
}

/** Whether a tag is on the chosen way: a box's own exit with its box, a tag of rows when one of them is. */
function tagOn(id: string, tag: ExitTag, boxOn: boolean, rows: ReadonlySet<string>): boolean {
  return tag.rows.length === 0 ? boxOn : tag.rows.some((index) => rows.has(`${id}|${index}`));
}

/**
 * An automatically arranged diagram of one frame with direction, zoom and
 * fit controls, and the arrows of the chosen way only. Three colors: grey
 * for what the chosen way does not run, the accent for what it runs and for
 * the selection, red for a throw, a tag that fails and the arrows of an
 * error. A box the pull request changed carries a badge in the grey scale at
 * the end of its line, so the colors keep their meaning.
 *
 * Every box is one line: its words, cut with an ellipsis, and how it ends
 * the flow (`→ 終わり`, `→ 失敗 ×2`). The boxes a `try` guards stand in a
 * region with a dashed border, whose label says what an exception does.
 * Choosing a box (or a region's label) only selects it. Its card, shown when
 * the pointer rests on it, when it takes the keyboard focus or when it is
 * tapped, says the rest in full and offers to look inside each function it
 * calls or to open its step in place; Tab goes from a box into its card,
 * Escape or a press elsewhere closes it, and moving the view hides it. A card
 * belongs to its frame: looking inside a call closes it, and no card follows
 * the reader into another frame.
 */
export function FlowDiagram({ diagram, active, selected, reveal, focus, label, marks, onSelect, onOpen, onToggleStep, onFocused }: FlowDiagramProps) {
  const [direction, setDirection] = useState<LayoutDirection>('TB');
  const marker = useId();
  const cardId = useId();
  const svg = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const follow = useRef<(() => void) | null>(null);
  // The shape whose card shows, how it came (the pointer resting on it, the keyboard focus, or pinned: a tap, a button of the card), and the
  // diagram it belongs to: box ids repeat across frames, so a card shown (or about to show) in one frame never shows in another.
  const frame = diagram.key;
  const [shownCard, setCard] = useState<{ id: string; via: 'hover' | 'focus' | 'pin'; frame: string } | null>(null);
  const card = shownCard !== null && shownCard.frame === frame ? shownCard : null;
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  // The pointer of the last press (a tap shows the card), a shape whose next focus must not show it (Escape gave the focus back),
  // and where the pointer was when a card was pinned: the boxes a step opened or folded moves under a still pointer do not take its place.
  const pointer = useRef('mouse');
  const quiet = useRef<string | null>(null);
  const pinnedAt = useRef<{ x: number; y: number } | null>(null);
  const byId = useMemo(() => new Map(diagram.nodes.map((node) => [node.id, node])), [diagram]);
  const groupById = useMemo(() => new Map(diagram.groups.map((group) => [group.id, group])), [diagram]);
  // Placement depends on the graph and the steps opened, never on what is chosen: every box is one line.
  const placed = useMemo(() => layoutDiagram(diagram, new Set(diagram.edges.map((_, index) => index)), direction), [diagram, direction]);
  const arrows = useMemo(() => placed.arrows.filter((arrow) => active.edges.has(arrow.index)), [placed, active.edges]);
  // Where each box and the label of each region is, in the diagram's pixels.
  const rects = useMemo(
    () => new Map<string, Rect>([...placed.boxes.map((box) => [box.id, box] as const), ...placed.groups.map((group) => [group.id, { x: group.x, y: group.y, width: group.width, height: REGION_HEADER }] as const)]),
    [placed],
  );
  // The first box of each region, before which its label is drawn: the label comes first in the order of the keyboard focus.
  const labelsBefore = useMemo(() => {
    const before = new Map<string, LayoutGroup[]>();
    for (const rect of placed.groups) {
      const first = groupById.get(rect.id)?.members[0];
      if (first !== undefined) before.set(first, [...(before.get(first) ?? []), rect]);
    }
    return before;
  }, [placed, groupById]);
  const selectedShape = selected === null ? undefined : boxOf(diagram, selected);
  const anchor = rects.get(selectedShape?.id ?? 'start') ?? rects.get('start');
  const revealShape = reveal == null ? undefined : boxOf(diagram, reveal.node);
  const focusShape = focus == null || focus.node === null ? undefined : boxOf(diagram, focus.node)?.id;
  const cardGone = shownCard !== null && (card === null || (!byId.has(card.id) && !groupById.has(card.id)));

  // Give the focus asked for once its element is drawn, without scrolling: a reveal brings a box into view.
  useLayoutEffect(() => {
    const element = svg.current;
    if (focus == null || element === null) return;
    const target = focus.node === null ? element.closest<HTMLElement>('.diagram-gestures') : focusShape === undefined ? null : shapeElement(element, focusShape);
    if (target == null) return;
    target.focus({ preventScroll: true });
    onFocused?.();
  }, [focus, focusShape]);
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
  // A card whose box went away (another frame, a step opened or folded) closes; leaving a frame stops a timer to show or hide a card
  // there and forgets what its cards remembered.
  useEffect(() => {
    if (cardGone) setCard(null);
  }, [cardGone]);
  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      quiet.current = null;
      pinnedAt.current = null;
    },
    [frame],
  );
  // While a card shows, a press elsewhere closes it, and so does Escape, which gives the focus back to its box from inside it.
  useEffect(() => {
    if (card === null) return;
    const onDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || cardRef.current?.contains(target) === true || shapeElement(svg.current, card.id)?.contains(target) === true) return;
      setCard(null);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = cardRef.current?.contains(document.activeElement) === true;
      setCard(null);
      if (!inside) return;
      quiet.current = card.id;
      shapeElement(svg.current, card.id)?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [card]);
  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const closeCard = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    setCard(null);
  };
  /** Close a card shown by hovering a moment after the pointer leaves it or its box, unless the pointer comes onto one of them. */
  const hideSoon = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setCard((current) => (current?.via === 'hover' ? null : current)), HIDE_DELAY);
  };
  /** Move the keyboard focus out of a card: forward to the next box or label after its own, back to its own; false when there is none. */
  const tabOut = (id: string, forward: boolean): boolean => {
    const shapes = [...(svg.current?.querySelectorAll<SVGGElement>('[data-box][tabindex="0"]') ?? [])];
    const at = shapes.findIndex((element) => element.dataset.box === id);
    const next = forward ? shapes[at + 1] : shapes[at];
    if (at === -1 || next === undefined) return false;
    next.focus({ preventScroll: true });
    return true;
  };
  /** The handlers of a box or the label of a region: its card shows on hover, focus or tap; a click, Enter or Space selects it when it shows a node. */
  const handlersOf = (shape: DiagramNode | DiagramGroup, selectable: boolean) => ({
    onPointerEnter: (event: PointerEvent<SVGGElement>) => {
      if (event.pointerType !== 'mouse') return;
      const still = pinnedAt.current;
      if (card?.via === 'pin' && still !== null && Math.abs(event.clientX - still.x) + Math.abs(event.clientY - still.y) < 4) return;
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(showTimer.current);
      showTimer.current = window.setTimeout(() => setCard((current) => (current?.id === shape.id && current.frame === frame ? current : { id: shape.id, via: 'hover', frame })), SHOW_DELAY);
    },
    onPointerLeave: (event: PointerEvent<SVGGElement>) => {
      if (event.pointerType !== 'mouse') return;
      window.clearTimeout(showTimer.current);
      hideSoon();
    },
    onPointerDown: (event: PointerEvent<SVGGElement>) => {
      pointer.current = event.pointerType;
    },
    onClick: selectable
      ? () => {
          onSelect(shape, false);
          if (pointer.current === 'mouse') return;
          window.clearTimeout(showTimer.current);
          pinnedAt.current = null;
          setCard({ id: shape.id, via: 'pin', frame });
        }
      : undefined,
    onKeyDown: selectable
      ? (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(shape, true);
            return;
          }
          // Tab goes into the card's buttons before the next box.
          const first = card?.id === shape.id && event.key === 'Tab' && !event.shiftKey ? cardRef.current?.querySelector<HTMLButtonElement>('button') : undefined;
          if (first == null) return;
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
      : undefined,
    onFocus: (event: FocusEvent<SVGGElement>) => {
      if (quiet.current === shape.id) {
        quiet.current = null;
        return;
      }
      if (!event.currentTarget.matches(':focus-visible')) return;
      window.clearTimeout(showTimer.current);
      setCard({ id: shape.id, via: 'focus', frame });
    },
    onBlur: (event: FocusEvent<SVGGElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && cardRef.current?.contains(next) === true) return;
      setCard((current) => (current?.id === shape.id && current.via === 'focus' && current.frame === frame ? null : current));
    },
  });
  /**
   * Do what a button of a card says, pressed where the pointer is (`at`): a
   * step opened or folded keeps its card, pinned to the step's box; looking
   * inside a call closes the card, which speaks of a box of this frame only.
   */
  const act = (id: string, action: CardAction, keyboard: boolean, at: { x: number; y: number }) => {
    if (action.kind === 'toggle') {
      onToggleStep(action.step, keyboard);
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      pinnedAt.current = at;
      setCard({ id: `n:${action.step}`, via: 'pin', frame });
      return;
    }
    const box = byId.get(id);
    closeCard();
    if (box !== undefined) onOpen?.({ ...box, opens: { node: action.node, fn: action.fn } }, keyboard);
  };
  /** Everything a card says about a box or a region (see CardContent). */
  const contentOf = (id: string): CardContent | undefined => {
    const mark = marks?.get(id);
    const box = byId.get(id);
    if (box !== undefined) {
      const tag = box.node === undefined ? undefined : box.tone === 'end' ? '終わり' : box.tone === 'error' ? '失敗' : undefined;
      return {
        name: box.title,
        code: box.code,
        ...(box.text === undefined ? {} : { text: box.text }),
        ...(tag === undefined ? {} : { tag }),
        rows: box.rows.map((row, index) => ({ full: row.full, tone: row.tone, on: active.rows.has(`${id}|${index}`) })),
        ...(mark === undefined ? {} : { mark }),
        off: box.node !== undefined && !active.nodes.has(id),
        actions: boxActions(box),
      };
    }
    const group = groupById.get(id);
    if (group === undefined) return undefined;
    return {
      name: group.title,
      code: group.code,
      text: group.title,
      rows: group.rows.length > 0 ? group.rows.map((row, index) => ({ full: row.full, tone: row.tone, on: active.rows.has(`${id}|${index}`) })) : [{ full: group.outcome, tone: 'error', on: active.groups.has(id) }],
      ...(mark === undefined ? {} : { mark }),
      off: !active.groups.has(id),
      actions: boxActions(group),
    };
  };
  const content = card === null ? undefined : contentOf(card.id);
  const overlay =
    card !== null && content !== undefined ? (
      <DiagramCard
        key={card.id}
        id={cardId}
        content={content}
        anchor={() => shapeElement(svg.current, card.id)}
        follow={follow}
        cardRef={cardRef}
        onAction={(action, keyboard, at) => act(card.id, action, keyboard, at)}
        onPointerEnter={() => window.clearTimeout(hideTimer.current)}
        onPointerLeave={hideSoon}
        onTabOut={(forward) => tabOut(card.id, forward)}
      />
    ) : null;

  /** The words a box is read by (its aria-label): its title, how it ends, every row, its badge, whether the chosen way runs it, and what pressing it does. */
  const spoken = (shape: DiagramNode | DiagramGroup, on: boolean, tags: readonly ExitTag[]): string => {
    const actions = boxActions(shape);
    const rows = isRegion(shape) && shape.rows.length === 0 ? [shape.outcome] : shape.rows.map((row) => row.full);
    return spokenLabel(
      [
        isRegion(shape) ? `${shape.title}（try）` : shape.title,
        ...tags.filter((tag) => tag.rows.length === 0).map((tag) => tag.text.replace(/^→ /, '')),
        ...rows,
        marks?.get(shape.id)?.title ?? '',
        on ? '' : '選んだ道筋では通らない',
        '押すとアウトラインの行を選ぶ',
        actions.length > 0 ? 'Tab でカードのボタンへ' : '',
      ].filter((line) => line !== ''),
    );
  };
  const regionLabel = (rect: LayoutGroup): ReactNode => {
    const group = groupById.get(rect.id) as DiagramGroup;
    const mark = marks?.get(group.id);
    const badge = mark === undefined ? 0 : badgeWidth(mark);
    const line = regionLine(group, rect.width, badgeRoom(mark));
    const middle = rect.y + 14;
    // As on a box, the tags stand at the end of the line: the middle, where the arrow into the region crosses the label, stays clear.
    const ends: number[] = [];
    let right = rect.x + rect.width - REGION_INSET - badgeRoom(mark);
    for (let index = line.tags.length - 1; index >= 0; index -= 1) {
      ends[index] = right;
      right -= (line.tags[index] as ExitTag).width + 6;
    }
    return (
      <g
        key={`label:${group.id}`}
        className={`region-label${selectedShape?.id === group.id ? ' selected' : ''}`}
        data-box={group.id}
        tabIndex={0}
        role="button"
        aria-label={spoken(group, active.groups.has(group.id), line.tags)}
        aria-describedby={card?.id === group.id ? cardId : undefined}
        {...handlersOf(group, true)}
      >
        <rect className="hit" x={rect.x} y={rect.y} width={rect.width} height={REGION_HEADER - 2} rx={10} />
        <text className="region-text region-title" x={rect.x + REGION_INSET} y={middle} dominantBaseline="central" data-room={line.room}>
          {line.title}
        </text>
        {line.tags.map((tag, index) => (
          <text key={tag.text} className={`region-text region-tag tone-${tag.tone} ${tagOn(group.id, tag, active.groups.has(group.id), active.rows) ? 'on' : 'off'}`} x={ends[index]} y={middle} textAnchor="end" dominantBaseline="central">
            {tag.text}
          </text>
        ))}
        {mark !== undefined ? (
          <g className={`box-badge badge-${mark.kind}`}>
            <rect x={rect.x + rect.width - badge - 8} y={middle - 8.5} width={badge} height={17} rx={8.5} />
            <text x={rect.x + rect.width - 8 - badge / 2} y={middle} textAnchor="middle" dominantBaseline="central">
              {mark.label}
            </text>
          </g>
        ) : null}
      </g>
    );
  };
  const boxShape = (box: LayoutBox): ReactNode => {
    const node = byId.get(box.id) as DiagramNode;
    const on = active.nodes.has(node.id);
    const selectable = node.node !== undefined;
    const mark = marks?.get(node.id);
    const badge = mark === undefined ? 0 : badgeWidth(mark);
    const line = boxLine(node, box.width, badgeRoom(mark));
    const chosen = selectedShape?.id === node.id;
    const pill = node.tone !== 'normal';
    const middle = box.y + box.height / 2;
    // The tags stand at the end of the line, before the badge, the last one rightmost: where each ends.
    const ends: number[] = [];
    let right = box.x + box.width - BOX_INSET - badgeRoom(mark);
    for (let index = line.tags.length - 1; index >= 0; index -= 1) {
      ends[index] = right;
      right -= (line.tags[index] as ExitTag).width + GAP;
    }
    return (
      <g
        key={node.id}
        className={`box ${on ? 'on' : 'off'}${chosen ? ' selected' : ''} tone-${node.tone}${selectable ? ' clickable' : ''}`}
        data-box={node.id}
        tabIndex={selectable ? 0 : undefined}
        role={selectable ? 'button' : undefined}
        aria-label={spoken(node, on, line.tags)}
        aria-describedby={card?.id === node.id ? cardId : undefined}
        {...handlersOf(node, selectable)}
      >
        {chosen ? <rect className="halo" x={box.x - 4} y={box.y - 4} width={box.width + 8} height={box.height + 8} rx={pill ? (box.height + 8) / 2 : 9} /> : null}
        <rect className="frame" x={box.x} y={box.y} width={box.width} height={box.height} rx={pill ? box.height / 2 : 6} />
        <text className={`title${node.titleCode ? ' code' : ''}`} x={box.x + BOX_INSET} y={middle} dominantBaseline="central" data-room={line.room}>
          {line.title}
        </text>
        {line.tags.map((tag, index) => (
          <text key={tag.text} className={`box-tag tone-${tag.tone} ${tagOn(node.id, tag, on, active.rows) ? 'on' : 'off'}`} x={ends[index]} y={middle} textAnchor="end" dominantBaseline="central">
            {tag.text}
          </text>
        ))}
        {mark !== undefined ? (
          <g className={`box-badge badge-${mark.kind}`}>
            <rect x={box.x + box.width - badge - 8} y={middle - 8.5} width={badge} height={17} rx={8.5} />
            <text x={box.x + box.width - 8 - badge / 2} y={middle} textAnchor="middle" dominantBaseline="central">
              {mark.label}
            </text>
          </g>
        ) : null}
      </g>
    );
  };

  return (
    <DiagramViewport
      key={`${diagram.key}:${direction}`}
      width={placed.width}
      height={placed.height}
      opening={(view: Size) => openingCamera(view, placed, anchor)}
      reveal={reveal == null ? null : { box: revealShape === undefined ? undefined : rects.get(revealShape.id), key: reveal.key }}
      overlay={overlay}
      onMove={closeCard}
      onView={() => follow.current?.()}
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
        {placed.groups.map((rect) => (
          <g key={rect.id} className={`region${selectedShape?.id === rect.id ? ' selected' : ''}${active.groups.has(rect.id) ? ' on' : ' off'}`}>
            {selectedShape?.id === rect.id ? <rect className="halo" x={rect.x - 4} y={rect.y - 4} width={rect.width + 8} height={rect.height + 8} rx={13} /> : null}
            <rect className="area" x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={10} />
          </g>
        ))}
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
        {placed.boxes.map((box) => [...(labelsBefore.get(box.id) ?? []).map(regionLabel), boxShape(box)])}
      </svg>
    </DiagramViewport>
  );
}
