import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { DiffHunk, LinkTarget, MapData, SourceDocument } from '../types';
import { allHunks, type ChangeIndex } from '../lib/changes';
import { codeIndexOf, currentOf, locationOf, replace, startAt, step, usesOf, visit, type CodeHistory, type CodeLocation } from '../lib/links';
import { featureSourceLines, type SourceTarget } from '../lib/source';
import { entryOf } from '../lib/trace';
import { DiffView } from './ChangeParts';
import { DetailDrawer } from './DetailDrawer';
import { fetchFrame } from './useFrames';
import { FeatureBadge } from './FeatureBadge';
import { LINK_KIND_WORDS, SourceView } from './SourceView';

type LoadedSource = { url: string; document: SourceDocument } | { url: string; error: string };

/** A list the reader asked for beside the code: the places that use a declaration, or the implementations of a member. */
interface Peek {
  title: string;
  items: Array<{ label: string; where: string; location: CodeLocation }>;
  empty: string;
}

/** What a place of the code shows: a frame offered by the drawer, a frame of the map, or a whole file. */
function targetOf(data: MapData, targets: readonly SourceTarget[], id: string): SourceTarget | undefined {
  const offered = targets.find((item) => item.id === id);
  if (offered !== undefined) return offered;
  const source = entryOf(data, id)?.source;
  if (source !== undefined) {
    const entry = entryOf(data, id);
    const name = entry === undefined ? id : 'endpoint' in entry ? `${entry.name}（エンドポイントの処理）` : `${entry.name}()`;
    return { id, label: `${name} · ${data.sources[source.file]?.path ?? source.file}`, ...(source as { file: string; start: number; end: number }) };
  }
  const file = data.sources[id];
  return file === undefined ? undefined : { id, label: file.path, file: id };
}

/** The implementations of a member of an interface, as places of the code. */
function implementationsOf(data: MapData, target: LinkTarget): Peek | undefined {
  const member = target.member === undefined ? undefined : data.members[target.member];
  if (member === undefined) return undefined;
  return {
    title: `${member.type}.${member.member} の実装`,
    empty: '地図の中に実装はありません。',
    items: (member.implementedBy ?? []).map((id) => {
      const entry = entryOf(data, id);
      const source = entry?.source;
      return { label: entry === undefined ? id : 'endpoint' in entry ? entry.name : `${entry.name}()`, where: source === undefined ? id : `${data.sources[source.file]?.path ?? source.file}:${source.start}`, location: { id } };
    }),
  };
}

/**
 * A modal source viewer: the native dialog handles Escape, focus trapping
 * and the inert background. The reader follows the code as in an editor:
 * Ctrl/⌘ + click on a name goes to its declaration (on the declaration
 * itself, to the places that use it), and back / forward (Alt + ← / →)
 * retrace the steps. For a frame the pull request changed, the reader
 * switches between its diff and its code as it is now.
 */
export function CodeDrawer({ data, changes, targets, initial, onClose }: {
  data: MapData;
  changes?: ChangeIndex | undefined;
  targets: SourceTarget[];
  initial: string;
  onClose: () => void;
}) {
  const selectId = useId();
  const index = useMemo(() => codeIndexOf(data), [data]);
  const [history, setHistory] = useState<CodeHistory>(() => startAt({ id: initial }));
  const [modeChoice, setModeChoice] = useState<{ at: CodeLocation; mode: 'diff' | 'full' } | undefined>(undefined);
  const [peek, setPeek] = useState<Peek | undefined>(undefined);
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [hunks, setHunks] = useState<DiffHunk[] | undefined>(undefined);
  const location = currentOf(history);
  const selected = location.id;
  const wholeFile = location.whole === true;
  const changed = changes?.byId.get(selected);
  // A place reached by a name shows the code; a changed frame opened as it is shows its diff first.
  const mode = modeChoice?.at === location ? modeChoice.mode : location.line === undefined && changed !== undefined && (changed.kind === 'modified' || changed.kind === 'added') ? 'diff' : 'full';
  const target = targetOf(data, targets, selected);
  const source = target === undefined ? undefined : data.sources[target.file];
  const url = source?.url;
  useEffect(() => {
    if (url === undefined) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const document = (await response.json()) as SourceDocument;
        if (typeof document?.code !== 'string' || !Array.isArray(document.tokens)) throw new Error('コードの形式が正しくありません');
        if (!controller.signal.aborted) setLoaded({ url, document });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ url, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [url, attempt]);
  // The diff of a changed frame comes with its frame file.
  const frameUrl = changed === undefined ? undefined : entryOf(data, selected)?.frame;
  useEffect(() => {
    setHunks(undefined);
    if (frameUrl === undefined || frameUrl === '') return;
    let live = true;
    fetchFrame(frameUrl)
      .then((file) => {
        if (live) setHunks(allHunks(file.change));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [frameUrl]);
  const current = loaded?.url === url ? loaded : null;
  const document = current !== null && 'document' in current ? current.document : undefined;
  const code = document?.code;
  const shownStart = wholeFile ? undefined : target?.start;
  const shownEnd = wholeFile ? undefined : target?.end;
  const features = code === undefined ? [] : [...new Set(featureSourceLines(code, document?.features ?? source?.features, shownStart, shownEnd).flatMap((line) => line.features))];
  const showDiff = mode === 'diff' && hunks !== undefined && hunks.length > 0;

  /** Go to a place, closing a list beside the code. */
  const go = (next: CodeLocation, list?: Peek) => {
    setHistory((now) => visit(now, next));
    setPeek(list);
  };
  /** Follow a name of the code: to its declaration, or, on the declaration itself, list the places that use it. */
  const follow = (link: LinkTarget, at: { line: number; column: number }) => {
    if (link.file === target?.file && link.line === at.line && link.column === at.column) {
      const uses = usesOf(index, document, at.line, at.column);
      const implementations = implementationsOf(data, link);
      setPeek(
        implementations !== undefined && implementations.items.length > 0
          ? implementations
          : { title: `${LINK_KIND_WORDS[link.kind]} ${link.name} を使う場所（${uses.length}）`, empty: '地図の根の中で、ほかに使う場所はありません。', items: uses.map((use) => ({ label: use.label, where: `${use.path}:${use.line}`, location: use.location })) },
      );
      return;
    }
    go(locationOf(index, link), implementationsOf(data, link));
  };
  const back = history.index > 0;
  const forward = history.index < history.entries.length - 1;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    setHistory((now) => step(now, event.key === 'ArrowLeft' ? -1 : 1));
    setPeek(undefined);
  };

  return (
    <DetailDrawer title="コード" className="code-drawer" closeLabel="コードを閉じる" onClose={onClose}>
      <div className="code-drawer-body" onKeyDown={onKeyDown}>
        <header className="code-drawer-head">
          <div className="code-nav">
            <button type="button" className="nav" disabled={!back} onClick={() => setHistory((now) => step(now, -1))} title="戻る（Alt + ←）" aria-label="戻る">
              ←
            </button>
            <button type="button" className="nav" disabled={!forward} onClick={() => setHistory((now) => step(now, 1))} title="進む（Alt + →）" aria-label="進む">
              →
            </button>
            <label htmlFor={selectId}>一覧から開く</label>
          </div>
          <select id={selectId} value={targets.some((item) => item.id === selected) ? selected : ''} onChange={(event) => go({ id: event.target.value })}>
            {targets.some((item) => item.id === selected) ? null : <option value="">{target?.label ?? selected}</option>}
            {targets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="code-location">
            <p className="where mono">
              {source?.path}
              {shownStart !== undefined ? `:${shownStart}–${shownEnd}` : location.line !== undefined ? `:${location.line}` : ''}
            </p>
            {hunks !== undefined && hunks.length > 0 ? (
              <div className="seg" role="group" aria-label="差分と全文">
                <button type="button" aria-pressed={mode === 'diff'} onClick={() => setModeChoice({ at: location, mode: 'diff' })}>
                  差分
                </button>
                <button type="button" aria-pressed={mode === 'full'} onClick={() => setModeChoice({ at: location, mode: 'full' })}>
                  変更後の全文
                </button>
              </div>
            ) : null}
            {target?.start !== undefined && !showDiff ? (
              <button type="button" className="link" onClick={() => setHistory((now) => replace(now, { ...location, whole: !wholeFile }))}>
                {wholeFile ? '関数だけを見る' : 'ファイル全体を見る'}
              </button>
            ) : null}
          </div>
          <p className="note">名前を Ctrl/⌘ + クリック（タッチではタップ）で宣言へ移ります。宣言の名前では、それを使う場所を並べます。リポジトリのソースで、機能や選んだ道筋にかかわらず全機能を含みます。</p>
          {!showDiff && features.length > 0 ? (
            <div className="source-features">
              <span className="note">左線と機能名で、その機能の実装の範囲を示します。</span>
              {features.map((feature) => <FeatureBadge key={feature} features={data.features} feature={feature} />)}
            </div>
          ) : null}
        </header>
        {peek === undefined ? null : (
          <section className="code-peek" aria-label={peek.title}>
            <header>
              <h4>{peek.title}</h4>
              <button type="button" className="icon" onClick={() => setPeek(undefined)} aria-label="一覧を閉じる">
                ×
              </button>
            </header>
            {peek.items.length === 0 ? (
              <p className="note">{peek.empty}</p>
            ) : (
              <ul>
                {peek.items.map((item) => (
                  <li key={`${item.location.id}:${item.location.line ?? ''}:${item.location.column ?? ''}`}>
                    <button type="button" className="link" onClick={() => go(item.location, peek)}>
                      {item.label}
                    </button>
                    <span className="where mono">{item.where}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {showDiff ? (
          <div className="drawer-diff">
            <DiffView hunks={hunks} />
          </div>
        ) : source === undefined ? (
          <p className="empty" role="alert">
            このコードは地図のデータに含まれていません。
          </p>
        ) : current !== null && 'error' in current ? (
          <div className="empty" role="alert">
            <p>コードを読み込めませんでした: {current.error}</p>
            <button
              type="button"
              className="link"
              onClick={() => {
                setLoaded(null);
                setAttempt(attempt + 1);
              }}
            >
              再試行
            </button>
          </div>
        ) : document === undefined ? (
          <p className="empty" role="status">
            コードを読み込んでいます…
          </p>
        ) : (
          <SourceView
            index={index}
            document={document}
            label={`${target?.label} のコード`}
            start={shownStart}
            end={shownEnd}
            focus={location.line === undefined ? undefined : { line: location.line, column: location.column, length: location.length }}
            onLink={follow}
          />
        )}
      </div>
    </DetailDrawer>
  );
}
