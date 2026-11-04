/**
 * Where the diagram's view looks: the scale and position a diagram opens at,
 * the pan that brings a box into view, and where the card of a box goes on
 * the screen. Box titles are drawn at 12.5px, so
 * a diagram never opens at a scale where they read under 11px; a layout too
 * wide for its view at that scale is panned sideways instead of shrunk. A
 * camera is the transform DiagramViewport hands to react-zoom-pan-pinch.
 * Nothing here touches the DOM.
 */

/** A width and a height in pixels: a view's on screen, or a layout's before it is scaled. */
export interface Size {
  width: number;
  height: number;
}

/** A box of a layout, such as a LayoutBox: its top-left corner and its size, in layout pixels. */
export interface Rect extends Size {
  x: number;
  y: number;
}

/**
 * How a layout sits in its view: where the layout's top-left corner is drawn,
 * in pixels from the view's top-left corner, and the zoom. A layout point
 * (px, py) is drawn at (x + px × scale, y + py × scale). These are
 * react-zoom-pan-pinch's positionX, positionY and scale.
 */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** The smallest scale a diagram opens at: box titles, drawn at 12.5px, read 11px. */
export const LEGIBLE_SCALE = 11 / 12.5;

/** The room kept between the view's edges and the layout's, in screen pixels. */
const MARGIN = 12;

/** Whether a span of the screen, from `start` and `length` long, lies wholly between 0 and `limit`. */
function within(start: number, length: number, limit: number): boolean {
  return start >= 0 && start + length <= limit;
}

/** The camera's y that puts the top of a box one third of the way down the view. */
function thirdDown(view: Size, box: Rect, scale: number): number {
  return view.height / 3 - box.y * scale;
}

/**
 * The view a diagram opens at. It fits the layout's width, never above 100%,
 * unless titles would then read under 11px: it opens at LEGIBLE_SCALE
 * instead. A layout that fits across at that scale is centred. A wider one is
 * centred on the anchor, the box to show first (the selected box, else the
 * start box), but never so far that more than the margin shows beside the
 * layout's left or right edge; without an anchor it is centred. The layout's
 * top sits at the margin unless the anchor would then reach below the view:
 * the anchor's top then sits one third of the way down, and the layout's top
 * is never lower than the margin.
 */
export function openingCamera(view: Size, layout: Size, anchor?: Rect): Camera {
  const fit = layout.width > 0 ? Math.min(1, (view.width - 2 * MARGIN) / layout.width) : 1;
  const scale = Math.max(LEGIBLE_SCALE, fit);
  const width = layout.width * scale;
  const x = anchor === undefined || width <= view.width
    ? (view.width - width) / 2
    : Math.min(MARGIN, Math.max(view.width - MARGIN - width, view.width / 2 - (anchor.x + anchor.width / 2) * scale));
  const y = anchor !== undefined && MARGIN + (anchor.y + anchor.height) * scale > view.height
    ? Math.min(MARGIN, thirdDown(view, anchor, scale))
    : MARGIN;
  return { x, y, scale };
}

/**
 * The camera that brings a box into view at the same scale, or undefined when
 * the box is already wholly visible. It pans only along the axes that need
 * it: a box cut by or beyond the left or right edge is centred across, and a
 * box cut by or beyond the top or bottom edge gets its top one third of the
 * way down.
 */
export function revealCamera(view: Size, camera: Camera, box: Rect): Camera | undefined {
  const across = within(camera.x + box.x * camera.scale, box.width * camera.scale, view.width);
  const down = within(camera.y + box.y * camera.scale, box.height * camera.scale, view.height);
  if (across && down) return undefined;
  return {
    x: across ? camera.x : view.width / 2 - (box.x + box.width / 2) * camera.scale,
    y: down ? camera.y : thirdDown(view, box, camera.scale),
    scale: camera.scale,
  };
}

/** The room kept between a card and the box it describes, and between a card and the view's edges. */
const CARD_GAP = 8;

/** A value kept between two bounds (the lower one wins when they cross). */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Where a card goes beside a box, in the pixels of the view: to the right of
 * the box, else to its left, else below it, else above it, the first place
 * where it fits whole inside the view without covering the box. Beside the
 * box it lines up with the box's top, below or above it with the box's left
 * edge, moved as little as keeps it inside the view. When it fits nowhere
 * whole it goes below or above the box, where there is more room, kept
 * inside the view even if it then covers part of the box.
 */
export function cardPlace(view: Size, box: Rect, card: Size): { x: number; y: number } {
  const across = clamp(box.x, CARD_GAP, view.width - CARD_GAP - card.width);
  const down = clamp(box.y, CARD_GAP, view.height - CARD_GAP - card.height);
  const right = box.x + box.width + CARD_GAP;
  const left = box.x - CARD_GAP - card.width;
  const below = box.y + box.height + CARD_GAP;
  const above = box.y - CARD_GAP - card.height;
  const tallEnough = card.height <= view.height - 2 * CARD_GAP;
  const wideEnough = card.width <= view.width - 2 * CARD_GAP;
  if (tallEnough && right + card.width <= view.width - CARD_GAP) return { x: right, y: down };
  if (tallEnough && left >= CARD_GAP) return { x: left, y: down };
  if (wideEnough && below + card.height <= view.height - CARD_GAP) return { x: across, y: below };
  if (wideEnough && above >= CARD_GAP) return { x: across, y: above };
  const roomBelow = view.height - (box.y + box.height);
  return { x: across, y: roomBelow >= box.y ? clamp(below, CARD_GAP, view.height - CARD_GAP - card.height) : clamp(above, CARD_GAP, view.height - CARD_GAP - card.height) };
}
