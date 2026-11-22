import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CodeIndex, LinkTarget, SourceDocument } from '../types';
import { currentOf, frameAt, frameName, implementationsOf, locationOf, peekOf, startAt, step, visit, type CodeHistory, type CodeLocation, type Peek } from '../lib/links';
import { SourceView } from '../components/SourceView';
import { fileTree, hashOf, locationOfHash, parseCodeHash, searchCode, shownOf, type FileDirectory } from './lib';

/** The root of the map, where its data is (`data/`): the page is served at `code/` under it. */
const ROOT = new URL('../', window.location.href);

type Loaded<T> = { url: string; value: T } | { url: string; error: string };

/** Fetch a JSON file of the data, once per url (a file is fetched again only after an error). */
function useJson<T>(url: string | undefined): T | Error | undefined {
  const [loaded, setLoaded] = useState<Loaded<T> | undefined>(undefined);
  useEffect(() => {
    if (url === undefined) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const value = (await response.json()) as T;
        if (!controller.signal.aborted) setLoaded({ url, value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ url, error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [url]);
  if (loaded === undefined || loaded.url !== url) return undefined;
  return 'error' in loaded ? new Error(loaded.error) : loaded.value;
}

/**
 * The code page: the code of the map's roots read as in an editor. The
 * files on the left (the explorer), Ctrl/⌘ + P to open a file or a
 * function by name, Ctrl/⌘ + click on a name to go to its declaration (on
 * the declaration, its uses or its implementations), back and forward with
 * Alt + ← / →. The place is in the URL (`#<path>:L<line>-L<line>`), so a
 * link from the map or the tests opens the lines it points at.
 */
export function CodePage() {
  const index = useJson<CodeIndex>(new URL('./data/code.json', ROOT).href);
  if (index instanceof Error) {
    return (
      <p className="empty" role="alert">
        コードの索引（data/code.json）を読み込めませんでした: {index.message}。<code>pnpm run build:map</code> でビルドしてください。
      </p>
    );
  }
  if (index === undefined) {
    return (
      <p className="empty" role="status">
        コードの索引を読み込んでいます…
      </p>
    );
  }
  return <CodeReader index={index} />;
}

/** The place the URL names, if the map has its file. */
function hashLocation(index: CodeIndex): CodeLocation | undefined {
  const place = parseCodeHash(window.location.hash);
  return place === undefined ? undefined : locationOfHash(index, place);
}

/** The reader of the code (see CodePage), once the index is loaded. */
function CodeReader({ index }: { index: CodeIndex }) {
  const tree = useMemo(() => fileTree(index), [index]);
  const [history, setHistory] = useState<CodeHistory | undefined>(() => {
    const location = hashLocation(index);
    return location === undefined ? undefined : startAt(location);
  });
  const [missing, setMissing] = useState<string | undefined>(() => (window.location.hash.length > 1 && hashLocation(index) === undefined ? parseCodeHash(window.location.hash)?.path : undefined));
  const [peek, setPeek] = useState<Peek | undefined>(undefined);
  const [explorer, setExplorer] = useState(() => window.matchMedia('(min-width: 900px)').matches);
  const [reveal, setReveal] = useState(0);
  const location = history === undefined ? undefined : currentOf(history);
  const shown = location === undefined ? undefined : shownOf(index, location);
  const source = shown === undefined ? undefined : index.sources[shown.file];
  const document = useJson<SourceDocument>(source === undefined ? undefined : new URL(source.url, ROOT).href);
  const frame = shown?.focus === undefined ? undefined : frameAt(index, shown.file, shown.focus.line);

  /** Go to a place. */
  const go = (next: CodeLocation, list?: Peek) => {
    setHistory((now) => (now === undefined ? startAt(next) : visit(now, next)));
    setPeek(list);
    // Show the place again even when it is the one the reader is at.
    setReveal((count) => count + 1);
    setMissing(undefined);
    if (!window.matchMedia('(min-width: 900px)').matches) setExplorer(false);
  };
  const back = history !== undefined && history.index > 0;
  const forward = history !== undefined && history.index < history.entries.length - 1;
  const move = (by: -1 | 1) => {
    setHistory((now) => (now === undefined ? now : step(now, by)));
    setPeek(undefined);
  };

  // The URL names the place, so it can be shared and reloaded (replaced, not pushed: back and forward are the page's own).
  useEffect(() => {
    if (shown === undefined) return;
    const hash = `#${hashOf(shown)}`;
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }, [shown?.path, shown?.range?.[0], shown?.range?.[1], shown?.focus?.line]);
  // A link followed into the page (or a hash typed) goes there.
  useEffect(() => {
    const follow = () => {
      const next = hashLocation(index);
      if (next === undefined) setMissing(parseCodeHash(window.location.hash)?.path);
      else go(next);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [index]);
  // Alt + ← / → anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** Follow a name: to its declaration, or, on the declaration itself, list its uses or implementations. */
  const follow = (target: LinkTarget, at: { line: number; column: number }) => {
    if (shown !== undefined && target.file === shown.file && target.line === at.line && target.column === at.column) {
      setPeek(peekOf(index, document instanceof Error ? undefined : document, target, at));
      return;
    }
    go(locationOf(index, target), implementationsOf(index, target));
  };

  return (
    <div className="code-page">
      <header className="code-page-bar">
        <button type="button" className="icon" aria-label={explorer ? 'ファイルの一覧を閉じる' : 'ファイルの一覧を開く'} aria-expanded={explorer} onClick={() => setExplorer(!explorer)}>
          ☰
        </button>
        <a className="code-page-title" href="../">
          地図
        </a>
        <span className="code-page-sub">コード</span>
        <div className="code-nav">
          <button type="button" className="nav" disabled={!back} onClick={() => move(-1)} title="戻る（Alt + ←）" aria-label="戻る">
            ←
          </button>
          <button type="button" className="nav" disabled={!forward} onClick={() => move(1)} title="進む（Alt + →）" aria-label="進む">
            →
          </button>
        </div>
        <QuickOpen index={index} onOpen={(next) => go(next)} />
      </header>
      <div className={`code-page-body${explorer ? '' : ' no-explorer'}`}>
        {explorer ? (
          <nav className="code-explorer" aria-label="ファイル">
            <Directory directory={tree} current={shown?.file} onOpen={(id) => go({ id })} depth={0} />
          </nav>
        ) : null}
        <main className="code-editor">
          {shown === undefined ? (
            <Welcome index={index} missing={missing} onOpen={(next) => go(next)} />
          ) : (
            <>
              {missing === undefined ? null : (
                <p className="code-missing" role="alert">
                  {missing} は地図の根のファイルにありません（テストのファイルや、地図が読まないファイルは開けません）。
                </p>
              )}
              <p className="code-crumbs mono">
                {shown.path.split('/').join(' › ')}
                {frame === undefined ? '' : ` › ${frame.name}`}
              </p>
              {document instanceof Error ? (
                <p className="empty" role="alert">
                  コードを読み込めませんでした: {document.message}
                </p>
              ) : document === undefined ? (
                <p className="empty" role="status">
                  コードを読み込んでいます…
                </p>
              ) : (
                <SourceView index={index} document={document} label={`${shown.path} のコード`} range={shown.range} focus={shown.focus} reveal={reveal} onLink={follow} />
              )}
              {peek === undefined ? null : <PeekPanel peek={peek} onOpen={(next) => go(next, peek)} onClose={() => setPeek(undefined)} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/** The list beside the code (the uses of a declaration, the implementations of a member), as an editor's references panel. */
function PeekPanel({ peek, onOpen, onClose }: { peek: Peek; onOpen: (location: CodeLocation) => void; onClose: () => void }) {
  return (
    <section className="code-peek" aria-label={peek.title}>
      <header>
        <h4>{peek.title}</h4>
        <button type="button" className="icon" onClick={onClose} aria-label="一覧を閉じる">
          ×
        </button>
      </header>
      {peek.items.length === 0 ? (
        <p className="note">{peek.empty}</p>
      ) : (
        <ul>
          {peek.items.map((item) => (
            <li key={`${item.location.id}:${item.location.line ?? ''}:${item.location.column ?? ''}`}>
              <button type="button" className="link" onClick={() => onOpen(item.location)}>
                {item.label}
              </button>
              <span className="where mono">{item.where}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A directory of the explorer: open when it holds the file shown, else as the reader left it. */
function Directory({ directory, current, onOpen, depth }: { directory: FileDirectory; current: string | undefined; onOpen: (id: string) => void; depth: number }) {
  const holds = (entry: FileDirectory): boolean => entry.files.some((file) => file.id === current) || entry.directories.some(holds);
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = depth === 0 || (open ?? holds(directory));
  const currentRef = useRef<HTMLButtonElement>(null);
  // A file opened in a directory the reader folded opens the directory again, so the file shows.
  useEffect(() => {
    if (holds(directory)) setOpen(undefined);
  }, [current]);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current, expanded]);
  return (
    <div className="tree-dir">
      {depth === 0 ? null : (
        <button type="button" className="tree-row tree-folder" style={{ paddingLeft: `${depth * 12}px` }} aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
          <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {directory.name}
        </button>
      )}
      {expanded ? (
        <>
          {directory.directories.map((child) => (
            <Directory key={child.path} directory={child} current={current} onOpen={onOpen} depth={depth + 1} />
          ))}
          {directory.files.map((file) => (
            <button
              key={file.id}
              ref={file.id === current ? currentRef : undefined}
              type="button"
              className={`tree-row tree-file${file.id === current ? ' current' : ''}`}
              style={{ paddingLeft: `${(depth + 1) * 12 + 10}px` }}
              aria-current={file.id === current ? 'page' : undefined}
              title={file.path}
              onClick={() => onOpen(file.id)}
            >
              {file.name}
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** The quick open: the files and the functions by name (Ctrl/⌘ + P), opened with Enter or a click. */
function QuickOpen({ index, onOpen }: { index: CodeIndex; onOpen: (location: CodeLocation) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const found = useMemo(() => searchCode(index, query), [index, query]);
  // The list shows while the search has the focus: a click into the code closes it.
  const results = focused ? found : [];
  useEffect(() => {
    document.getElementById(`code-result-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const open = (position: number) => {
    const result = results[position];
    if (result === undefined) return;
    onOpen(result.location);
    setQuery('');
    input.current?.blur();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((now) => Math.max(0, Math.min(results.length - 1, now + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open(active);
    } else if (event.key === 'Escape') {
      setQuery('');
    }
  };
  return (
    <div className="code-search" role="combobox" aria-expanded={results.length > 0} aria-haspopup="listbox" aria-owns="code-results">
      <input
        ref={input}
        type="search"
        value={query}
        placeholder="ファイルや関数の名前で開く（Ctrl/⌘ + P）"
        aria-label="ファイルや関数の名前で開く"
        aria-controls="code-results"
        aria-activedescendant={results.length > 0 ? `code-result-${active}` : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {results.length === 0 ? null : (
        <ul id="code-results" className="code-results" role="listbox">
          {results.map((result, position) => (
            <li
              key={`${result.kind}:${result.location.id}`}
              id={`code-result-${position}`}
              role="option"
              aria-selected={position === active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(position)}
              onClick={() => open(position)}
            >
              <span className="code-result-kind">{result.kind === 'file' ? 'ファイル' : '関数'}</span>
              <span className="code-result-label mono">{result.label}</span>
              <span className="where mono">{result.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the page shows before a file is open: how to open one, and the endpoint bodies to start from. */
function Welcome({ index, missing, onOpen }: { index: CodeIndex; missing: string | undefined; onOpen: (location: CodeLocation) => void }) {
  const bodies = Object.entries(index.frames)
    .filter(([, frame]) => frame.kind === 'body' && frame.source !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return (
    <div className="code-welcome">
      {missing === undefined ? null : (
        <p className="empty" role="alert">
          {missing} は地図の根のファイルにありません（テストのファイルや、地図が読まないファイルは開けません）。
        </p>
      )}
      <p>左の一覧からファイルを、上の検索（Ctrl/⌘ + P）からファイルや関数を開きます。</p>
      <p>コードの名前を Ctrl/⌘ + クリックすると宣言へ移り、宣言の名前では、それを使う場所や実装を並べます。Alt + ← / → で戻る・進む。</p>
      <h4>エンドポイントの処理から読む</h4>
      <ul>
        {bodies.map(([id, frame]) => (
          <li key={id}>
            <button type="button" className="link" onClick={() => onOpen({ id })}>
              {frameName(frame)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
