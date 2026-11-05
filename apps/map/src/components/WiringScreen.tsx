import { useMemo, useState } from 'react';
import type { MapData, WiringEntry } from '../types';
import { sourceOf } from '../lib/trace';

const KINDS: Record<WiringEntry['kind'], string> = {
  middleware: 'ミドルウェア・フック登録',
  context: 'コンテキストへの配線',
  callback: 'コールバック',
  initialization: 'モジュール初期化',
};

/** Show wiring the source contains even when no typed path establishes its endpoint destination. */
export function WiringScreen({ data, framework, onOpenFunction }: { data: MapData; framework: string; onOpenFunction: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const source = sourceOf(framework);
  const entries = useMemo(() => (data.wiring ?? []).filter((entry) => {
    if ((entry.file.startsWith('hono:') || entry.file.startsWith('apps/hono/')) && source !== 'hono') return false;
    if ((entry.file.startsWith('nextjs:') || entry.file.startsWith('apps/nextjs/')) && source !== 'nextjs') return false;
    return `${data.sources[entry.file]?.path ?? entry.file} ${entry.code} ${entry.why ?? ''} ${entry.target ?? ''}`.toLowerCase().includes(query.toLowerCase());
  }), [data, source, query]);
  const files = new Map<string, WiringEntry[]>();
  for (const entry of entries) files.set(entry.file, [...(files.get(entry.file) ?? []), entry]);
  return (
    <section className="screen changes-screen" aria-label="追えない配線">
      <header className="screen-head">
        <h2>追えない配線</h2>
        <p className="lead">型と呼び出しから、届くエンドポイントを確定できない配線です。登録先や構築元が分かっても、実行する順序や届く先を推測して呼び出しの経路に加えません。</p>
        <label className="wiring-search">ファイル・コード・理由で絞る <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" /></label>
        <p className="note">{files.size} ファイル・{entries.length} 箇所。選んだフレームワークのアプリと共有パッケージを表示しています。機能のオン・オフによる除去は確定していません。</p>
      </header>
      <div className="wiring-files">
        {[...files].map(([file, items]) => (
          <details key={file} className="wiring-file">
            <summary><code>{data.sources[file]?.path ?? file}</code> <span className="count">{items.length}</span></summary>
            <ul className="change-list">
              {items.map((entry) => (
                <li key={entry.id} className="change-row">
                  <p><span className="chip">{KINDS[entry.kind]}</span> <span className="mono">行 {entry.lines[0]}–{entry.lines[1]}</span></p>
                  <pre className="wiring-code"><code>{entry.code}</code></pre>
                  <p className="note">追えない理由: {entry.why}</p>
                  {entry.target !== undefined && data.functions[entry.target] !== undefined ? <button type="button" className="link mono" onClick={() => onOpenFunction(entry.target as string)}>参照先: {entry.target}</button> : entry.target !== undefined ? <p className="mono">参照先: {entry.target}</p> : null}
                </li>
              ))}
            </ul>
          </details>
        ))}
        {entries.length === 0 ? <p className="empty">条件に合う配線はありません。</p> : null}
      </div>
    </section>
  );
}
