import { useEffect, useMemo, useState } from 'react';
import type { DiffHunk, FunctionEntry, MapData, OpFlow } from '../types';
import { allHunks, frameMark, markOf, type ChangeIndex } from '../lib/changes';
import { callersOf, endpointsInModule, endpointsRootedAt, endpointsUsing, locationOf, type EndpointUse } from '../lib/model';
import { frameSources } from '../lib/source';
import type { TraceState } from '../lib/trace';
import { Badge, ChangeDetail } from './ChangeParts';
import { CodeDrawer } from './CodeDrawer';
import { Chips, Description } from './Parts';
import { ScreenHeader } from './ScreenHeader';
import { Trace } from './Trace';
import { fetchFrame } from './useFrames';

export interface FunctionScreenProps {
  data: MapData;
  changes: ChangeIndex | undefined;
  framework: string;
  flow: OpFlow;
  card: FunctionEntry;
  trace: TraceState;
  enabled: ReadonlySet<string>;
  canGoBack: boolean;
  onTrace: (next: TraceState) => void;
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

/**
 * Where the function is used: the endpoints whose trace starts from it or
 * whose file holds it, the steps that reach it, and the functions that call
 * it. Moving up to a caller starts a new trace (a trace goes down).
 */
function Callers({ data, framework, flow, card, onOpenFunction, onOpenStep, onOpenEndpoint, onFramework }: Omit<FunctionScreenProps, 'changes' | 'trace' | 'enabled' | 'canGoBack' | 'onTrace' | 'onBack'>) {
  const uses = useMemo(() => endpointsUsing(data, flow, card.id), [data, flow, card]);
  const homes = useMemo(() => [...new Set([...endpointsRootedAt(flow, card.id), ...endpointsInModule(flow, card)])], [flow, card]);
  const callers = callersOf(data, card);
  const otherFramework = card.package === 'nextjs' && framework !== 'nextjs' ? 'nextjs' : card.package === 'hono' && framework === 'nextjs' ? 'hono' : undefined;
  return (
    <div className="callers">
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
                  <span className="row-text">{endpoint.root === card.id ? 'このエンドポイントの処理の本体' : `このエンドポイントを実装するファイル（${endpoint.module}）にある関数`}</span>
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
    </div>
  );
}

/**
 * One function as a trace that starts from it: what it does, in the map of
 * a pull request what the pull request did to it, and the outline of its
 * tree, each call opening its callee in place; who calls it beside.
 */
export function FunctionScreen(props: FunctionScreenProps) {
  const { data, changes, card, trace, enabled, onTrace, onBack, onOpenFunction, canGoBack } = props;
  const [code, setCode] = useState<string | null>(null);
  const sources = useMemo(() => frameSources(data, card.id), [data, card]);
  const change = changes?.byId.get(card.id);
  const mark = frameMark(changes, card.id);
  const [hunks, setHunks] = useState<DiffHunk[] | undefined>(undefined);
  useEffect(() => {
    if (change === undefined || card.frame === '') return;
    let live = true;
    fetchFrame(card.frame)
      .then((file) => {
        if (live) setHunks(allHunks(file.change));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [change, card.frame]);
  return (
    <section className="screen" aria-label={`${card.name}()`}>
      <ScreenHeader
        title={
          <>
            {canGoBack ? (
              <button type="button" className="back" onClick={onBack}>
                ← 戻る
              </button>
            ) : null}
            <h2 className="mono">{card.name}()</h2>
            {mark !== undefined ? <Badge mark={mark} /> : null}
            {card.source !== undefined ? (
              <button type="button" className="code-button" aria-label="関数のコードを見る" onClick={() => setCode(card.id)}>
                コードを見る
              </button>
            ) : null}
          </>
        }
      >
        <Description summary={card.summary} description={card.description} />
        <div className="facts-row">
          <span className="chip mono">{locationOf(card)}</span>
          {card.exported ? null : <span className="chip">モジュール内の関数</span>}
          {card.untraceable !== undefined ? <span className="chip">型で引けない呼び出し {card.untraceable}</span> : null}
        </div>
        {change !== undefined ? <ChangeDetail change={change} hunks={hunks} /> : mark?.kind === 'inside' ? <p className="note"><Badge mark={markOf('inside')} /> この関数から呼ぶ関数のどこかを、このPRで変えています。「変更まで展開」で開けます。</p> : null}
        {card.spec || (card.failures ?? []).length > 0 ? (
          <div className="facts-row">
            {card.spec ? (
              <span>
                仕様 <Chips items={card.spec} />
              </span>
            ) : null}
            {(card.failures ?? []).length > 0 ? (
              <span>
                失敗するとき <Chips items={[...new Set((card.failures ?? []).map((failure) => failure.error))].slice(0, 12)} />
              </span>
            ) : null}
          </div>
        ) : null}
      </ScreenHeader>
      {card.frame === '' ? (
        <p className="note pad">この関数の木は読み取れませんでした。</p>
      ) : (
        <Trace
          key={card.id}
          data={data}
          changes={changes}
          rootId={card.id}
          state={trace}
          onState={onTrace}
          enabled={enabled}
          onOpenFunction={onOpenFunction}
          onOpenCode={setCode}
          tabs={[
            {
              id: 'callers',
              label: '呼び出し元',
              // The callers of the function the diagram shows, which is this page's function until the reader dives into a call.
              content: (frameId) => {
                const shown = data.functions[frameId];
                return shown === undefined ? <p className="note">図に出しているのはエンドポイントの処理の本体です。</p> : <Callers {...props} card={shown} />;
              },
            },
          ]}
        />
      )}
      {code !== null ? <CodeDrawer data={data} changes={changes} targets={sources} initial={code} onClose={() => setCode(null)} /> : null}
    </section>
  );
}
