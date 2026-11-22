import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HistoryData, HistoryEntry, MapData } from '../types';
import { changeUrl, changesOf, commitUrl, dayOf, endpointsReached, entryKey, entryOf, filterEntries, functionCounts, withoutPullRequest, type HistoryFilter } from '../lib/history';
import { codeHash } from '../code/lib';
import { useHistory } from './useHistory';

/** How a change reached main, in a word. */
function kindWord(entry: HistoryEntry): string {
  if (entry.pr !== undefined) return `#${entry.pr}`;
  return entry.kind === 'merge' ? 'PR なし（マージ）' : 'PR なし';
}

/** The chip of how a change reached main: red when it reached main without a pull request of its own. */
function KindChip({ entry }: { entry: HistoryEntry }) {
  return <span className={`chip${withoutPullRequest(entry) ? ' history-direct' : ''}`}>{entry.kind === 'squash' ? `#${entry.pr}（スカッシュ）` : kindWord(entry)}</span>;
}

/** What the list keeps while the reader reads a change: the filter, how many changes it shows, and how far it was scrolled. */
interface ListState {
  filter: HistoryFilter;
  shown: number;
  scroll: number;
}

/** What a change did to a function. */
const STATUS_WORDS: Record<HistoryEntry['functions'][number]['status'], string> = { added: '追加', modified: '変更', removed: '削除' };

/** What a change did to a file. */
const FILE_WORDS: Record<HistoryEntry['files'][number]['status'], string> = { added: '追加', modified: '変更', deleted: '削除', renamed: '移動' };

/** How many changes the list shows before the reader asks for more. */
const PAGE = 60;

export interface HistoryScreenProps {
  data: MapData;
  framework: string;
  /** '' for the list, else the key of the change shown. */
  entry: string;
  onOpenEntry: (key: string) => void;
  onOpenList: () => void;
  onOpenFunction: (id: string) => void;
  onOpenEndpoint: (id: string) => void;
}

/**
 * The history of main: every change that reached it (a pull request merged
 * or squashed, a commit pushed without one), newest first, and for one
 * change what it did (its pull request's text, its change notes, the
 * functions it added, changed or removed, its commits and files) and which
 * endpoints those functions reach in the map as it is now. It is how the
 * owner traces, after the fact, what a pull request made by an agent
 * implemented.
 */
export function HistoryScreen(props: HistoryScreenProps) {
  const history = useHistory(props.data.history);
  // The list as the reader left it, kept while a change is open, so going back finds it the same.
  const [list, setList] = useState<ListState>({ filter: { query: '', code: false, direct: false }, shown: PAGE, scroll: 0 });
  return (
    <section className="screen changes-screen history-screen" aria-label="変更の履歴">
      {props.data.history === undefined ? (
        <p className="empty">この地図のデータには履歴がありません（git の履歴の無い場所でビルドしました）。</p>
      ) : history instanceof Error ? (
        <p className="empty" role="alert">
          履歴を読み込めませんでした: {history.message}
        </p>
      ) : history === undefined ? (
        <p className="empty" role="status">
          履歴を読み込んでいます…
        </p>
      ) : props.entry === '' ? (
        <HistoryList history={history} state={list} onState={setList} onOpenEntry={props.onOpenEntry} />
      ) : (
        <HistoryEntryView {...props} history={history} />
      )}
    </section>
  );
}

/** The list of the changes, filtered by words, by the changes of code and by the pushes without a pull request. */
function HistoryList({ history, state, onState, onOpenEntry }: { history: HistoryData; state: ListState; onState: (next: ListState) => void; onOpenEntry: (key: string) => void }) {
  const { filter, shown } = state;
  const { query, code, direct } = filter;
  const body = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => filterEntries(history, filter), [history, filter]);
  const pulls = history.entries.filter((entry) => !withoutPullRequest(entry)).length;
  const setFilter = (next: Partial<HistoryFilter>) => onState({ ...state, filter: { ...filter, ...next }, shown: PAGE, scroll: 0 });
  // Back from a change: the list where the reader left it.
  useLayoutEffect(() => {
    if (body.current !== null) body.current.scrollTop = state.scroll;
  }, []);
  return (
    <>
      <header className="screen-head">
        <h2>変更の履歴</h2>
        <p className="lead">main に入った変更を新しい順に並べます。PR ごとに、PR の本文、変更メモ、足した・変えた・消した関数、コミット、ファイルと、その関数が今の地図で届くエンドポイントを読めます。</p>
        <div className="history-filters">
          <label className="wiring-search">
            タイトル・関数・ブランチ・番号で絞る <input value={query} onChange={(event) => setFilter({ query: event.target.value })} type="search" />
          </label>
          <label>
            <input type="checkbox" checked={code} onChange={(event) => setFilter({ code: event.target.checked })} /> 関数を変えたものだけ
          </label>
          <label>
            <input type="checkbox" checked={direct} onChange={(event) => setFilter({ direct: event.target.checked })} /> PR を通さずに入ったものだけ
          </label>
        </div>
        <p className="note">
          {entries.length} 件を表示（全体で {history.entries.length} 件。PR {pulls} 件、PR なし {history.entries.length - pulls} 件）。
          {history.shallow === true ? '浅い clone から作ったので、古い変更が欠けています。' : ''}
        </p>
      </header>
      <div className="changes-body" ref={body}>
        <ul className="links history-list">
          {entries.slice(0, shown).map((entry) => {
            const counts = functionCounts(entry);
            return (
              <li key={entry.commit}>
                <button
                  type="button"
                  className="row"
                  onClick={() => {
                    onState({ ...state, scroll: body.current?.scrollTop ?? 0 });
                    onOpenEntry(entryKey(entry));
                  }}
                >
                  <span className="history-row-head">
                    <span className="mono history-date">{dayOf(entry.date)}</span>
                    <KindChip entry={entry} />
                    <span className="row-title">{entry.title}</span>
                    {entry.carried !== undefined ? <span className="note">（{entry.carried.map((pull) => `#${pull.pr}`).join('、')} を含む）</span> : null}
                  </span>
                  <span className="row-text">
                    {entry.functions.length > 0 ? `関数 追加 ${counts.added}・変更 ${counts.modified}・削除 ${counts.removed} · ` : ''}
                    ファイル {entry.files.length}（+{entry.additions} −{entry.deletions}） · コミット {entry.commits.length}
                    {entry.notes.length > 0 ? ' · 変更メモあり' : ''} · {entry.authors.join('、')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {entries.length > shown ? (
          <button type="button" className="link" onClick={() => onState({ ...state, shown: shown + PAGE })}>
            さらに {Math.min(PAGE, entries.length - shown)} 件を表示
          </button>
        ) : null}
        {entries.length === 0 ? <p className="empty">条件に合う変更はありません。</p> : null}
      </div>
    </>
  );
}

/** One change: what it did, and where it reaches now. */
function HistoryEntryView({ data, framework, entry: key, history, onOpenEntry, onOpenList, onOpenFunction, onOpenEndpoint }: HistoryScreenProps & { history: HistoryData }) {
  const [allFunctions, setAllFunctions] = useState(false);
  const entry = entryOf(history, key);
  const reached = useMemo(() => (entry === undefined ? [] : endpointsReached(data, data.flows[framework], entry)), [data, framework, entry]);
  if (entry === undefined) {
    return (
      <div className="changes-body">
        <button type="button" className="back" onClick={onOpenList}>
          ← 変更の履歴
        </button>
        <p className="empty">この変更（{key}）は履歴にありません。</p>
      </div>
    );
  }
  const index = history.entries.indexOf(entry);
  const newer = history.entries[index - 1];
  const older = history.entries[index + 1];
  const url = changeUrl(history, entry);
  const groups = (['added', 'modified', 'removed'] as const).map((status) => ({ status, items: entry.functions.filter((change) => change.status === status) })).filter((group) => group.items.length > 0);
  let budget = allFunctions ? Number.POSITIVE_INFINITY : 80;
  return (
    <>
      <header className="screen-head">
        <div className="history-nav">
          <button type="button" className="back" onClick={onOpenList}>
            ← 変更の履歴
          </button>
          {newer !== undefined ? (
            <button type="button" className="link" onClick={() => onOpenEntry(entryKey(newer))} title={newer.title}>
              ← 新しい変更
            </button>
          ) : null}
          {older !== undefined ? (
            <button type="button" className="link" onClick={() => onOpenEntry(entryKey(older))} title={older.title}>
              古い変更 →
            </button>
          ) : null}
        </div>
        <h2>{entry.title}</h2>
        <div className="facts-row">
          <KindChip entry={entry} />
          <span className="chip mono">{dayOf(entry.date)}</span>
          {entry.branch !== undefined ? <span className="chip mono">{entry.branch}</span> : null}
          <span className="chip">{entry.authors.join('、')}</span>
          {url !== undefined ? (
            <a className="link" href={url} target="_blank" rel="noopener">
              GitHub で開く ↗
            </a>
          ) : null}
        </div>
        {withoutPullRequest(entry) ? <p className="note">PR を通さずに main に入った{entry.kind === 'merge' ? 'マージ' : 'コミット'}です。この変更そのものは、レビューと地図のコメントを経ていません。</p> : null}
        {entry.boundary === true ? <p className="note">浅い clone の最も古いコミットなので、何を変えたかは分かりません（ファイルと関数を並べません）。</p> : null}
      </header>
      <div className="changes-body">
        {entry.carried !== undefined ? (
          <section aria-label="この変更で main に入った PR">
            <h3>この変更で main に入った PR {entry.carried.length}</h3>
            <p className="note">別のブランチにマージされた PR で、この変更と一緒に main に入りました。変えた関数とコミットは、この変更の分に含まれます。</p>
            {entry.carried.map((pull) => {
              const href = history.repository === undefined ? undefined : `https://github.com/${history.repository}/pull/${pull.pr}`;
              return (
                <details key={pull.pr} className="history-note" open={entry.carried?.length === 1}>
                  <summary>
                    #{pull.pr} {pull.title}
                  </summary>
                  {pull.body === undefined ? <p className="note">この地図のデータには PR の本文がありません。</p> : <pre className="history-body">{pull.body.trim()}</pre>}
                  {href === undefined ? null : (
                    <a className="link small" href={href} target="_blank" rel="noopener">
                      GitHub で開く ↗
                    </a>
                  )}
                </details>
              );
            })}
          </section>
        ) : null}
        <section aria-label="PR の本文">
          <h3>PR の本文</h3>
          {entry.body !== undefined && entry.body.trim() !== '' ? <pre className="history-body">{entry.body.trim()}</pre> : <p className="note">{entry.pr === undefined ? 'PR がありません。下のコミットが、何をしたかの記録です。' : 'この地図のデータには PR の本文がありません（ビルドに MAP_PULLS を渡すと載ります）。'}</p>}
        </section>
        {entry.notes.length > 0 ? (
          <section aria-label="変更メモ">
            <h3>変更メモ</h3>
            <ul className="history-plain">
              {entry.notes.map((path) => {
                const href = commitUrl(history, entry.commit, path);
                return <li key={path}>{href === undefined ? <span className="mono">{path}</span> : <a className="link mono" href={href} target="_blank" rel="noopener">{path} ↗</a>}</li>;
              })}
            </ul>
          </section>
        ) : null}
        <section aria-label="変えた関数">
          <h3>変えた関数 {entry.functions.length}</h3>
          {entry.functions.length === 0 ? <p className="note">関数カタログの関数（packages/core などと apps の OP のコード）は変えていません。</p> : null}
          {groups.map((group) => {
            const items = group.items.slice(0, Math.max(0, budget));
            budget -= items.length;
            if (items.length === 0) return null;
            return (
              <div key={group.status} className="history-group">
                <h4>
                  {STATUS_WORDS[group.status]} {group.items.length}
                </h4>
                <ul className="history-plain">
                  {items.map((change) => {
                    const card = data.functions[change.id];
                    const source = card?.source === undefined ? undefined : data.sources[card.source.file];
                    return (
                      <li key={change.id}>
                        {card !== undefined ? (
                          <button type="button" className="link mono" onClick={() => onOpenFunction(change.id)}>
                            {change.name}()
                          </button>
                        ) : (
                          <span className="mono">{change.name}()</span>
                        )}{' '}
                        <span className="where mono">{change.id.slice(0, change.id.indexOf('#'))}</span>
                        {card === undefined ? <span className="note"> 今の地図には無い</span> : null}
                        {source !== undefined && card?.source !== undefined ? (
                          <>
                            {' '}
                            <a className="link small" href={`./code/#${codeHash({ path: source.path, line: card.source.start, end: card.source.end })}`} target="_blank" rel="noopener">
                              コード ↗
                            </a>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {!allFunctions && entry.functions.length > 80 ? (
            <button type="button" className="link" onClick={() => setAllFunctions(true)}>
              残り {entry.functions.length - 80} 件を表示
            </button>
          ) : null}
        </section>
        <section aria-label="今の地図で届くエンドポイント">
          <h3>今の地図で届くエンドポイント（{framework}）</h3>
          {reached.length === 0 ? (
            <p className="note">変えた関数から届くエンドポイントはありません（関数を変えていないか、変えた関数が今はエンドポイントに届かないか、もう無い）。</p>
          ) : (
            <ul className="links">
              {reached.map((endpoint) => (
                <li key={endpoint.id}>
                  <button type="button" className="row" onClick={() => onOpenEndpoint(endpoint.id)}>
                    <span className="route mono">
                      {endpoint.methods.join(' | ')} {endpoint.path}
                    </span>
                    <span className="row-title">{endpoint.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="コミット">
          <h3>コミット {entry.commits.length}</h3>
          <ol className="history-commits">
            {entry.commits.map((commit) => {
              const href = commitUrl(history, commit.sha);
              return (
                <li key={commit.sha}>
                  <span className="mono history-date">{dayOf(commit.date)}</span> {commit.subject} <span className="note">{commit.author}</span>{' '}
                  {href === undefined ? <span className="mono where">{commit.sha.slice(0, 7)}</span> : <a className="link mono small" href={href} target="_blank" rel="noopener">{commit.sha.slice(0, 7)}</a>}
                </li>
              );
            })}
          </ol>
        </section>
        <details className="history-files">
          <summary>
            変えたファイル {entry.files.length}（+{entry.additions} −{entry.deletions}）
          </summary>
          <ul className="history-plain">
            {entry.files.slice(0, 400).map((file) => (
              <li key={`${file.from ?? ''}>${file.path}`}>
                <span className="chip">{FILE_WORDS[file.status]}</span> <span className="mono">{file.from === undefined ? file.path : `${file.from} → ${file.path}`}</span>{' '}
                <span className="where mono">
                  +{file.additions} −{file.deletions}
                </span>
              </li>
            ))}
          </ul>
          {entry.files.length > 400 ? <p className="note">ほか {entry.files.length - 400} ファイル（GitHub で読めます）。</p> : null}
        </details>
      </div>
    </>
  );
}

/** The changes that touched a function, for a tab of its page: newest first, each opening its change in the history. */
export function FunctionHistory({ data, id, onOpenEntry }: { data: MapData; id: string; onOpenEntry: (key: string) => void }) {
  const history = useHistory(data.history);
  if (data.history === undefined) return <p className="note">この地図のデータには履歴がありません。</p>;
  if (history instanceof Error) return <p className="note">履歴を読み込めませんでした: {history.message}</p>;
  if (history === undefined) return <p className="note">履歴を読み込んでいます…</p>;
  const changes = changesOf(history, id);
  if (changes.length === 0) return <p className="note">main の履歴には、この関数を変えた変更がありません（このブランチで足した関数かもしれません）。</p>;
  return (
    <div className="callers">
      <section>
        <h4>この関数を変えた変更 {changes.length}</h4>
        <ul className="links">
          {changes.map(({ entry, status }) => (
            <li key={entry.commit}>
              <button type="button" className="row" onClick={() => onOpenEntry(entryKey(entry))}>
                <span className="history-row-head">
                  <span className="mono history-date">{dayOf(entry.date)}</span>
                  <KindChip entry={entry} />
                  <span className="chip">{STATUS_WORDS[status]}</span>
                </span>
                <span className="row-title">{entry.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
