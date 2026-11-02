import type { MapData, OpFlow } from '../types';
import { flagOf, usesOf } from '../lib/model';
import { KindChip, Where } from './Chips';

export interface CallerTreeProps {
  id: string;
  data: MapData;
  flow: OpFlow;
  depth: number;
  seen: Set<string>;
  onOpen: (id: string) => void;
  onStep: (endpoint: string, step: string) => void;
}

/**
 * The functions that call a card, each with the steps that use it; a caller
 * that is the function of a step is not climbed further (the step is where
 * the function is used).
 */
export function CallerTree({ id, data, flow, depth, seen, onOpen, onStep }: CallerTreeProps) {
  const card = data.functions[id];
  if (card === undefined || card.calledBy.length === 0) return null;
  return (
    <ul className="tree">
      {card.calledBy.map((callerId) => {
        const caller = data.functions[callerId];
        if (caller === undefined) {
          return (
            <li key={callerId}>
              <div className="node">
                <span />
                <span className="where">{callerId}</span>
              </div>
            </li>
          );
        }
        const again = seen.has(callerId);
        seen.add(callerId);
        const uses = usesOf(flow, callerId);
        const isStep = uses.some((use) => use.as === 'function');
        return (
          <li key={callerId}>
            <div className="node">
              <span />
              <div className="head">
                <span className="note">←</span>
                <button type="button" className="name" onClick={() => onOpen(caller.id)}>
                  {caller.name}()
                </button>
                <KindChip kind={caller.kind} />
                <Where card={caller} />
                {again ? <span className="note">(above)</span> : null}
              </div>
              {uses.map((use) => (
                <div key={`${use.endpoint.id}/${use.step.id}`} className="text muted">
                  ⇐ {use.as === 'function' ? 'the function of' : 'called by'} step{' '}
                  <button type="button" className="name" onClick={() => onStep(use.endpoint.id, use.step.id)}>
                    [{use.step.id}] of {use.endpoint.methods.join('|')} {use.endpoint.path}
                  </button>{' '}
                  ({flagOf(data.features, use.step.feature ?? use.endpoint.feature)})
                </div>
              ))}
            </div>
            {!again && !isStep && depth < 6 ? (
              <CallerTree id={callerId} data={data} flow={flow} depth={depth + 1} seen={seen} onOpen={onOpen} onStep={onStep} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
