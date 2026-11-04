import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import { revealCamera, type Camera, type Rect, type Size } from '../lib/camera';

/** Fit the width of the diagram into the view, never above 100%, with space around it (幅に合わせる: it may go below the scale the diagram opens at). */
function fitWidth(view: ReactZoomPanPinchRef, width: number): void {
  const wrapper = view.instance.wrapperComponent;
  if (wrapper === null) return;
  const scale = Math.max(0.1, Math.min(1, (wrapper.clientWidth - 24) / width));
  void view.setTransform(Math.max(12, (wrapper.clientWidth - width * scale) / 2), 12, scale, 0);
}

/** The size of the area the diagram is drawn in; undefined while it has none (a drawer not shown yet). */
function viewSize(view: ReactZoomPanPinchRef): Size | undefined {
  const wrapper = view.instance.wrapperComponent;
  if (wrapper === null || wrapper.clientWidth === 0 || wrapper.clientHeight === 0) return undefined;
  return { width: wrapper.clientWidth, height: wrapper.clientHeight };
}

/** Show the view a diagram opens at, once its area has a size; returns whether it had one. */
function applyOpening(view: ReactZoomPanPinchRef, opening: (view: Size) => Camera): boolean {
  const size = viewSize(view);
  if (size === undefined) return false;
  const camera = opening(size);
  void view.setTransform(camera.x, camera.y, camera.scale, 0);
  return true;
}

/**
 * Fold a scroll of the area into the transform. The browser scrolls the area,
 * whose overflow is hidden, to show a box that takes the focus (Tab), and the
 * library does not see it; the boxes stay where they show, and 戻す, 全体 and
 * a reveal start from what the reader sees.
 */
function foldScroll(view: ReactZoomPanPinchRef): void {
  const wrapper = view.instance.wrapperComponent;
  if (wrapper === null || (wrapper.scrollLeft === 0 && wrapper.scrollTop === 0)) return;
  const { scrollLeft, scrollTop } = wrapper;
  wrapper.scrollLeft = 0;
  wrapper.scrollTop = 0;
  const { positionX, positionY, scale } = view.instance.state;
  void view.setTransform(positionX - scrollLeft, positionY - scrollTop, scale, 0);
}

/** Bring an element of the diagram that takes the focus into view at the same scale, as a reveal does (see revealCamera): the browser cannot scroll to a box above or left of the area. */
function revealFocused(view: ReactZoomPanPinchRef, element: Element): void {
  foldScroll(view);
  const wrapper = view.instance.wrapperComponent;
  const size = viewSize(view);
  if (wrapper === null || size === undefined) return;
  const { positionX, positionY, scale } = view.instance.state;
  const area = wrapper.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const camera = revealCamera(size, { x: positionX, y: positionY, scale }, { x: (box.left - area.left - positionX) / scale, y: (box.top - area.top - positionY) / scale, width: box.width / scale, height: box.height / scale });
  if (camera !== undefined) void view.setTransform(camera.x, camera.y, camera.scale, 0);
}

/** Whether the reader asked for less motion. */
function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface DiagramViewportProps {
  children: ReactNode;
  controls: ReactNode;
  /** The size of the diagram at 100%. */
  width: number;
  height: number;
  /** The view the diagram opens at for the size of its area (see openingCamera); 表示を戻す returns to it. */
  opening: (view: Size) => Camera;
  /** The box to bring into view at the same scale (in the diagram's pixels), and a key that changes each time it should be. */
  reveal?: { box: Rect | undefined; key: number } | null;
  /** Drawn over the diagram's area, outside its pan and zoom, in a layer the size of the area that lets the pointer through (the card of a box). */
  overlay?: ReactNode;
  /** The reader pans or zooms the diagram: a drag that moves it, a pinch, the wheel or the trackpad, the arrow and zoom keys, a button of the tools. */
  onMove?: () => void;
  /** The view changed, whatever changed it (a reveal, a box that takes the focus, the reader). */
  onView?: () => void;
}

/** The keys the library pans, zooms and resets the diagram with. */
const MOVE_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-', '=', '_', '0']);

/**
 * Pan and zoom a diagram with the library's mouse, touch and trackpad
 * gestures (the wheel pans; it does not zoom). The diagram opens at the
 * view `opening` gives, once its area has a size (a diagram that opens in a
 * drawer is measured before the drawer shows), and never refits on its own
 * after that, so the reader's zoom stays. A new reveal key pans the box it
 * names into view at the same scale, and so does a box that takes the focus.
 * The overlay is drawn over the area at the screen's scale; onMove tells when
 * the reader moves the view, onView when anything does.
 */
export function DiagramViewport({ children, controls, width, height, opening, reveal, overlay, onMove, onView }: DiagramViewportProps) {
  const start = useRef({ x: 0, y: 0 });
  const moved = useRef(false);
  const [scale, setScale] = useState(1);
  const viewRef = useRef<ReactZoomPanPinchRef | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  // The latest opening and reveal box, for the observer and the deferred reveal.
  const openingRef = useRef(opening);
  const revealBox = useRef(reveal?.box);
  useLayoutEffect(() => {
    openingRef.current = opening;
    revealBox.current = reveal?.box;
  });
  // Reads refs only, so the observer may keep the first render's copy.
  const openOnce = (view: ReactZoomPanPinchRef) => {
    if (!opened.current && applyOpening(view, openingRef.current)) opened.current = true;
  };
  useEffect(() => {
    const element = box.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    // The first size the area gets opens the diagram; later ones (a resize) leave the reader's view alone.
    const observer = new ResizeObserver(() => {
      if (viewRef.current !== null) openOnce(viewRef.current);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const revealKey = reveal?.key;
  const seen = useRef(revealKey);
  useEffect(() => {
    if (revealKey === undefined || revealKey === seen.current) return;
    seen.current = revealKey;
    // Wait for the next frame: opening or folding a step resizes the diagram, and the library stops a
    // running animation when it sees the size change.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const view = viewRef.current;
        const target = revealBox.current;
        const size = view === null ? undefined : viewSize(view);
        if (view === null || target === undefined || size === undefined || !opened.current) return;
        const { positionX, positionY, scale: current } = view.instance.state;
        const camera = revealCamera(size, { x: positionX, y: positionY, scale: current }, target);
        if (camera !== undefined) void view.setTransform(camera.x, camera.y, camera.scale, reducedMotion() ? 0 : 200);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [revealKey]);
  return (
    <div className="diagram-viewport" ref={box}>
      <TransformWrapper
        ref={viewRef}
        minScale={0.1}
        maxScale={4}
        limitToBounds={false}
        initialPositionY={12}
        wheel={{ wheelDisabled: true }}
        trackPadPanning={{ disabled: false, velocityDisabled: true }}
        panning={{ velocityDisabled: true, allowRightClickPan: false }}
        doubleClick={{ disabled: true }}
        keyboard={{ disabled: false, animationTime: 0 }}
        onInit={openOnce}
        onTransform={(_, state) => {
          setScale(state.scale);
          onView?.();
        }}
        onPanningStart={({ state }) => {
          start.current = { x: state.positionX, y: state.positionY };
          moved.current = false;
        }}
        onPanning={({ state }) => {
          if (moved.current || Math.hypot(state.positionX - start.current.x, state.positionY - start.current.y) <= 4) return;
          moved.current = true;
          onMove?.();
        }}
        onPinchStart={() => {
          moved.current = true;
          onMove?.();
        }}
        onWheelStart={() => onMove?.()}
      >
        {(view) => (
          <>
            <div className="diagram-tools" role="group" aria-label="図の表示操作">
              {controls}
              <div className="diagram-zoom">
                <button type="button" aria-label="図を縮小" title="図を縮小" disabled={scale <= 0.1} onClick={() => { onMove?.(); void view.zoomOut(0.25, 0); }}>−</button>
                <button type="button" aria-label="100%で表示" title="100%で表示" onClick={() => { onMove?.(); void view.setTransform(12, 12, 1, 0); }}>{Math.round(scale * 100)}%</button>
                <button type="button" aria-label="図を拡大" title="図を拡大" disabled={scale >= 4} onClick={() => { onMove?.(); void view.zoomIn(0.25, 0); }}>＋</button>
              </div>
              <button type="button" aria-label="幅に合わせる" title="幅に合わせる" onClick={() => { onMove?.(); fitWidth(view, width); }}>幅</button>
              <button type="button" aria-label="全体を表示" title="全体を表示" onClick={() => { onMove?.(); void view.fitToView({ maxScale: 1, animationTime: 0 }); }}>全体</button>
              <button type="button" aria-label="表示を戻す（開いたときの倍率と位置）" title="表示を戻す（開いたときの倍率と位置）" onClick={() => { onMove?.(); applyOpening(view, openingRef.current); }}>戻す</button>
            </div>
            <div className="diagram-stage">
              <TransformComponent
                wrapperClass="diagram-gestures"
                wrapperStyle={{ width: '100%', height: '100%' }}
                contentStyle={{ width, height }}
                wrapperProps={{
                  tabIndex: 0,
                  role: 'group',
                  title: 'ドラッグで移動・ピンチで拡大縮小',
                  'aria-label': 'フロー図（ドラッグで移動・ピンチで拡大縮小。矢印キーで移動、＋と−キーで拡大縮小）',
                  onClickCapture: (event) => {
                    // A drag ending over a box must not select it.
                    // Keyboard-generated clicks remain available after a gesture.
                    if (moved.current && event.detail !== 0) {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                  },
                  onScroll: () => foldScroll(view),
                  onFocus: (event) => {
                    // A box or a region that takes the focus (Tab) comes into view; the area itself (a click) stays as it is.
                    if (event.target !== event.currentTarget) revealFocused(view, event.target);
                  },
                  // Before the library, which takes these keys on the area and stops them there.
                  onKeyDownCapture: (event) => {
                    if (MOVE_KEYS.has(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) onMove?.();
                  },
                }}
              >
                {children}
              </TransformComponent>
              <div className="diagram-overlay">{overlay}</div>
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
