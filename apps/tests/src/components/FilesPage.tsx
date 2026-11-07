/**
 * The test files, by the root they belong to (the provider's roots, then the
 * tools), and the page of one file: its tests by describe path beside its
 * code. Choosing a test there marks its lines in that code (on a phone, where
 * the code is below the list, it opens the test over the page instead).
 *
 * In the build of a pull request each root and each file says how many of
 * its tests it added, changed and removed (on a phone, where the roots start
 * folded, a root with changes starts open), a file whose every test it
 * removed is listed too, and the page of a file has its removed tests where
 * they were.
 */
import { useMemo, useState } from 'react';
import { describeGroups, fileGroups, healthOf, splitPath } from '../lib/data';
import { titleOf } from '../lib/filter';
import { formatCount } from '../lib/format';
import { changedTotal, prCounts, removedOfFile, sumCounts } from '../lib/pr';
import { formatHash, withoutPanel } from '../lib/route';
import { NARROW_QUERY, useApp, useTitle } from './app-context';
import { CodeView } from './CodeView';
import { ChangedToggle, PrCountsText } from './PrMarks';
import { rowOf, Rows, useChangedOnly, withRemoved } from './TestList';
import { StatusIcon } from './ui';

/** Whether the window is a phone's, where the roots start folded so the page opens as a short list of roots. */
function narrow(): boolean {
  try {
    return window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

export function FilesPage() {
  const { db } = useApp();
  const groups = fileGroups(db);
  const [folded] = useState(narrow);
  useTitle('ファイル');
  const firstTool = groups.findIndex((group) => group.tool);
  return (
    <div className="page files">
      <header className="page-head">
        <h1>ファイル</h1>
        <p className="lede">
          <span className="num">{formatCount(db.byFile.size)}</span> ファイル · <span className="num">{formatCount(db.index.tests.length)}</span> テスト
        </p>
      </header>
      {groups.map((group, index) => {
        const changes = group.files.map((file) => ({
          path: file.path,
          counts: db.pr === undefined ? undefined : prCounts(db.pr, (db.byFile.get(file.path) ?? []).map((test) => test.id), removedOfFile(db.pr, file.path)),
        }));
        const total = db.pr === undefined ? undefined : sumCounts(changes.flatMap((file) => (file.counts === undefined ? [] : [file.counts])));
        // On a phone the roots start folded, but those the pull request changed open, so its changes show at once.
        const open = !folded || (total !== undefined && changedTotal(total) > 0);
        return (
          <section key={group.root} className="file-group">
            {index === firstTool && <p className="group-label tools-label">ツールのテスト</p>}
            <details open={open}>
              <summary className="file-root">
                <span className="chevron" aria-hidden="true" />
                <h2>{group.root}</h2>
                <span className="muted num">{formatCount(group.count)}</span>
                {total !== undefined && <PrCountsText counts={total} className="file-root-pr" label="PR" />}
                {group.prefix !== '' && <span className="file-prefix">{group.prefix}</span>}
              </summary>
              <ul className="file-list">
                {group.files.map((file, fileIndex) => {
                  const { dir, name } = splitPath(file.path.slice(group.prefix.length));
                  const counts = changes[fileIndex]?.counts;
                  return (
                    <li key={file.path}>
                      <a href={formatHash({ page: 'file', file: file.path })}>
                        <span className="file-name">
                          <span className="file-dir">{dir}</span>
                          {name}
                        </span>
                        {/* Beside the name, on its first line, not under it. */}
                        {counts !== undefined && <PrCountsText counts={counts} className="file-pr" />}
                        <span className="file-count num muted">{formatCount(file.count)}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </details>
          </section>
        );
      })}
    </div>
  );
}

export function FilePage() {
  const { db, view, go, lang } = useApp();
  const path = view.file ?? '';
  const tests = useMemo(() => db.byFile.get(path) ?? [], [db, path]);
  const removed = useMemo(() => removedOfFile(db.pr, path), [db, path]);
  const { dir, name } = splitPath(path);
  const chosen = view.test === undefined ? undefined : tests.find((test) => test.id === view.test);
  const changedOnly = useChangedOnly();
  useTitle(name);
  const failed = tests.filter((test) => test.result === 'failed').length;
  const passed = tests.filter((test) => test.result === 'passed').length;
  const health = healthOf({ failed, passed });
  // The rows of the file in the order of its lines, the removed among them; with the switch on, the changed alone.
  const rows = withRemoved(tests.filter(changedOnly.keep).map(rowOf), removed);
  const changes = tests.filter(changedOnly.changed).length + removed.length;
  const gone = tests.length === 0 && removed.length > 0 && db.index.sources[path] === undefined;
  return (
    <div className="page file">
      <nav className="crumbs" aria-label="パンくず">
        <a href={formatHash({ page: 'files' })}>ファイル</a>
        {tests[0] !== undefined && (
          <>
            <span aria-hidden="true">›</span>
            <span>{tests[0].root}</span>
          </>
        )}
      </nav>
      <header className="page-head">
        <h1 className="mono file-title">{name}</h1>
        <p className="file-dir-line mono">{dir}</p>
        <p className="lede">
          テスト <span className="num">{formatCount(tests.length)}</span>
          {tests.length > 0 && (
            <span className={`health-text health-text-${health}`}>
              <span aria-hidden="true">{health === 'failed' ? '✗' : health === 'passed' ? '✓' : '–'}</span>
              {health === 'failed' ? `${formatCount(failed)} 件失敗` : health === 'passed' ? 'すべて成功' : '結果なし'}
            </span>
          )}
        </p>
      </header>
      {tests.length + removed.length === 0 ? (
        <p className="note">このファイルのテストはありません。</p>
      ) : (
        <div className="file-body">
          <div className="file-tests">
            {db.pr !== undefined && (
              <div className="filters">
                <ChangedToggle count={changes} />
              </div>
            )}
            {rows.length === 0 && <p className="note list-empty">{changedOnly.on ? 'この PR で変わったテストはありません' : '該当するテストはありません'}</p>}
            {describeGroups(rows).map((group, index) => (
              <section key={`${index}:${changedOnly.on}`} className="describe">
                {group.path.length > 0 && <h2 className="describe-path">{group.path.join(' › ')}</h2>}
                <Rows rows={group.tests} hideFile />
              </section>
            ))}
          </div>
          {gone ? (
            <p className="note file-gone">この PR でこのファイルのテストはすべて削除されました。コードはありません。</p>
          ) : (
            <div className="file-code">
              {chosen !== undefined && (
                <div className="code-head">
                  <StatusIcon status={chosen.result} />
                  <span className="code-head-title" title={titleOf(chosen, lang)}>
                    {titleOf(chosen, lang)}
                  </span>
                  <a className="code-head-link" href={formatHash({ page: 'test', test: chosen.id })}>
                    詳細
                  </a>
                  <button type="button" className="icon-button code-head-close" aria-label="選択を外す" onClick={() => go(withoutPanel(view), { replace: true })}>
                    ×
                  </button>
                </div>
              )}
              <CodeView path={path} mark={chosen?.lines} fill />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
