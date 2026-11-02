import type { FlowEndpoint, FlowStep, MapData } from '../types';
import { generatedWhen, locationOf, memberOfCall } from '../lib/model';
import { Chips, Description, Facts } from './Parts';

export interface StepPanelProps {
  data: MapData;
  endpoint: FlowEndpoint;
  step: FlowStep;
  onClose: () => void;
  onOpenFunction: (id: string) => void;
}

interface CallRow {
  key: string;
  name: string;
  /** What the call does: the comment above it, else the summary of the callee. */
  text: string;
  fn?: string;
}

/** The calls a step makes, in the order they run: from the flow of its function, else from its calls (a block of a Next.js Route Handler). */
function callsOf(data: MapData, step: FlowStep): CallRow[] {
  const card = step.functionId === undefined ? undefined : data.functions[step.functionId];
  const rows: CallRow[] = [];
  const members = new Set<string>();
  if (card?.flow !== undefined) {
    for (const node of card.flow.nodes) {
      if (node.kind === 'call' && node.callee !== undefined) {
        rows.push({ key: node.id, name: `${node.label}()`, text: node.note ?? data.functions[node.callee]?.summary ?? '', fn: node.callee });
      } else if (node.kind === 'dynamic' && node.member !== undefined) {
        members.add(node.member);
        rows.push({ key: node.id, name: `${node.label}()`, text: node.note ?? data.members[node.member]?.summary ?? '' });
      }
    }
  } else {
    for (const id of step.calls) {
      const callee = data.functions[id];
      rows.push({ key: id, name: `${callee?.name ?? id}()`, text: callee?.summary ?? '', fn: id });
    }
  }
  // The calls the meta names beside the source (through a hook), unless the flow already shows them.
  for (const call of step.dynamicCalls ?? []) {
    const id = data.memberOfCall[call];
    if (id !== undefined && members.has(id)) continue;
    rows.push({ key: call, name: `${call}()`, text: memberOfCall(data, call)?.summary ?? '' });
  }
  return rows;
}

/** What one step of an endpoint does: its function's behavior, what it reads and passes on, how it fails, and what it calls. */
export function StepPanel({ data, endpoint, step, onClose, onOpenFunction }: StepPanelProps) {
  const card = step.functionId === undefined ? undefined : data.functions[step.functionId];
  const calls = callsOf(data, step);
  return (
    <aside className="side-panel" aria-label="ステップの詳細">
      <div className="panel-head">
        <h3>{step.label}</h3>
        <button type="button" className="icon" onClick={onClose} aria-label="ステップの詳細を閉じる">
          ×
        </button>
      </div>
      {card ? (
        <Description summary={card.summary} description={card.description} />
      ) : (
        <p className="note">Next.js ではこのステップは {step.module ?? 'route.ts'} の 1 ブロックです。下はそのブロックが呼ぶ関数です。</p>
      )}
      <Facts
        rows={[
          ['受け取る値', <Chips items={step.consumes} mono />],
          ['次へ渡す値', <Chips items={step.produces} mono />],
          step.spec !== undefined && ['仕様', step.spec],
          card?.throws !== undefined && [
            '失敗するとき',
            <ul className="plain">
              {card.throws.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>,
          ],
        ]}
      />
      <section>
        <h4>中で行うこと（実行順）</h4>
        {calls.length > 0 ? (
          <ol className="calls">
            {calls.map((row) => (
              <li key={row.key}>
                {row.fn !== undefined ? (
                  <button type="button" className="link mono" onClick={() => onOpenFunction(row.fn as string)}>
                    {row.name}
                  </button>
                ) : (
                  <span className="mono">{row.name}</span>
                )}
                {row.text ? <span className="call-text">{row.text}</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">ほかの関数を呼ばずに処理を終えます。</p>
        )}
      </section>
      {card ? (
        <button type="button" className="primary" onClick={() => onOpenFunction(card.id)}>
          {card.name}() の処理の流れと呼び出し元を開く
        </button>
      ) : null}
      <p className="where">
        {generatedWhen(data.features, step.feature ?? endpoint.feature)}
        <br />
        <span className="mono">{card ? locationOf(card) : (step.module ?? '')}</span>
      </p>
    </aside>
  );
}
