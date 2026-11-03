import { useEffect, useId, useRef, type ReactNode } from 'react';

/** A viewport-height detail view; the native modal keeps focus inside and restores it when closed. */
export function DetailDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      // React may already have detached the dialog, so restore SVG box focus explicitly.
      if (trigger?.isConnected && (trigger instanceof HTMLElement || trigger instanceof SVGElement)) trigger.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="detail-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <div className="drawer-layout">
        <header className="panel-head drawer-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="icon" onClick={onClose} aria-label="詳細を閉じる">
            ×
          </button>
        </header>
        <div className="drawer-content">{children}</div>
      </div>
    </dialog>
  );
}
