import { useEffect, useId, useState, type CSSProperties } from 'react';
import type { DiffHunk, MapData, SourceDocument } from '../types';
import { allHunks, type ChangeIndex } from '../lib/changes';
import { sourceLines, type SourceTarget } from '../lib/source';
import { entryOf } from '../lib/trace';
import { DiffView } from './ChangeParts';
import { DetailDrawer } from './DetailDrawer';
import { fetchFrame } from './useFrames';

type LoadedSource = { url: string; document: SourceDocument } | { url: string; error: string };

/**
 * A modal source viewer: the native dialog handles Escape, focus trapping
 * and the inert background. For a frame the pull request changed, the
 * reader switches between its diff and its code as it is now.
 */
export function CodeDrawer({ data, changes, targets, initial, onClose }: {
  data: MapData;
  changes?: ChangeIndex | undefined;
  targets: SourceTarget[];
  initial: string;
  onClose: () => void;
}) {
  const selectId = useId();
  const [selected, setSelected] = useState(initial);
  const [wholeFile, setWholeFile] = useState(false);
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [attempt, setAttempt] = useState(0);
  const changed = changes?.byId.get(selected);
  const [mode, setMode] = useState<'diff' | 'full'>(changed !== undefined && (changed.kind === 'modified' || changed.kind === 'added') ? 'diff' : 'full');
  const [hunks, setHunks] = useState<DiffHunk[] | undefined>(undefined);
  const target = targets.find((item) => item.id === selected) ?? (entryOf(data, selected)?.source === undefined ? undefined : { id: selected, label: selected, ...(entryOf(data, selected)?.source as { file: string; start: number; end: number }) });
  const source = target === undefined ? undefined : data.sources?.[target.file];
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
  const lines = code === undefined ? [] : sourceLines(code, wholeFile ? undefined : target?.start, wholeFile ? undefined : target?.end);
  const showDiff = mode === 'diff' && hunks !== undefined && hunks.length > 0;
  return (
    <DetailDrawer title="コード" className="code-drawer" closeLabel="コードを閉じる" onClose={onClose}>
      <header className="code-drawer-head">
        <label htmlFor={selectId}>表示するコード</label>
        <select
          id={selectId}
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setWholeFile(false);
            const next = changes?.byId.get(event.target.value);
            setMode(next !== undefined && (next.kind === 'modified' || next.kind === 'added') ? 'diff' : 'full');
          }}
        >
          {targets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
          {targets.some((item) => item.id === selected) ? null : <option value={selected}>{target?.label ?? selected}</option>}
        </select>
        <div className="code-location">
          <p className="where mono">
            {source?.path}
            {target?.start !== undefined && !wholeFile ? `:${target.start}–${target.end}` : ''}
          </p>
          {hunks !== undefined && hunks.length > 0 ? (
            <div className="seg" role="group" aria-label="差分と全文">
              <button type="button" aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>
                差分
              </button>
              <button type="button" aria-pressed={mode === 'full'} onClick={() => setMode('full')}>
                変更後の全文
              </button>
            </div>
          ) : null}
          {target?.start !== undefined && !showDiff ? (
            <button type="button" className="link" onClick={() => setWholeFile(!wholeFile)}>
              {wholeFile ? '関数だけを見る' : 'ファイル全体を見る'}
            </button>
          ) : null}
        </div>
        <p className="note">リポジトリのソースです。機能や選んだ道筋にかかわらず、全機能を含むコードを表示します。</p>
      </header>
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
      ) : code === undefined ? (
        <p className="empty" role="status">
          コードを読み込んでいます…
        </p>
      ) : (
        <pre key={`${selected}:${wholeFile}`} className="source-code" style={{ color: document?.foreground, '--source-background': document?.background } as CSSProperties} tabIndex={0} aria-label={`${target?.label} のコード`}>
          <code>
            {lines.map((line) => (
              <span key={line.number} className="source-line">
                <span className="source-line-number" aria-hidden="true">
                  {line.number}
                </span>
                <span>
                  {document?.tokens[line.number - 1]?.map((token, index) => (
                    <span key={index} className="source-token" style={{ color: token.color }}>
                      {token.content}
                    </span>
                  )) ?? line.text}
                  {'\n'}
                </span>
              </span>
            ))}
          </code>
        </pre>
      )}
    </DetailDrawer>
  );
}
