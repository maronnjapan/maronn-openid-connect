import type { FlowEndpoint, FlowStep, FunctionCard, MapData, OpFlow } from '../types';
import { flagOf, markerOf, usesOf } from '../lib/model';
import { CallTree } from './CallTree';
import { CallerTree } from './CallerTree';
import { Chips, KindChip } from './Chips';

export interface DetailPanelProps {
  data: MapData;
  framework: string;
  flow: OpFlow;
  endpoint: FlowEndpoint | undefined;
  step: FlowStep | undefined;
  fn: FunctionCard | undefined;
  onOpenFunction: (id: string) => void;
  onOpenStep: (endpoint: string, step: string) => void;
  onBack: () => void;
}

function Card({ card, children }: { card: FunctionCard; children?: React.ReactNode }) {
  return (
    <div className="card">
      <h3>
        <code>{card.name}()</code>
      </h3>
      <div className="chips">
        <KindChip kind={card.kind} />
        <span className="chip pkg">{`${card.package} ${card.module}:${card.line}`}</span>
        <span className="chip">{card.exported ? 'exported' : 'not exported'}</span>
      </div>
      {card.summary ? <p className="summary">{card.summary}</p> : <p className="summary muted">No JSDoc above this function.</p>}
      {card.description ? <p className="desc">{card.description}</p> : null}
      {card.spec ? <Chips items={card.spec} /> : null}
      {card.throws ? <div className="note">throws: {card.throws.join(', ')}</div> : null}
      {children}
    </div>
  );
}

function StepDetail({ data, endpoint, step, onOpenFunction, onBack }: { data: MapData; endpoint: FlowEndpoint; step: FlowStep; onOpenFunction: (id: string) => void; onBack: () => void }) {
  const position = endpoint.steps.findIndex((candidate) => candidate.id === step.id);
  const before = endpoint.steps[position - 1];
  const after = endpoint.steps[position + 1];
  const card = step.functionId === undefined ? undefined : data.functions[step.functionId];
  return (
    <>
      <div className="crumbs">
        <button type="button" onClick={onBack}>
          {endpoint.id}
        </button>
        <span>›</span>
        <span>{step.id}</span>
      </div>
      <div className="marker">{`// ${markerOf(step, data.features)}`}</div>
      <dl className="kv">
        <dt>endpoint</dt>
        <dd>
          <code>
            {endpoint.methods.join('|')} {endpoint.path}
          </code>
        </dd>
        <dt>kind</dt>
        <dd>
          <KindChip kind={step.kind} />
        </dd>
        <dt>reads</dt>
        <dd>{step.consumes.length > 0 ? step.consumes.join(', ') : '—'}</dd>
        <dt>defines</dt>
        <dd>{step.produces.length > 0 ? step.produces.join(', ') : '—'}</dd>
        <dt>pipeline</dt>
        <dd>
          <code>{`${before ? `[${before.id}]` : '(first)'} → [${step.id}] → ${after ? `[${after.id}]` : '(last)'}`}</code>
        </dd>
        <dt>module</dt>
        <dd>
          <code>{step.module ?? '—'}</code>
        </dd>
        <dt>generated</dt>
        <dd>
          {flagOf(data.features, step.feature ?? endpoint.feature)}
          {step.removable ? ' · removable with --flow' : ''}
        </dd>
      </dl>
      {card ? (
        <Card card={card}>
          <div>
            <button type="button" className="name" onClick={() => onOpenFunction(card.id)}>
              where else is this function used?
            </button>
          </div>
        </Card>
      ) : (
        <div className="card">
          <h3>
            <code>{step.function}()</code>
          </h3>
          <p className="summary muted">A block of {step.module ?? 'the Route Handler'} in the Next.js output: the marker line opens it, the next marker closes it.</p>
        </div>
      )}
      <div>
        <h2>Calls, down to core</h2>
        <CallTree ids={step.calls} dynamic={step.dynamicCalls} data={data} onOpen={onOpenFunction} />
      </div>
    </>
  );
}

function FunctionDetail({ data, framework, flow, card, endpoint, step, onOpenFunction, onOpenStep, onBack }: { data: MapData; framework: string; flow: OpFlow; card: FunctionCard; endpoint: FlowEndpoint | undefined; step: FlowStep | undefined; onOpenFunction: (id: string) => void; onOpenStep: (endpoint: string, step: string) => void; onBack: () => void }) {
  const uses = usesOf(flow, card.id);
  return (
    <>
      <div className="crumbs">
        {endpoint ? (
          <button type="button" onClick={onBack}>
            back to {endpoint.id}
            {step ? `/${step.id}` : ''}
          </button>
        ) : null}
      </div>
      <Card card={card} />
      <div>
        <h2>Used by steps of {framework}</h2>
        {uses.length > 0 ? (
          <div className="uses">
            {uses.map((use) => (
              <button key={`${use.endpoint.id}/${use.step.id}`} type="button" onClick={() => onOpenStep(use.endpoint.id, use.step.id)}>
                <strong>[{use.step.id}]</strong> {use.as === 'function' ? 'is this function' : 'calls it'} · {use.endpoint.methods.join('|')} {use.endpoint.path}
                <br />
                <span className="note">
                  {flagOf(data.features, use.step.feature ?? use.endpoint.feature)}
                  {use.step.module ? ` · ${use.step.module}` : ''}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="note">No step of this framework calls it directly; see the callers below.</p>
        )}
      </div>
      <div>
        <h2>Calls</h2>
        <CallTree ids={card.calls} data={data} onOpen={onOpenFunction} />
      </div>
      <div>
        <h2>Called by</h2>
        {card.calledBy.length > 0 ? (
          <CallerTree id={card.id} data={data} flow={flow} depth={0} seen={new Set()} onOpen={onOpenFunction} onStep={onOpenStep} />
        ) : (
          <p className="note">No function of the catalog calls it: an entry point, or reached through a resolver, a store or a hook.</p>
        )}
      </div>
    </>
  );
}

/** What is selected: a function, a step, or the endpoint itself. */
export function DetailPanel(props: DetailPanelProps) {
  const { data, endpoint, step, fn } = props;
  let title = 'Detail';
  let body: React.ReactNode;
  if (fn !== undefined) {
    title = 'Function';
    body = <FunctionDetail data={data} framework={props.framework} flow={props.flow} card={fn} endpoint={endpoint} step={step} onOpenFunction={props.onOpenFunction} onOpenStep={props.onOpenStep} onBack={props.onBack} />;
  } else if (endpoint !== undefined && step !== undefined) {
    title = 'Step';
    body = <StepDetail data={data} endpoint={endpoint} step={step} onOpenFunction={props.onOpenFunction} onBack={props.onBack} />;
  } else if (endpoint !== undefined) {
    body = (
      <>
        <div className="card">
          <h3>{endpoint.label}</h3>
          <div className="chips">
            <span className="chip pkg">
              {endpoint.methods.join('|')} {endpoint.path}
            </span>
            <span className="chip">{endpoint.layer}</span>
            {endpoint.spec ? <span className="chip">{endpoint.spec}</span> : null}
          </div>
          <p className="summary">
            {endpoint.steps.length} steps, {endpoint.rearrangeable ? 'a pipeline --flow can reorder' : 'a screen with a fixed order'}. {flagOf(data.features, endpoint.feature)}.
          </p>
          {endpoint.module ? <div className="note">module: {endpoint.module}</div> : null}
        </div>
        <p className="note">Click a step box to see its function and what it calls, down to core.</p>
      </>
    );
  } else {
    body = <div className="empty">Pick an endpoint, then a step, to see the functions it calls.</div>;
  }
  return (
    <section className="panel detail" aria-label="Detail">
      <h2>{title}</h2>
      <div className="body">{body}</div>
    </section>
  );
}
