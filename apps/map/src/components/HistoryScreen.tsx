import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiffHunk, HistoryData, HistoryEntry, HistoryFileDiff, MapData } from '../types';
import { aiMarkdown, changeUrl, changesOf, commitUrl, dayOf, endpointsReached, entryKey, entryOf, filterEntries, functionCounts, omittedWords, withoutPullRequest, type HistoryFilter } from '../lib/history';
import { codeHash } from '../code/lib';
import { DiffView } from './ChangeParts';
import { useHistory, useHistoryDetail } from './useHistory';

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

/** The diff of a function, or of the changes of a file outside its functions: folded until the reader opens it, so a long change opens at once. */
function DiffFold({ summary, hunks, omitted, open, onToggle }: { summary: ReactNode; hunks: readonly DiffHunk[]; omitted: HistoryFileDiff['omitted']; open: boolean; onToggle: () => void }) {
  return (
    <li className="history-fold">
      <div className="history-fold-head">
        <button type="button" className="icon-text" aria-expanded={open} onClick={onToggle} disabled={hunks.length === 0} title={hunks.length === 0 ? (omitted !== undefined ? omittedWords(omitted) : '差分はありません') : '差分を開く'}>
          <span aria-hidden="true">{hunks.length === 0 ? '·' : open ? '▾' : '▸'}</span>
        </button>
        {summary}
        {hunks.length === 0 && omitted !== undefined ? <span className="note"> {omittedWords(omitted)}（GitHub で読めます）</span> : null}
      </div>
      {open && hunks.length > 0 ? <DiffView hunks={hunks} /> : null}
    </li>
  );
}

/** The buttons that hand a change to an AI: its intent, where it reaches and the diff of the provider's code only, as Markdown copied or saved. */
function AiHandoff({ markdown, name, chosen, onScope, scope, ready }: { markdown: string; name: string; chosen: number; scope: 'all' | 'chosen'; onScope: (scope: 'all' | 'chosen') => void; ready: boolean }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | undefined>(undefined);
  /** Save the Markdown as a file: a link to it made at the click, and let go of once the browser has it. */
  const save = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div className="history-ai" role="group" aria-label="AI に渡す">
      <div className="seg" role="group" aria-label="AI に渡す差分">
        <button type="button" aria-pressed={scope === 'all'} onClick={() => onScope('all')}>
          変更全体
        </button>
        <button type="button" aria-pressed={scope === 'chosen'} onClick={() => onScope('chosen')} disabled={chosen === 0} title={chosen === 0 ? '▸ で差分を開いた関数とファイルだけを渡します' : undefined}>
          開いた差分だけ（{chosen}）
        </button>
      </div>
      <button
        type="button"
        className="code-button"
        disabled={!ready}
        onClick={() => {
          navigator.clipboard
            .writeText(markdown)
            .then(() => setCopied('copied'))
            .catch(() => setCopied('failed'));
        }}
      >
        AI に渡す形でコピー
      </button>
      <button type="button" className="link" disabled={!ready} onClick={save}>
        Markdown で保存
      </button>
      <span className="note" role="status">
        {!ready ? '差分を読み込んでから渡せます。' : copied === 'copied' ? 'コピーしました。' : copied === 'failed' ? 'コピーできませんでした。「Markdown で保存」を使ってください。' : `意図（PR の本文、変更メモ）、届くエンドポイント、OSS が出すコードの差分だけを Markdown にします（${Math.ceil(markdown.length / 1000)} 千字）。`}
      </span>
    </div>
  );
}

/** One change: what it meant, what it did to the provider's code function by function, and where it reaches now. */
function HistoryEntryView({ data, framework, entry: key, history, onOpenEntry, onOpenList, onOpenFunction, onOpenEndpoint }: HistoryScreenProps & { history: HistoryData }) {
  const [allFunctions, setAllFunctions] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [scope, setScope] = useState<'all' | 'chosen'>('all');
  const entry = entryOf(history, key);
  const detail = useHistoryDetail(entry?.detail);
  const diff = detail instanceof Error ? undefined : detail;
  const reached = useMemo(() => (entry === undefined ? [] : endpointsReached(data, data.flows[framework], entry)), [data, framework, entry]);
  const chosen = scope === 'chosen' && opened.size > 0;
  const markdown = useMemo(() => (entry === undefined ? '' : aiMarkdown(history, entry, diff, reached, framework, chosen ? opened : undefined)), [history, entry, diff, reached, framework, chosen, opened]);
  // Another change starts with its diffs folded.
  useEffect(() => {
    setOpened(new Set());
    setScope('all');
  }, [key]);
  /** Open or fold the diff of a function (by id) or of a file's changes outside its functions (by path). */
  const toggle = (place: string) =>
    setOpened((now) => {
      const next = new Set(now);
      if (next.has(place)) next.delete(place);
      else next.add(place);
      return next;
    });
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
  /** The diff of a function of the change: the hunks of its file that change it. */
  const hunksOf = (id: string): { hunks: DiffHunk[]; omitted: HistoryFileDiff['omitted'] } => {
    for (const file of diff?.files ?? []) {
      const fn = file.functions.find((candidate) => candidate.id === id);
      if (fn !== undefined) return { hunks: fn.hunks, omitted: file.omitted };
    }
    return { hunks: [], omitted: undefined };
  };
  const groups = (['added', 'modified', 'removed'] as const).map((status) => ({ status, items: entry.functions.filter((change) => change.status === status) })).filter((group) => group.items.length > 0);
  const outside = (diff?.files ?? []).filter((file) => file.outside.length > 0);
  const dropped = (diff?.files ?? []).filter((file) => file.omitted !== undefined);
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
        <AiHandoff markdown={markdown} name={entry.pr === undefined ? entry.commit.slice(0, 10) : `pr-${entry.pr}`} chosen={opened.size} scope={chosen ? 'chosen' : 'all'} onScope={setScope} ready={entry.detail === undefined || diff !== undefined} />
        {detail instanceof Error ? <p className="note">差分を読み込めませんでした: {detail.message}</p> : entry.detail !== undefined && detail === undefined ? <p className="note">差分を読み込んでいます…</p> : null}
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
            {entry.notes.map((path) => {
              const note = diff?.notes.find((candidate) => candidate.path === path);
              const href = commitUrl(history, entry.commit, path);
              return (
                <details key={path} className="history-note" open={entry.notes.length === 1}>
                  <summary className="mono">{path}</summary>
                  {note === undefined ? null : <pre className="history-body">{note.text.trim()}</pre>}
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
        <section aria-label="変えた関数">
          <h3>変えた関数 {entry.functions.length}</h3>
          {entry.functions.length === 0 ? <p className="note">関数カタログの関数（packages/core などと apps の OP のコード）は変えていません。</p> : <p className="note">▸ で、その関数の差分（OSS が出すコードだけ）を開きます。</p>}
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
                    const { hunks, omitted } = hunksOf(change.id);
                    return (
                      <DiffFold
                        key={change.id}
                        hunks={hunks}
                        omitted={omitted}
                        open={opened.has(change.id)}
                        onToggle={() => toggle(change.id)}
                        summary={
                          <>
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
                          </>
                        }
                      />
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
        {outside.length > 0 ? (
          <section aria-label="関数の外の変更">
            <h3>関数の外の変更（import、型、定数など）</h3>
            <ul className="history-plain">
              {outside.map((file) => (
                <DiffFold key={file.path} hunks={file.outside} omitted={undefined} open={opened.has(file.path)} onToggle={() => toggle(file.path)} summary={<span className="mono">{file.from === undefined ? file.path : `${file.from} → ${file.path}`}</span>} />
              ))}
            </ul>
          </section>
        ) : null}
        {dropped.length > 0 ? (
          <section aria-label="地図に載せなかった差分">
            <h3>地図に載せなかった差分 {dropped.length}</h3>
            <p className="note">差分の多い変更では、ライブラリのファイルを先に、決めた行数まで載せます。残りは GitHub で読めます。</p>
            <ul className="history-plain">
              {dropped.map((file) => (
                <li key={file.path}>
                  <span className="mono">{file.path}</span> <span className="note">{omittedWords(file.omitted)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
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
            変えたファイル {entry.files.length}（+{entry.additions} −{entry.deletions}。テストや文書を含む全部）
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
