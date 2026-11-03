import { useMemo, useState } from 'react';
import type { FunctionCard, MapData, OpFlow } from '../types';
import { changesBelow, markOf, nodeMark, type ChangeIndex, type Mark, type ReachedChange } from '../lib/changes';
import { functionDiagram, type DiagramNode } from '../lib/diagram';
import { activeOf } from '../lib/graph';
import { callersOf, endpointsInModule, endpointsUsing, locationOf, type EndpointUse } from '../lib/model';
import { functionSources } from '../lib/source';
import { CasePicker } from './CasePicker';
import { Badge, ChangeDetail, ReachedList } from './ChangeParts';
import { CodeDrawer } from './CodeDrawer';
import { FlowDiagram } from './FlowDiagram';
import { ScreenHeader } from './ScreenHeader';
import { Chips, Description } from './Parts';
import { DetailDrawer } from './DetailDrawer';
import { MobileMenuSection } from './MobileMenu';

export interface FunctionScreenProps {
  data: MapData;
  /** The changes of the pull request, in the map of one. */
  changes: ChangeIndex | undefined;
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

type CallersProps = Omit<FunctionScreenProps, 'changes' | 'checked' | 'canGoBack' | 'onCases' | 'onBack'> & {
  /** The functions the pull request changed that this one calls, directly or further down. */
  below: readonly ReachedChange[];
};

/**
 * Where the function is used: the steps of the endpoints that reach it, and
 * the functions that call it; first, in the map of a pull request, the
 * changed functions it calls.
 */
function Callers({ data, framework, flow, card, below, onOpenFunction, onOpenStep, onOpenEndpoint, onFramework }: CallersProps) {
  const uses = useMemo(() => endpointsUsing(data, flow, card.id), [data, flow, card]);
  const homes = useMemo(() => endpointsInModule(flow, card), [flow, card]);
  const callers = callersOf(data, card);
  const otherFramework = card.package === 'nextjs' && framework !== 'nextjs' ? 'nextjs' : card.package === 'hono' && framework === 'nextjs' ? 'hono' : undefined;
  return (
    <aside className="side-panel callers" aria-label="呼び出し元">
      {below.length > 0 ? (
        <section>
          <h4>この関数から呼ぶ、このPRで変えた関数</h4>
          <ReachedList reached={below} onOpenFunction={onOpenFunction} />
        </section>
      ) : null}
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
 * throw), and who uses it. In the map of a pull request, what the pull
 * request did to it (with what its change notes say and the diff), or the
 * changed functions it calls, and badges on the boxes of the lines it changed
 * and of the calls that lead to a change.
 */
export function FunctionScreen(props: FunctionScreenProps) {
  const { data, changes, card, checked, onCases, onBack, onOpenFunction, canGoBack } = props;
  const [code, setCode] = useState(false);
  const sources = useMemo(() => functionSources(data, card), [data, card]);
  const diagram = useMemo(() => functionDiagram(card, data), [card, data]);
  const change = changes?.byId.get(card.id);
  const below = useMemo(() => changesBelow(changes, data, card.calls), [changes, data, card]);
  const marks = useMemo(() => {
    const byNode = new Map<string, Mark>();
    for (const node of card.flow?.nodes ?? []) {
      const mark = nodeMark(changes, change, node, card.line);
      if (mark !== undefined) byNode.set(node.id, mark);
    }
    return byNode;
  }, [changes, change, card]);
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
      <ScreenHeader title={
        <>
          {canGoBack ? (
            <button type="button" className="back" onClick={onBack}>
              ← 戻る
            </button>
          ) : null}
          <h2 className="mono">{card.name}()</h2>
          {change !== undefined ? <Badge mark={markOf(change.kind)} /> : below.length > 0 ? <Badge mark={markOf('inside')} /> : null}
          {card.source !== undefined ? <button type="button" className="code-button" aria-label="関数のコードを見る" onClick={() => setCode(true)}>コードを見る</button> : null}
        </>
      }>
        <Description summary={card.summary} description={card.description} />
        <div className="facts-row">
          <span className="chip mono">{locationOf(card)}</span>
          {card.exported ? null : <span className="chip">モジュール内の関数</span>}
        </div>
        {change !== undefined ? <ChangeDetail change={change} /> : null}
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
      </ScreenHeader>
      {diagram ? <CasePicker cases={diagram.cases} checked={labels} onChange={(next) => onCases(diagram.key, next)} /> : null}
      <div className="work with-panel">
        <div className="canvas">
          {diagram ? (
            <>
              <FlowDiagram diagram={diagram} active={active} selected={member === null ? null : (diagram.nodes.find((node) => node.target !== undefined && 'member' in node.target && node.target.member === member)?.id ?? null)} label={`${card.name}() の処理の流れ`} marks={marks} onSelect={onSelect} />
              {memberDoc ? (
                <DetailDrawer title={`${memberDoc.type}.${memberDoc.member}()`} onClose={() => setMember(null)}>
                  <p className="lead">{memberDoc.summary}</p>
                  <p className="where mono">{locationOf(memberDoc)}</p>
                </DetailDrawer>
              ) : null}
            </>
          ) : (
            <p className="note pad">この関数の処理の流れは読み取れませんでした。</p>
          )}
        </div>
        <MobileMenuSection section="callers">
          <Callers {...props} below={below} />
        </MobileMenuSection>
      </div>
      {code ? <CodeDrawer data={data} targets={sources} initial={card.id} onClose={() => setCode(false)} /> : null}
    </section>
  );
}
