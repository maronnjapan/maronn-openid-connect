import { useEffect, useId, useState, type CSSProperties } from 'react';
import type { MapData, SourceDocument } from '../types';
import { sourceLines, type SourceTarget } from '../lib/source';
import { DetailDrawer } from './DetailDrawer';

type LoadedSource = { url: string; document: SourceDocument } | { url: string; error: string };

/** A modal source viewer: native dialog handles Escape, focus trapping and the inert background. */
export function CodeDrawer({ data, targets, initial, onClose }: {
  data: MapData;
  targets: SourceTarget[];
  initial: string;
  onClose: () => void;
}) {
  const selectId = useId();
  const [selected, setSelected] = useState(initial);
  const [wholeFile, setWholeFile] = useState(false);
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [attempt, setAttempt] = useState(0);
  const target = targets.find((item) => item.id === selected);
  const source = target === undefined ? undefined : data.sources?.[target.file];
  const url = source?.url;
  useEffect(() => {
    if (url === undefined) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const document = await response.json() as SourceDocument;
        if (typeof document?.code !== 'string' || !Array.isArray(document.tokens)) throw new Error('コードの形式が正しくありません');
        if (!controller.signal.aborted) setLoaded({ url, document });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ url, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [url, attempt]);
  const current = loaded?.url === url ? loaded : null;
  const document = current !== null && 'document' in current ? current.document : undefined;
  const code = document?.code;
  const lines = code === undefined ? [] : sourceLines(code, wholeFile ? undefined : target?.start, wholeFile ? undefined : target?.end);
  return (
    <DetailDrawer title="コード" className="code-drawer" closeLabel="コードを閉じる" onClose={onClose}>
      <header className="code-drawer-head">
        <label htmlFor={selectId}>表示するコード</label>
        <select id={selectId} value={selected} onChange={(event) => { setSelected(event.target.value); setWholeFile(false); }}>
          {targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <div className="code-location">
          <p className="where mono">{source?.path}{target?.start !== undefined && !wholeFile ? `:${target.start}–${target.end}` : ''}</p>
          {target?.start !== undefined ? (
            <button type="button" className="link" onClick={() => setWholeFile(!wholeFile)}>{wholeFile ? '関数だけを見る' : 'ファイル全体を見る'}</button>
          ) : null}
        </div>
        <p className="note">リポジトリのソースです。機能やケースの選択にかかわらず、全機能を含むコードを表示します。</p>
      </header>
      {source === undefined ? <p className="empty" role="alert">このコードは地図のデータに含まれていません。</p>
        : current !== null && 'error' in current ? (
          <div className="empty" role="alert">
            <p>コードを読み込めませんでした: {current.error}</p>
            <button type="button" className="link" onClick={() => { setLoaded(null); setAttempt(attempt + 1); }}>再試行</button>
          </div>
        ) : code === undefined ? <p className="empty" role="status">コードを読み込んでいます…</p>
          : <pre key={`${selected}:${wholeFile}`} className="source-code" style={{ color: document?.foreground, '--source-background': document?.background } as CSSProperties} tabIndex={0} aria-label={`${target?.label} のコード`}><code>{lines.map((line) => (
            <span key={line.number} className="source-line"><span className="source-line-number" aria-hidden="true">{line.number}</span><span>{document?.tokens[line.number - 1]?.map((token, index) => (
              <span key={index} className="source-token" style={{ color: token.color }}>{token.content}</span>
            )) ?? line.text}{'\n'}</span></span>
          ))}</code></pre>}
    </DetailDrawer>
  );
}
