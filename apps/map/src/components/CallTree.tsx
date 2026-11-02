import { useState } from 'react';
import type { FunctionCard, MapData } from '../types';
import { Chips, KindChip, Where } from './Chips';

interface NodeProps {
  id: string;
  data: MapData;
  depth: number;
  seen: Set<string>;
  onOpen: (id: string) => void;
}

/** One function of the tree: its card, its summary, and (expanded) what it calls. */
function CallNode({ id, data, depth, seen, onOpen }: NodeProps) {
  const card: FunctionCard | undefined = data.functions[id];
  const again = seen.has(id);
  if (!again) seen.add(id);
  const [open, setOpen] = useState(depth < 1 && !again && card !== undefined && card.calls.length > 0);
  if (card === undefined) {
    return (
      <li>
        <div className="node">
          <span />
          <span className="where">{id}</span>
        </div>
      </li>
    );
  }
  const expandable = card.calls.length > 0 && !again;
  return (
    <li>
      <div className="node">
        <button type="button" className="toggle" disabled={!expandable} aria-expanded={open} aria-label={open ? 'collapse' : 'expand'} onClick={() => setOpen(!open)}>
          {expandable ? (open ? '−' : '+') : '·'}
        </button>
        <div className="head">
          <button type="button" className="name" onClick={() => onOpen(card.id)}>
            {card.name}()
          </button>
          <KindChip kind={card.kind} />
          <Where card={card} />
          {again ? <span className="note">(above)</span> : null}
        </div>
        {card.summary ? <div className="text">{card.summary}</div> : null}
        {card.spec || card.throws ? (
          <div className="meta">
            {card.spec ? <Chips items={card.spec} /> : null}
            {card.throws ? <div className="note">throws: {card.throws.join(', ')}</div> : null}
          </div>
        ) : null}
      </div>
      {open ? (
        <ul>
          {card.calls.map((callee) => (
            <CallNode key={callee} id={callee} data={data} depth={depth + 1} seen={seen} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export interface CallTreeProps {
  ids: readonly string[];
  dynamic?: readonly string[];
  data: MapData;
  onOpen: (id: string) => void;
}

/** The functions some ids call, as an expandable tree; the dynamic calls (resolver methods, hooks) listed after. */
export function CallTree({ ids, dynamic = [], data, onOpen }: CallTreeProps) {
  const seen = new Set<string>();
  if (ids.length === 0 && dynamic.length === 0) return <p className="note">calls no function of the catalog</p>;
  return (
    <ul className="tree">
      {ids.map((id) => (
        <CallNode key={id} id={id} data={data} depth={0} seen={seen} onOpen={onOpen} />
      ))}
      {dynamic.map((name) => (
        <li key={name}>
          <div className="node">
            <span />
            <div className="head">
              <span className="chip dyn">{name}</span>
              <span className="note">dynamic: a method of a resolver or a store, or a hook</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
