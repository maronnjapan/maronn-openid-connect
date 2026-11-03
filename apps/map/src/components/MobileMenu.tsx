import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const MOBILE_QUERY = '(max-width: 899px)';
const SECTIONS = ['navigation', 'screen', 'cases', 'diagram', 'callers', 'endpoints'] as const;
const MenuContext = createContext<{ mobile: boolean; target: HTMLDivElement | null; close: () => void }>({
  mobile: false,
  target: null,
  close: () => {},
});

/** Read the shared menu so navigation can return the reader to the diagram. */
export function useMobileMenu() {
  return useContext(MenuContext);
}

/** Keep mobile navigation and settings in a modal above a full-size diagram. */
export function MobileMenu({ children }: { children: ReactNode }) {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const dialogId = useId();
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => {
      setMobile(media.matches);
      setOpen(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (mobile && open) element?.showModal();
    else element?.close();
  }, [mobile, open]);

  return (
    <MenuContext value={{ mobile, target, close }}>
      {children}
      {mobile ? (
        <>
          <button type="button" className="icon mobile-menu-toggle" aria-label="メニューを開く" aria-expanded={open} aria-controls={dialogId} onClick={() => setOpen(true)}>☰</button>
          <dialog
            ref={dialog}
            id={dialogId}
            className="mobile-menu"
            aria-labelledby={titleId}
            onCancel={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
            onClick={(event) => {
              if (event.target !== event.currentTarget) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setOpen(false);
            }}
          >
            <div className="drawer-layout">
              <header className="panel-head drawer-head">
                <h2 id={titleId}>メニュー・表示設定</h2>
                <button type="button" className="icon" aria-label="メニューを閉じる" onClick={() => setOpen(false)}>×</button>
              </header>
              <div ref={setTarget} className="mobile-menu-content">
                {SECTIONS.map((section) => <div key={section} className="mobile-menu-section" data-menu-section={section} />)}
              </div>
            </div>
          </dialog>
        </>
      ) : null}
    </MenuContext>
  );
}

/** Move the existing controls into the mobile menu, keeping one copy and their state while the menu is closed. */
export function MobileMenuSection({ section, children }: { section: typeof SECTIONS[number]; children: ReactNode }) {
  const { mobile, target } = useMobileMenu();
  if (!mobile) return children;
  // Fixed slots keep the visual order and the keyboard's tab order the same.
  const slot = target?.querySelector(`[data-menu-section="${section}"]`);
  return slot == null ? null : createPortal(children, slot);
}
