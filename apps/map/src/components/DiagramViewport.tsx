import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';

/** Keep the existing width fit, with a readable initial scale and space around the graph. */
function fitWidth(view: ReactZoomPanPinchRef, width: number): void {
  const wrapper = view.instance.wrapperComponent;
  if (wrapper === null) return;
  const scale = Math.max(0.1, Math.min(1, (wrapper.clientWidth - 24) / width));
  void view.setTransform(Math.max(12, (wrapper.clientWidth - width * scale) / 2), 12, scale, 0);
}

/**
 * Pan and zoom a diagram with the library's mouse, touch and trackpad
 * gestures. It fits the width again once its box has a size (a diagram that
 * opens in a drawer is measured before the drawer shows).
 */
export function DiagramViewport({ children, controls, width, height }: { children: ReactNode; controls: ReactNode; width: number; height: number }) {
  const start = useRef({ x: 0, y: 0 });
  const moved = useRef(false);
  const [scale, setScale] = useState(1);
  const viewRef = useRef<ReactZoomPanPinchRef | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    let fitted = element.clientWidth > 0;
    const observer = new ResizeObserver(() => {
      if (fitted || element.clientWidth === 0 || viewRef.current === null) return;
      fitted = true;
      fitWidth(viewRef.current, width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
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
        onInit={(view) => fitWidth(view, width)}
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
                  <button type="button" aria-label="図を縮小" disabled={scale <= 0.1} onClick={() => void view.zoomOut(0.25, 0)}>−</button>
                  <button type="button" aria-label="100%で表示" onClick={() => void view.setTransform(12, 12, 1, 0)}>{Math.round(scale * 100)}%</button>
                  <button type="button" aria-label="図を拡大" disabled={scale >= 4} onClick={() => void view.zoomIn(0.25, 0)}>＋</button>
                </div>
                <button type="button" onClick={() => fitWidth(view, width)}>幅に合わせる</button>
                <button type="button" onClick={() => void view.fitToView({ maxScale: 1, animationTime: 0 })}>全体を表示</button>
                <button type="button" onClick={() => fitWidth(view, width)}>表示を戻す</button>
                <span className="note">ドラッグで移動・ピンチで拡大縮小</span>
            </div>
            <TransformComponent
              wrapperClass="diagram-gestures"
              wrapperStyle={{ width: '100%', height: '100%' }}
              contentStyle={{ width, height }}
              wrapperProps={{
                tabIndex: 0,
                role: 'group',
                'aria-label': 'フロー図（矢印キーで移動、＋と−キーで拡大縮小）',
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
