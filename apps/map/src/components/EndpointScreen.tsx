import { useMemo, useState } from 'react';
import type { FlowEndpoint, MapData } from '../types';
import { frameMark, waySelections, type ChangeIndex } from '../lib/changes';
import { generatedWhen } from '../lib/model';
import { endpointSources } from '../lib/source';
import { entryOf, type TraceState } from '../lib/trace';
import { Badge } from './ChangeParts';
import { CodeDrawer } from './CodeDrawer';
import { ScreenHeader } from './ScreenHeader';
import { StepPanel } from './StepPanel';
import { Trace } from './Trace';

/** The endpoint an endpoint screen shows, its trace, and what a link asks it to select (see EndpointScreen). */
export interface EndpointScreenProps {
  data: MapData;
  changes: ChangeIndex | undefined;
  framework: string;
  endpoint: FlowEndpoint;
  trace: TraceState;
  enabled: ReadonlySet<string>;
  /** The step a link names (`#hono--token--select-signing-keys`): the trace selects it and shows where it is. */
  step?: string | null;
  /** A node a way to a change leads to, keyed like a decision: the trace selects it once its frame shows. */
  target?: string | null;
  onTrace: (next: TraceState) => void;
  onOpenFunction: (id: string) => void;
}

/**
 * One endpoint as a trace: what it does in a line, the ready-made choices,
 * and the outline of the frame its trace starts from (the handler of the
 * pipeline, or the Route Handler), each call opening its callee in place.
 * A step selected shows its facts beside the outline; a step or a node a
 * link names is selected and shown.
 */
export function EndpointScreen({ data, changes, framework, endpoint, trace, enabled, step = null, target = null, onTrace, onOpenFunction }: EndpointScreenProps) {
  const [code, setCode] = useState<string | null>(null);
  const sources = useMemo(() => endpointSources(data, endpoint), [data, endpoint]);
  const extra = useMemo(() => waySelections(data, changes, framework, endpoint.id, enabled), [data, changes, framework, endpoint.id, enabled]);
  const root = entryOf(data, endpoint.root);
  const mark = frameMark(changes, endpoint.root);
  return (
    <section className="screen" aria-label={endpoint.label}>
      <ScreenHeader
        title={
          <>
            <h2>{endpoint.label}</h2>
            <code className="route">
              {endpoint.methods.join(' | ')} {endpoint.path}
            </code>
            {mark !== undefined ? <Badge mark={mark} /> : null}
            {endpoint.source !== undefined ? (
              <button type="button" className="code-button" aria-label="エンドポイント全体のコードを見る" onClick={() => setCode(endpoint.source as string)}>
                コードを見る
              </button>
            ) : null}
          </>
        }
      >
        {endpoint.summary ? <p className="lead">{endpoint.summary}</p> : null}
        {endpoint.spec ? <span className="chip">{endpoint.spec}</span> : null}
        <p className="note">
          {generatedWhen(data.features, endpoint.feature)} · ステップ {endpoint.steps.length} 個 · 処理の本体は {root === undefined ? endpoint.root : 'endpoint' in root ? `${root.name}（${root.module}）` : `${root.name}()（${root.module}）`} · 呼び出しの ▸ でその関数の中をその場で開きます
        </p>
      </ScreenHeader>
      {endpoint.root === '' ? (
        <p className="empty">このエンドポイントの処理の本体を読めませんでした。</p>
      ) : (
        <Trace
          key={`${framework}/${endpoint.id}`}
          data={data}
          changes={changes}
          framework={framework}
          rootId={endpoint.root}
          extraSelections={extra}
          step={step}
          target={target}
          state={trace}
          onState={onTrace}
          enabled={enabled}
          onOpenFunction={onOpenFunction}
          onOpenCode={setCode}
          renderStep={(mark) => {
            const step = endpoint.steps.find((candidate) => candidate.id === mark.id);
            if (step === undefined) return <p className="note">{mark.label}（このフレームワークの構成には無いステップです）</p>;
            return <StepPanel data={data} changes={changes} endpoint={endpoint} step={step} onOpenFunction={onOpenFunction} onOpenCode={setCode} />;
          }}
        />
      )}
      {code !== null ? <CodeDrawer key={code} data={data} changes={changes} targets={sources} initial={code} onClose={() => setCode(null)} /> : null}
    </section>
  );
}
