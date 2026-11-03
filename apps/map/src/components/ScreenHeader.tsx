import { useId, useState, type ReactNode } from 'react';

const DESCRIPTION_KEY = 'oidc-map-description';

/** Restore the reader's preference, defaulting to a folded description when storage is unavailable. */
function savedExpanded(): boolean {
  try {
    return localStorage.getItem(DESCRIPTION_KEY) === 'expanded';
  } catch {
    return false;
  }
}

/** Show a compact title and an optional description, remembering visibility across pages and visits. */
export function ScreenHeader({ title, children }: { title: ReactNode; children: ReactNode }) {
  const [expanded, setExpanded] = useState(savedExpanded);
  const descriptionId = useId();
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(DESCRIPTION_KEY, next ? 'expanded' : 'collapsed');
    } catch {
      // Without storage the description can still be opened and closed.
    }
  };
  return (
    <header className="screen-head">
      <div className="screen-title">
        <div className="title-row">{title}</div>
        <button type="button" className="description-toggle" aria-expanded={expanded} aria-controls={descriptionId} onClick={toggle}>
          {expanded ? '説明を閉じる' : '説明を表示'}
        </button>
      </div>
      <div id={descriptionId} className="screen-description" hidden={!expanded}>
        {children}
      </div>
    </header>
  );
}
