/**
 * The panel over a list: a test, or the code of a function, an endpoint or
 * a step; a test a pull request removed, in a narrow panel, as the diff
 * knows it. On the right on a desk, the whole screen on a phone. Escape,
 * the close button and a click beside it close it; the page under it keeps
 * its place and is inert while it is open (App), and closing it gives the
 * focus back to what opened it.
 */
import { useEffect, useRef, useState } from 'react';
import { titleOf } from '../lib/filter';
import { formatHash, parseCode, withoutPanel, type CodeTarget, type Source } from '../lib/route';
import { codePanel } from '../lib/targets';
import { useApp, useTitle } from './app-context';
import { TestedCodeView } from './CodeRefs';
import { ErrorBoundary } from './ErrorBoundary';
import { RemovedDetail } from './PrMarks';
import { TestDetail } from './TestDetail';
import { Words } from './ui';

/** The code of a function, an endpoint or a step, in the panel. */
function CodeDetail({ target, headingId }: { target: CodeTarget; headingId: string }) {
  const { db, source } = useApp();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [side, setSide] = useState<Source>(source);
  const panel = codePanel(db, target);
  if (panel === undefined) return <p className="note panel-note">このコードはデータにありません。</p>;
  return (
    <article className="detail code-detail">
      <header className="detail-head">
        <h2 id={headingId} className={target.kind === 'fn' ? 'mono code-detail-title' : undefined}>
          {panel.title}
        </h2>
        {panel.subtitle !== undefined && <p className="detail-other code-detail-where">{panel.subtitle}</p>}
        {panel.summary !== undefined && panel.summary !== '' && (
          <p className="code-detail-summary">
            <Words text={panel.summary} />
          </p>
        )}
      </header>
      <TestedCodeView items={panel.items} empty="このコードはデータにありません。" named={target.kind !== 'step'} choice={{ chosen, onChoose: setChosen, side, onSide: setSide }} />
    </article>
  );
}

export function Panel({ test, code }: { test?: string; code?: string }) {
  const { db, view, go } = useApp();
  const id = test ?? code ?? '';
  const entry = test === undefined ? undefined : db.byId.get(test);
  const removed = test === undefined || entry !== undefined ? undefined : db.pr?.removedById.get(test);
  const target = test === undefined ? parseCode(code) : undefined;
  const panel = useRef<HTMLDivElement>(null);
  // Read while rendering, before the page under the panel turns inert and gives up its focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = () => go(withoutPanel(view));

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
      if (event.key === 'Escape') go(withoutPanel(view));
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
      <div className={removed === undefined ? 'panel' : 'panel panel-small'} role="dialog" aria-modal="true" aria-labelledby="panel-title" tabIndex={-1} ref={panel}>
        <div className="panel-bar">
          {removed !== undefined ? (
            <span className="panel-label">この PR で削除されたテスト</span>
          ) : test !== undefined ? (
            <a className="panel-link" href={formatHash({ page: 'test', test })}>
              このテストのページ
            </a>
          ) : (
            <span className="panel-label">コード</span>
          )}
          <button type="button" className="icon-button" aria-label="閉じる" onClick={close}>
            ×
          </button>
        </div>
        <ErrorBoundary reset={id}>
          {test !== undefined ? (
            entry !== undefined ? (
              <TestDetail key={entry.id} entry={entry} headingId="panel-title" />
            ) : removed !== undefined ? (
              <RemovedDetail key={removed.id} test={removed} headingId="panel-title" inPanel />
            ) : (
              <p className="note panel-note">テスト {test} はありません。</p>
            )
          ) : target === undefined ? (
            <p className="note panel-note">このコードはデータにありません。</p>
          ) : (
            <CodeDetail key={id} target={target} headingId="panel-title" />
          )}
        </ErrorBoundary>
      </div>
    </>
  );
}

/** A test on a page of its own (`#/test/<id>`); a test a pull request removed, as the diff knows it. */
export function TestPage() {
  const { db, view, lang } = useApp();
  const entry = view.test === undefined ? undefined : db.byId.get(view.test);
  const removed = view.test === undefined || entry !== undefined ? undefined : db.pr?.removedById.get(view.test);
  useTitle(entry !== undefined ? titleOf(entry, lang) : removed !== undefined ? titleOf(removed, lang) : undefined);
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
      {entry !== undefined ? (
        <TestDetail key={entry.id} entry={entry} />
      ) : removed !== undefined ? (
        <RemovedDetail key={removed.id} test={removed} />
      ) : (
        <p className="note">テスト {view.test} はありません。</p>
      )}
    </div>
  );
}
