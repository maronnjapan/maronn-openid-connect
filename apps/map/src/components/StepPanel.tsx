import type { FlowEndpoint, FlowStep, MapData } from '../types';
import { frameMark, type ChangeIndex } from '../lib/changes';
import { generatedWhen, locationOf } from '../lib/model';
import { entryOf } from '../lib/trace';
import { Badge } from './ChangeParts';
import { Chips, Description, Facts } from './Parts';

export interface StepPanelProps {
  data: MapData;
  changes: ChangeIndex | undefined;
  endpoint: FlowEndpoint;
  step: FlowStep;
  onOpenFunction: (id: string) => void;
  onOpenCode: (id: string) => void;
}

/**
 * What one step of an endpoint is: its function's behavior (a step of Hono is
 * a function; one of Next.js is a block of the Route Handler), what it reads
 * and passes on, the specification, and how its function fails (read from
 * the trees, not the JSDoc alone).
 */
export function StepPanel({ data, changes, endpoint, step, onOpenFunction, onOpenCode }: StepPanelProps) {
  const card = step.functionId === undefined ? undefined : data.functions[step.functionId];
  const mark = card === undefined ? undefined : frameMark(changes, card.id);
  const failures = card?.failures ?? [];
  return (
    <section className="step-detail" aria-label={`${step.label} — ステップの詳細`}>
      <h3>
        {step.label} {mark !== undefined ? <Badge mark={mark} /> : null}
      </h3>
      {card ? <p className="mono">{card.name}()</p> : <p className="note">Next.js ではこのステップは {step.module ?? 'route.ts'} の 1 ブロックです。</p>}
      {card ? <Description summary={card.summary} description={card.description} /> : null}
      <Facts
        rows={[
          ['受け取る値', <Chips items={step.consumes} mono />],
          ['次へ渡す値', <Chips items={step.produces} mono />],
          step.spec !== undefined && ['仕様', step.spec],
          failures.length > 0 && [
            '失敗するとき',
            <ul className="plain">
              {failures.slice(0, 12).map((failure) => (
                <li key={`${failure.error}@${failure.from}`}>
                  {failure.error}
                  {failure.from !== card?.id ? <span className="muted">（{entryOf(data, failure.from)?.name ?? failure.from} から）</span> : null}
                </li>
              ))}
              {failures.length > 12 ? <li className="muted">ほか {failures.length - 12} 個</li> : null}
            </ul>,
          ],
        ]}
      />
      <div className="detail-actions">
        {card?.source !== undefined || endpoint.source !== undefined ? (
          <button type="button" className="code-button" onClick={() => onOpenCode(card?.source !== undefined ? card.id : (endpoint.source as string))}>
            {card?.source !== undefined ? `${card.name}() のコードを見る` : 'このステップを含むコードを見る'}
          </button>
        ) : null}
        {card ? (
          <button type="button" className="code-button" onClick={() => onOpenFunction(card.id)}>
            {card.name}() を根にして開く
          </button>
        ) : null}
      </div>
      <p className="where">
        {generatedWhen(data.features, step.feature ?? endpoint.feature)}
        <br />
        <span className="mono">{card ? locationOf(card) : (step.module ?? '')}</span>
      </p>
    </section>
  );
}
