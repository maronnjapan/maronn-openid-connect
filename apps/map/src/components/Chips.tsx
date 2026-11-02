import type { FunctionCard, FunctionKind } from '../types';
import { KINDS } from '../lib/model';

export function KindChip({ kind }: { kind: FunctionKind }) {
  const known = (KINDS as readonly string[]).includes(kind) ? kind : 'other';
  return (
    <span className="chip kind" style={{ ['--k' as string]: `var(--k-${known})` }}>
      {kind}
    </span>
  );
}

export function Chips({ items, className = 'chip' }: { items: readonly string[]; className?: string }) {
  return (
    <div className="chips">
      {items.map((item) => (
        <span key={item} className={className}>
          {item}
        </span>
      ))}
    </div>
  );
}

/** Where a card lives: `root module:line`. */
export function Where({ card }: { card: FunctionCard }) {
  return <span className="where">{`${card.package} ${card.module}:${card.line}`}</span>;
}
