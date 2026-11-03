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
}

/**
 * Pan and zoom a diagram with the library's mouse, touch and trackpad
 * gestures (the wheel pans; it does not zoom). The diagram opens at the
 * view `opening` gives, once its area has a size (a diagram that opens in a
 * drawer is measured before the drawer shows), and never refits on its own
 * after that, so the reader's zoom stays. A new reveal key pans the box it
 * names into view at the same scale.
 */
export function DiagramViewport({ children, controls, width, height, opening, reveal }: DiagramViewportProps) {
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
        onTransform={(_, state) => setScale(state.scale)}
        onPanningStart={({ state }) => {
          start.current = { x: state.positionX, y: state.positionY };
          moved.current = false;
        }}
        onPanning={({ state }) => {
          if (Math.hypot(state.positionX - start.current.x, state.positionY - start.current.y) > 4) moved.current = true;
        }}
        onPinchStart={() => { moved.current = true; }}
      >
        {(view) => (
          <>
            <div className="diagram-tools" role="group" aria-label="図の表示操作">
              {controls}
              <div className="diagram-zoom">
                <button type="button" aria-label="図を縮小" title="図を縮小" disabled={scale <= 0.1} onClick={() => void view.zoomOut(0.25, 0)}>−</button>
                <button type="button" aria-label="100%で表示" title="100%で表示" onClick={() => void view.setTransform(12, 12, 1, 0)}>{Math.round(scale * 100)}%</button>
                <button type="button" aria-label="図を拡大" title="図を拡大" disabled={scale >= 4} onClick={() => void view.zoomIn(0.25, 0)}>＋</button>
              </div>
              <button type="button" aria-label="幅に合わせる" title="幅に合わせる" onClick={() => fitWidth(view, width)}>幅</button>
              <button type="button" aria-label="全体を表示" title="全体を表示" onClick={() => void view.fitToView({ maxScale: 1, animationTime: 0 })}>全体</button>
              <button type="button" aria-label="表示を戻す（開いたときの倍率と位置）" title="表示を戻す（開いたときの倍率と位置）" onClick={() => applyOpening(view, openingRef.current)}>戻す</button>
            </div>
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
                  // A drag ending over a box must not open its detail or navigate.
                  // Keyboard-generated clicks remain available after a gesture.
                  if (moved.current && event.detail !== 0) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                },
              }}
            >
              {children}
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
