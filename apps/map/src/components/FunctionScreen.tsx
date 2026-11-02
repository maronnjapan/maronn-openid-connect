import { useMemo, useState } from 'react';
import type { FunctionCard, MapData, OpFlow } from '../types';
import { functionDiagram, type DiagramNode } from '../lib/diagram';
import { activeOf } from '../lib/graph';
import { callersOf, endpointsInModule, endpointsUsing, locationOf, type EndpointUse } from '../lib/model';
import { CasePicker } from './CasePicker';
import { FlowDiagram } from './FlowDiagram';
import { Chips, Description } from './Parts';

export interface FunctionScreenProps {
  data: MapData;
  framework: string;
  flow: OpFlow;
  card: FunctionCard;
  checked: ReadonlySet<string> | undefined;
  canGoBack: boolean;
  onCases: (key: string, checked: Set<string>) => void;
  onBack: () => void;
  onOpenFunction: (id: string) => void;
  onOpenStep: (endpoint: string, step: string) => void;
  onOpenEndpoint: (endpoint: string) => void;
  onFramework: (framework: string) => void;
}

/** How a step reaches the function, in words. */
function wayOf(use: EndpointUse): string {
  if (use.as === 'function') return 'このステップの関数そのもの';
  if (use.as === 'call') return 'ステップの中で直接呼ぶ';
  return `${use.via.map((card) => `${card.name}()`).join(' → ')} を経由して呼ぶ`;
}

/** Where the function is used: the steps of the endpoints that reach it, and the functions that call it. */
function Callers({ data, framework, flow, card, onOpenFunction, onOpenStep, onOpenEndpoint, onFramework }: Omit<FunctionScreenProps, 'checked' | 'canGoBack' | 'onCases' | 'onBack'>) {
  const uses = useMemo(() => endpointsUsing(data, flow, card.id), [data, flow, card]);
  const homes = useMemo(() => endpointsInModule(flow, card), [flow, card]);
  const callers = callersOf(data, card);
  const otherFramework = card.package === 'nextjs' && framework !== 'nextjs' ? 'nextjs' : card.package === 'hono' && framework === 'nextjs' ? 'hono' : undefined;
  return (
    <aside className="side-panel callers" aria-label="呼び出し元">
      <h3>呼び出し元</h3>
      <section>
        <h4>使われるエンドポイント</h4>
        {homes.length > 0 ? (
          <ul className="links">
            {homes.map((endpoint) => (
              <li key={`home-${endpoint.id}`}>
                <button type="button" className="row" onClick={() => onOpenEndpoint(endpoint.id)}>
                  <span className="route mono">
                    {endpoint.methods.join(' | ')} {endpoint.path}
                  </span>
                  <span className="row-title">{endpoint.label}</span>
                  <span className="row-text">このエンドポイントを実装するファイル（{endpoint.module}）にある関数</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {uses.length > 0 ? (
          <ul className="links">
            {uses.map((use) => (
              <li key={`${use.endpoint.id}/${use.step.id}`}>
                <button type="button" className="row" onClick={() => onOpenStep(use.endpoint.id, use.step.id)}>
                  <span className="route mono">
                    {use.endpoint.methods.join(' | ')} {use.endpoint.path}
                  </span>
                  <span className="row-title">{use.step.label}</span>
                  <span className="row-text">{wayOf(use)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : homes.length > 0 ? null : (
          <p className="note">
            {framework} の構成では、どのエンドポイントのステップからも使われません。
            {otherFramework !== undefined ? (
              <>
                {' '}
                <button type="button" className="link" onClick={() => onFramework(otherFramework)}>
                  {otherFramework} で見る
                </button>
              </>
            ) : null}
          </p>
        )}
      </section>
      <section>
        <h4>この関数を呼ぶ関数</h4>
        {callers.length > 0 ? (
          <ul className="links">
            {callers.map((caller) => (
              <li key={caller.id}>
                <button type="button" className="row" onClick={() => onOpenFunction(caller.id)}>
                  <span className="row-title mono">{caller.name}()</span>
                  <span className="row-text">{caller.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">ほかの関数からは呼ばれません。エンドポイントのステップやフレームワークから直接呼ばれる関数です。</p>
        )}
      </section>
    </aside>
  );
}

/**
 * One function: what it does, the flow inside it as a diagram like the steps
 * of an endpoint (each box a function it calls, a branch, a return or a
 * throw), and who uses it.
 */
export function FunctionScreen(props: FunctionScreenProps) {
  const { data, card, checked, onCases, onBack, onOpenFunction, canGoBack } = props;
  const diagram = useMemo(() => functionDiagram(card, data), [card, data]);
  const labels = useMemo(() => checked ?? new Set(diagram?.cases.slice(0, 1).map((flowCase) => flowCase.label) ?? []), [checked, diagram]);
  const active = useMemo(() => {
    if (diagram === undefined) return { nodes: new Set<string>(), edges: new Set<number>() };
    const ids = new Set(diagram.cases.filter((flowCase) => labels.has(flowCase.label)).map((flowCase) => flowCase.id));
    return activeOf(diagram.cases, ids, diagram.edges);
  }, [diagram, labels]);
  const [member, setMember] = useState<string | null>(null);
  const memberDoc = member === null ? undefined : data.members[member];
  const onSelect = (node: DiagramNode) => {
    if (node.target === undefined) return;
    if ('fn' in node.target) onOpenFunction(node.target.fn);
    else if ('member' in node.target) setMember(node.target.member === member ? null : node.target.member);
  };
  return (
    <section className="screen" aria-label={`${card.name}()`}>
      <header className="screen-head">
        <div className="title-row">
          {canGoBack ? (
            <button type="button" className="back" onClick={onBack}>
              ← 戻る
            </button>
          ) : null}
          <h2 className="mono">{card.name}()</h2>
          <span className="chip mono">{locationOf(card)}</span>
          {card.exported ? null : <span className="chip">モジュール内の関数</span>}
        </div>
        <Description summary={card.summary} description={card.description} />
        {card.spec || card.throws ? (
          <div className="facts-row">
            {card.spec ? (
              <span>
                仕様 <Chips items={card.spec} />
              </span>
            ) : null}
            {card.throws ? (
              <span>
                失敗するとき <Chips items={card.throws} />
              </span>
            ) : null}
          </div>
        ) : null}
      </header>
      {diagram ? <CasePicker cases={diagram.cases} checked={labels} onChange={(next) => onCases(diagram.key, next)} /> : null}
      <div className="work with-panel">
        <div className="canvas">
          {diagram ? (
            <>
              <FlowDiagram diagram={diagram} active={active} selected={member === null ? null : (diagram.nodes.find((node) => node.target !== undefined && 'member' in node.target && node.target.member === member)?.id ?? null)} label={`${card.name}() の処理の流れ`} onSelect={onSelect} />
              {memberDoc ? (
                <div className="member-note" role="note">
                  <strong className="mono">
                    {memberDoc.type}.{memberDoc.member}()
                  </strong>
                  <span>{memberDoc.summary}</span>
                  <span className="mono muted">{locationOf(memberDoc)}</span>
                </div>
              ) : null}
            </>
          ) : (
            <p className="note pad">この関数の処理の流れは読み取れませんでした。</p>
          )}
        </div>
        <Callers {...props} />
      </div>
    </section>
  );
}
