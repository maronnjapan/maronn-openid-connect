/**
 * The panel of a test over a list: on the right on a desk, the whole screen
 * on a phone. Escape, the close button and a click beside it close it; the
 * page under it keeps its place and is inert while it is open (App), and
 * closing it gives the focus back to what opened it.
 */
import { useEffect, useRef, useState } from 'react';
import { titleOf } from '../lib/filter';
import { formatHash, withoutTest } from '../lib/route';
import { useApp, useTitle } from './app-context';
import { ErrorBoundary } from './ErrorBoundary';
import { TestDetail } from './TestDetail';

export function Panel({ id }: { id: string }) {
  const { db, view, go } = useApp();
  const entry = db.byId.get(id);
  const panel = useRef<HTMLDivElement>(null);
  // Read while rendering, before the page under the panel turns inert and gives up its focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = () => go(withoutTest(view));

  useEffect(() => {
    panel.current?.focus();
    panel.current?.scrollTo({ top: 0 });
  }, [id]);

  useEffect(
    () => () => {
      // The page is no longer inert when this runs (after the commit that removed the panel).
      if (opener !== null && opener.isConnected) opener.focus({ preventScroll: true });
    },
    [opener],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') go(withoutTest(view));
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('panel-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('panel-open');
    };
  }, [go, view]);

  return (
    <>
      <div className="scrim" onClick={close} aria-hidden="true" />
      <div className="panel" role="dialog" aria-modal="true" aria-labelledby="panel-title" tabIndex={-1} ref={panel}>
        <div className="panel-bar">
          <a className="panel-link" href={formatHash({ page: 'test', test: id })}>
            このテストのページ
          </a>
          <button type="button" className="icon-button" aria-label="閉じる" onClick={close}>
            ×
          </button>
        </div>
        <ErrorBoundary reset={id}>{entry === undefined ? <p className="note panel-note">テスト {id} はありません。</p> : <TestDetail entry={entry} headingId="panel-title" />}</ErrorBoundary>
      </div>
    </>
  );
}

/** A test on a page of its own (`#/test/<id>`). */
export function TestPage() {
  const { db, view, lang } = useApp();
  const entry = view.test === undefined ? undefined : db.byId.get(view.test);
  useTitle(entry === undefined ? undefined : titleOf(entry, lang));
  return (
    <div className="page test-page">
      <nav className="crumbs" aria-label="パンくず">
        <a href="#/">ホーム</a>
        {entry !== undefined && (
          <>
            <span aria-hidden="true">›</span>
            <a href={formatHash({ page: 'file', file: entry.file })}>{entry.file}</a>
          </>
        )}
      </nav>
      {entry === undefined ? <p className="note">テスト {view.test} はありません。</p> : <TestDetail entry={entry} />}
    </div>
  );
}
