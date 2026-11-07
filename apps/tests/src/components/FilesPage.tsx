/**
 * The test files, by the root they belong to (the provider's roots, then the
 * tools), and the page of one file: its tests by describe path beside its
 * code. Choosing a test there marks its lines in that code (on a phone, where
 * the code is below the list, it opens the test over the page instead).
 */
import { useState } from 'react';
import { describeGroups, fileGroups, healthOf, splitPath } from '../lib/data';
import { titleOf } from '../lib/filter';
import { formatCount } from '../lib/format';
import { formatHash, withoutTest } from '../lib/route';
import { NARROW_QUERY, useApp, useTitle } from './app-context';
import { CodeView } from './CodeView';
import { rowOf, Rows } from './TestList';
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
      {groups.map((group, index) => (
        <section key={group.root} className="file-group">
          {index === firstTool && <p className="group-label tools-label">ツールのテスト</p>}
          <details open={!folded}>
            <summary className="file-root">
              <span className="chevron" aria-hidden="true" />
              <h2>{group.root}</h2>
              <span className="muted num">{formatCount(group.count)}</span>
              {group.prefix !== '' && <span className="file-prefix">{group.prefix}</span>}
            </summary>
            <ul className="file-list">
              {group.files.map((file) => {
                const { dir, name } = splitPath(file.path.slice(group.prefix.length));
                return (
                  <li key={file.path}>
                    <a href={formatHash({ page: 'file', file: file.path })}>
                      <span className="file-name">
                        <span className="file-dir">{dir}</span>
                        {name}
                      </span>
                      <span className="num muted">{formatCount(file.count)}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </details>
        </section>
      ))}
    </div>
  );
}

export function FilePage() {
  const { db, view, go, lang } = useApp();
  const path = view.file ?? '';
  const tests = db.byFile.get(path) ?? [];
  const { dir, name } = splitPath(path);
  const chosen = view.test === undefined ? undefined : tests.find((test) => test.id === view.test);
  useTitle(name);
  const failed = tests.filter((test) => test.result === 'failed').length;
  const passed = tests.filter((test) => test.result === 'passed').length;
  const health = healthOf({ failed, passed });
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
      {tests.length === 0 ? (
        <p className="note">このファイルのテストはありません。</p>
      ) : (
        <div className="file-body">
          <div className="file-tests">
            {describeGroups(tests).map((group, index) => (
              <section key={index} className="describe">
                {group.path.length > 0 && <h2 className="describe-path">{group.path.join(' › ')}</h2>}
                <Rows rows={group.tests.map(rowOf)} hideFile />
              </section>
            ))}
          </div>
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
                <button type="button" className="icon-button code-head-close" aria-label="選択を外す" onClick={() => go(withoutTest(view), { replace: true })}>
                  ×
                </button>
              </div>
            )}
            <CodeView path={path} mark={chosen?.lines} fill />
          </div>
        </div>
      )}
    </div>
  );
}
