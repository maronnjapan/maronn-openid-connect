/**
 * The header: the title, the source whose endpoints the page shows (on the
 * pages that show endpoints), the search, the language of the titles and a
 * link back to the map. On a phone the header is one row: the search folds
 * into a button that opens it over the header, and the source moves under
 * the page's title.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Lang } from '../lib/filter';
import { HOME, type View } from '../lib/route';
import { Segmented } from './ui';

const LANG_OPTIONS = [
  { value: 'en' as const, label: 'EN' },
  { value: 'ja' as const, label: '日本語' },
];

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Header({ view, lang, onLang, go, source }: { view: View; lang: Lang; onLang: (lang: Lang) => void; go: (view: View, options?: { replace?: boolean }) => void; source?: ReactNode }) {
  const [query, setQuery] = useState(view.page === 'search' ? (view.q ?? '') : '');
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Whether this search pushed the entry of the search page, so emptying the box goes back to where it began.
  const pushed = useRef(false);

  // The box follows the hash: the words of a search page, empty elsewhere.
  useEffect(() => {
    setQuery(view.page === 'search' ? (view.q ?? '') : '');
    if (view.page !== 'search') pushed.current = false;
  }, [view.page, view.q]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // Searching as the reader types: the first letter opens the search page, the next replace it, and an empty box leaves it.
  const search = (words: string) => {
    setQuery(words);
    if (words.trim() === '') {
      if (view.page !== 'search') return;
      if (pushed.current) {
        pushed.current = false;
        window.history.back();
      } else go(HOME, { replace: true });
      return;
    }
    if (view.page !== 'search') pushed.current = true;
    go({ page: 'search', q: words }, { replace: view.page === 'search' });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim() !== '') go({ page: 'search', q: query }, { replace: view.page === 'search' });
    input.current?.blur();
  };
  // The one ×: it empties the box, and on a phone it also folds the search.
  const close = () => {
    if (query !== '') search('');
    setOpen(false);
  };

  return (
    <header className="top">
      <div className="top-inner">
        <a className="brand" href="#/">
          <span className="brand-title">テスト</span>
          <span className="brand-sub">OIDC Provider</span>
        </a>
        {source}
        <div className="top-spacer" />
        <form className={`search${open ? ' search-open' : ''}${query === '' ? ' search-empty' : ''}`} role="search" onSubmit={submit}>
          <span className="search-icon" aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            ref={input}
            type="search"
            placeholder="テストを検索"
            aria-label="テストを検索（タイトル、ファイル）"
            value={query}
            onChange={(event) => search(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
          />
          <button type="button" className="search-close" aria-label={query === '' ? '検索を閉じる' : '検索を消す'} onClick={close}>
            ×
          </button>
        </form>
        <button type="button" className="icon-button search-toggle" aria-label="検索" onClick={() => setOpen(true)}>
          <SearchIcon />
        </button>
        <Segmented label="言語" size="small" options={LANG_OPTIONS} value={lang} onChange={onLang} />
        <a className="map-link" href="../">
          地図
        </a>
      </div>
    </header>
  );
}
