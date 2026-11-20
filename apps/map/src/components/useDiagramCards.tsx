import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { CardAction } from '../lib/diagram';
import { DiagramCard, type CardContent } from './DiagramCard';

/** How long the pointer rests on a shape before its card shows, and how long a card shown by hovering stays once the pointer leaves (time to move onto it). */
const SHOW_DELAY = 150;
const HIDE_DELAY = 150;

/** The element that draws a shape (a box, the label of a region, a node of a chart), by its id. */
export function shapeElement(svg: SVGSVGElement | null, id: string): SVGGElement | null {
  return svg?.querySelector<SVGGElement>(`[data-box="${CSS.escape(id)}"]`) ?? null;
}

/** What the cards of a drawing read (see useDiagramCards). */
export interface DiagramCardsOptions {
  /** The frame the drawing shows: a card belongs to its frame, and none follows the reader into another. */
  frame: string;
  svg: RefObject<SVGSVGElement | null>;
  /** Whether a shape is still drawn: the card of one that went away closes. */
  exists: (id: string) => boolean;
  /** What the card of a shape says; undefined for none. */
  contentOf: (id: string) => CardContent | undefined;
  /** A button of a card is pressed, from the keyboard or not, where the pointer is (see DiagramCard.onAction). */
  onAction: (id: string, action: CardAction, keyboard: boolean, at: { x: number; y: number }) => void;
}

/** The handlers a shape takes so its card shows on hover, focus or tap, and a click, Enter or Space selects it. */
export interface ShapeHandlers {
  onPointerEnter: (event: PointerEvent<SVGGElement>) => void;
  onPointerLeave: (event: PointerEvent<SVGGElement>) => void;
  onPointerDown: (event: PointerEvent<SVGGElement>) => void;
  onClick: (() => void) | undefined;
  onKeyDown: ((event: KeyboardEvent<SVGGElement>) => void) | undefined;
  onFocus: (event: FocusEvent<SVGGElement>) => void;
  onBlur: (event: FocusEvent<SVGGElement>) => void;
}

/** The cards of a drawing (see useDiagramCards). */
export interface DiagramCards {
  /** The shape whose card shows in this frame, by id; null for none. */
  shown: string | null;
  /** The id of the card's element, for the aria-describedby of its shape. */
  cardId: string;
  /** The handlers of a shape; `select` is what a click, Enter or Space does, undefined for a shape that selects nothing. */
  handlersOf: (id: string, select: ((keyboard: boolean) => void) | undefined) => ShapeHandlers;
  /** The card shown, to draw over the drawing (DiagramViewport's overlay). */
  overlay: ReactNode;
  /** Close the card, and stop a timer to show or hide one. */
  close: () => void;
  /** Show the card of a shape pinned, as a button of a card does: the shapes that move under a still pointer at `at` do not take its place. */
  pin: (id: string, at: { x: number; y: number }) => void;
  /** Place the card again: the drawing calls it when the view moves. */
  follow: () => void;
}

/**
 * The cards of a drawing of a frame: the card of a shape shows when the
 * pointer rests on it, when it takes the keyboard focus or when it is tapped
 * (pinned); Tab goes from a shape into its card, Escape or a press elsewhere
 * closes it, and moving the view hides it. A card belongs to its frame: the
 * shape ids repeat across frames, so a card shown (or about to show) in one
 * frame never shows in another. The side pane's diagram and the flow view's
 * chart share it, so their shapes answer the pointer and the keyboard alike.
 */
export function useDiagramCards({ frame, svg, exists, contentOf, onAction }: DiagramCardsOptions): DiagramCards {
  const cardId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const follow = useRef<(() => void) | null>(null);
  // The shape whose card shows, how it came (the pointer resting on it, the keyboard focus, or pinned: a tap, a button of the card), and the frame it belongs to.
  const [shownCard, setCard] = useState<{ id: string; via: 'hover' | 'focus' | 'pin'; frame: string } | null>(null);
  const card = shownCard !== null && shownCard.frame === frame ? shownCard : null;
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  // The pointer of the last press (a tap shows the card), a shape whose next focus must not show it (Escape gave the focus back),
  // and where the pointer was when a card was pinned: the shapes a step opened or folded moves under a still pointer do not take its place.
  const pointer = useRef('mouse');
  const quiet = useRef<string | null>(null);
  const pinnedAt = useRef<{ x: number; y: number } | null>(null);
  const cardGone = shownCard !== null && (card === null || !exists(card.id));

  // A card whose shape went away (another frame, a step opened or folded) closes; leaving a frame stops a timer to show or hide a card
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
  // While a card shows, a press elsewhere closes it, and so does Escape, which gives the focus back to its shape from inside it.
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

  const close = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    setCard(null);
  };
  /** Close a card shown by hovering a moment after the pointer leaves it or its shape, unless the pointer comes onto one of them. */
  const hideSoon = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setCard((current) => (current?.via === 'hover' ? null : current)), HIDE_DELAY);
  };
  /** Move the keyboard focus out of a card: forward to the next shape after its own, back to its own; false when there is none. */
  const tabOut = (id: string, forward: boolean): boolean => {
    const shapes = [...(svg.current?.querySelectorAll<SVGGElement>('[data-box][tabindex="0"]') ?? [])];
    const at = shapes.findIndex((element) => element.dataset.box === id);
    const next = forward ? shapes[at + 1] : shapes[at];
    if (at === -1 || next === undefined) return false;
    next.focus({ preventScroll: true });
    return true;
  };
  const handlersOf = (id: string, select: ((keyboard: boolean) => void) | undefined): ShapeHandlers => ({
    onPointerEnter: (event) => {
      if (event.pointerType !== 'mouse') return;
      const still = pinnedAt.current;
      if (card?.via === 'pin' && still !== null && Math.abs(event.clientX - still.x) + Math.abs(event.clientY - still.y) < 4) return;
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(showTimer.current);
      showTimer.current = window.setTimeout(() => setCard((current) => (current?.id === id && current.frame === frame ? current : { id, via: 'hover', frame })), SHOW_DELAY);
    },
    onPointerLeave: (event) => {
      if (event.pointerType !== 'mouse') return;
      window.clearTimeout(showTimer.current);
      hideSoon();
    },
    onPointerDown: (event) => {
      pointer.current = event.pointerType;
    },
    onClick:
      select === undefined
        ? undefined
        : () => {
            select(false);
            if (pointer.current === 'mouse') return;
            window.clearTimeout(showTimer.current);
            pinnedAt.current = null;
            setCard({ id, via: 'pin', frame });
          },
    onKeyDown:
      select === undefined
        ? undefined
        : (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              select(true);
              return;
            }
            // Tab goes into the card's buttons before the next shape.
            const first = card?.id === id && event.key === 'Tab' && !event.shiftKey ? cardRef.current?.querySelector<HTMLButtonElement>('button') : undefined;
            if (first == null) return;
            event.preventDefault();
            first.focus({ preventScroll: true });
          },
    onFocus: (event) => {
      if (quiet.current === id) {
        quiet.current = null;
        return;
      }
      if (!event.currentTarget.matches(':focus-visible')) return;
      window.clearTimeout(showTimer.current);
      setCard({ id, via: 'focus', frame });
    },
    onBlur: (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && cardRef.current?.contains(next) === true) return;
      setCard((current) => (current?.id === id && current.via === 'focus' && current.frame === frame ? null : current));
    },
  });
  const pin = (id: string, at: { x: number; y: number }) => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    pinnedAt.current = at;
    setCard({ id, via: 'pin', frame });
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
        onAction={(action, keyboard, at) => onAction(card.id, action, keyboard, at)}
        onPointerEnter={() => window.clearTimeout(hideTimer.current)}
        onPointerLeave={hideSoon}
        onTabOut={(forward) => tabOut(card.id, forward)}
      />
    ) : null;
  return { shown: card?.id ?? null, cardId, handlersOf, overlay, close, pin, follow: () => follow.current?.() };
}
