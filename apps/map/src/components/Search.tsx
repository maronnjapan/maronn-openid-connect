import { useEffect, useRef, useState } from 'react';
import type { FlowEndpoint, MapData } from '../types';
import { search, type SearchHit } from '../lib/model';

export interface SearchProps {
  data: MapData;
  endpoints: readonly FlowEndpoint[];
  onPick: (hit: SearchHit) => void;
}

/** Find a step or a function by name. */
export function Search({ data, endpoints, onPick }: SearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const hits = open ? search(data, endpoints, query) : [];
  return (
    <div className="search" ref={box}>
      <input
        id="search"
        type="search"
        placeholder="Search a step or a function…"
        autoComplete="off"
        aria-label="Search a step or a function"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      {open && query.trim().length >= 2 ? (
        <ul>
          {hits.length === 0 ? <li className="note">nothing matches</li> : null}
          {hits.map((hit, index) => (
            <li key={index}>
              <button
                type="button"
                onClick={() => {
                  onPick(hit);
                  setQuery('');
                  setOpen(false);
                }}
              >
                <span className="what">{hit.what}</span>
                <span className="mono">{hit.text}</span>
                <span className="what">{hit.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
