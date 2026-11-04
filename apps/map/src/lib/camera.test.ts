import { describe, expect, it } from 'vitest';
import { cardPlace, LEGIBLE_SCALE, openingCamera, revealCamera, type Camera, type Rect, type Size } from './camera';

/** The diagram's gesture box in the 1440x900 pane and in the 1280x800 one, with the one-row toolbar. */
const pane1440: Size = { width: 472, height: 631 };
const pane1280: Size = { width: 405, height: 531 };

/** Layouts with 12px margins: one 320px column (hono /token), two 200px columns, and five. */
const oneColumn: Size = { width: 344, height: 1398 };
const twoColumns: Size = { width: 440, height: 994 };
const fiveColumns: Size = { width: 1088, height: 910 };

/** A box at a layout position: 320px wide alone in its rank, 200px in a rank of two or more. */
const box = (x: number, y: number, width = 320, height = 48): Rect => ({ x, y, width, height });

describe('openingCamera', () => {
  it('should open a layout that fits at 100%, centred across with its top at the margin', () => {
    expect(openingCamera(pane1440, oneColumn, box(12, 12, 320, 36))).toEqual({ x: 64, y: 12, scale: 1 });
  });

  it('should fit the width when titles still read at least 11px', () => {
    expect(openingCamera(pane1440, { width: 460, height: 900 }, box(70, 12, 320, 36))).toEqual({ x: expect.closeTo(12, 9), y: 12, scale: expect.closeTo(448 / 460, 9) });
  });

  it('should open at the legible scale, centred without overflow, when fitting the width would read under 11px', () => {
    const camera = openingCamera(pane1280, twoColumns, box(12, 12, 200, 36));
    expect(381 / 440).toBeLessThan(LEGIBLE_SCALE);
    expect(camera).toEqual({ x: expect.closeTo(8.9, 6), y: 12, scale: LEGIBLE_SCALE });
    expect(12.5 * camera.scale).toBeCloseTo(11, 9);
    expect(camera.x + twoColumns.width * camera.scale).toBeLessThan(pane1280.width);
  });

  it('should open a layout too wide for the view on the start box, with no more than the margin beside its left edge', () => {
    expect(openingCamera(pane1440, fiveColumns, box(12, 12, 200, 36))).toEqual({ x: 12, y: 12, scale: LEGIBLE_SCALE });
  });

  it('should centre the anchor across a layout too wide for the view', () => {
    expect(openingCamera(pane1440, fiveColumns, box(228, 300, 200))).toEqual({ x: expect.closeTo(236 - 328 * LEGIBLE_SCALE, 9), y: 12, scale: LEGIBLE_SCALE });
  });

  it('should leave no more than the margin beside the right edge of the layout when the anchor is in its last column', () => {
    const camera = openingCamera(pane1440, fiveColumns, box(876, 12, 200, 36));
    expect(camera.x + fiveColumns.width * camera.scale).toBeCloseTo(pane1440.width - 12, 9);
    expect([camera.y, camera.scale]).toEqual([12, LEGIBLE_SCALE]);
  });

  it('should centre a layout too wide for the view when there is no anchor', () => {
    expect(openingCamera(pane1440, fiveColumns)).toEqual({ x: expect.closeTo((472 - 1088 * LEGIBLE_SCALE) / 2, 9), y: 12, scale: LEGIBLE_SCALE });
  });

  it('should put an anchor below the view, or cut by its bottom edge, one third of the way down', () => {
    expect(openingCamera(pane1440, oneColumn, box(12, 1000))).toEqual({ x: 64, y: expect.closeTo(631 / 3 - 1000, 9), scale: 1 });
    expect(openingCamera(pane1440, oneColumn, box(12, 600))).toEqual({ x: 64, y: expect.closeTo(631 / 3 - 600, 9), scale: 1 });
  });
});

describe('revealCamera', () => {
  /** The one-column layout as it opens in the 1440x900 pane. */
  const opened: Camera = { x: 64, y: 12, scale: 1 };
  /** The five-column layout as it opens on its start box. */
  const openedWide: Camera = { x: 12, y: 12, scale: LEGIBLE_SCALE };

  it('should leave a wholly visible box where it is, even one touching the bottom edge', () => {
    expect(revealCamera(pane1440, opened, box(12, 300))).toBeUndefined();
    expect(revealCamera(pane1440, opened, box(12, 571))).toBeUndefined();
  });

  it('should move a box below the view one third of the way down at the same scale', () => {
    const camera = revealCamera(pane1440, opened, box(12, 1000));
    expect(camera).toEqual({ x: 64, y: expect.closeTo(631 / 3 - 1000, 9), scale: 1 });
    expect(revealCamera(pane1440, camera!, box(12, 1000))).toBeUndefined();
  });

  it('should move a box above the view one third of the way down at the same scale', () => {
    expect(revealCamera(pane1440, { x: 64, y: -800, scale: 1 }, box(12, 300))).toEqual({ x: 64, y: expect.closeTo(631 / 3 - 300, 9), scale: 1 });
  });

  it('should centre a box off to the right across the view at the same scale', () => {
    const camera = revealCamera(pane1440, openedWide, box(876, 100, 200));
    expect(camera).toEqual({ x: expect.closeTo(236 - 976 * LEGIBLE_SCALE, 9), y: 12, scale: LEGIBLE_SCALE });
    expect(revealCamera(pane1440, camera!, box(876, 100, 200))).toBeUndefined();
  });

  it('should pan only across for a box in view vertically but cut at the right edge', () => {
    expect(revealCamera(pane1280, { x: 12, y: 12, scale: 1 }, box(228, 100, 200))).toEqual({ x: 405 / 2 - 328, y: 12, scale: 1 });
  });

  it('should pan both ways for a box off to the side and below the view', () => {
    expect(revealCamera(pane1440, openedWide, box(660, 800, 200))).toEqual({
      x: expect.closeTo(236 - 760 * LEGIBLE_SCALE, 9),
      y: expect.closeTo(631 / 3 - 800 * LEGIBLE_SCALE, 9),
      scale: LEGIBLE_SCALE,
    });
  });
});

describe('cardPlace', () => {
  const card: Size = { width: 300, height: 180 };
  const covers = (at: { x: number; y: number }, rect: Rect) => at.x < rect.x + rect.width && rect.x < at.x + card.width && at.y < rect.y + rect.height && rect.y < at.y + card.height;

  it('should put a card to the right of a box, lined up with its top, when it fits there', () => {
    expect(cardPlace({ width: 900, height: 600 }, box(40, 100), card)).toEqual({ x: 368, y: 100 });
  });

  it('should put a card to the left of a box at the right of the view', () => {
    expect(cardPlace({ width: 900, height: 600 }, box(560, 100), card)).toEqual({ x: 252, y: 100 });
  });

  it('should put a card below a box in a narrow view, and above it at the bottom of the view', () => {
    const phone: Size = { width: 389, height: 640 };
    expect(cardPlace(phone, box(20, 100), card)).toEqual({ x: 20, y: 156 });
    expect(cardPlace(phone, box(20, 500), card)).toEqual({ x: 20, y: 312 });
    expect([covers(cardPlace(phone, box(20, 100), card), box(20, 100)), covers(cardPlace(phone, box(20, 500), card), box(20, 500))]).toEqual([false, false]);
  });

  it('should keep a card inside the view when its box is cut by an edge', () => {
    expect(cardPlace({ width: 900, height: 600 }, box(-100, -20), card)).toEqual({ x: 228, y: 8 });
    expect(cardPlace({ width: 389, height: 640 }, box(200, 300), card)).toEqual({ x: 81, y: 356 });
  });

  it('should keep a card that fits nowhere whole inside the view, on the side with more room', () => {
    expect(cardPlace({ width: 389, height: 300 }, box(20, 100, 320, 48), card)).toEqual({ x: 20, y: 112 });
    expect(cardPlace({ width: 389, height: 300 }, box(20, 130, 320, 48), card)).toEqual({ x: 20, y: 8 });
  });
});
