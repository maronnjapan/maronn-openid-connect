import type { ReactNode } from 'react';

/** Short values side by side (the values a step reads, specifications). */
export function Chips({ items, empty = 'なし', mono = false }: { items: readonly string[]; empty?: string; mono?: boolean }) {
  if (items.length === 0) return <span className="muted">{empty}</span>;
  return (
    <span className="chips">
      {items.map((item) => (
        <span key={item} className={`chip${mono ? ' mono' : ''}`}>
          {item}
        </span>
      ))}
    </span>
  );
}

/** What something does: its first line always, the rest of its description on demand, so the diagram keeps the room. */
export function Description({ summary, description }: { summary: string; description?: string | undefined }) {
  return (
    <div className="description">
      <p className="lead">{summary}</p>
      {description ? (
        <details>
          <summary>詳しく</summary>
          <p className="desc">{description}</p>
        </details>
      ) : null}
    </div>
  );
}

/** A labelled list of facts (dl). */
export function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode] | false | undefined> }) {
  const shown = rows.filter((row): row is readonly [string, ReactNode] => Array.isArray(row));
  if (shown.length === 0) return null;
  return (
    <dl className="facts">
      {shown.map(([term, value]) => (
        <div key={term} className="fact">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
