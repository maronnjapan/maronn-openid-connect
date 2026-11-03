import { useMemo, useState } from 'react';
import type { FlowEndpoint, MapData, Selection } from '../types';
import { changeName, frameMark, type ChangeIndex } from '../lib/changes';
import { generatedWhen } from '../lib/model';
import { endpointSources } from '../lib/source';
import { entryOf, type TraceState } from '../lib/trace';
import { Badge } from './ChangeParts';
import { CodeDrawer } from './CodeDrawer';
import { ScreenHeader } from './ScreenHeader';
import { StepPanel } from './StepPanel';
import { Trace } from './Trace';

export interface EndpointScreenProps {
  data: MapData;
  changes: ChangeIndex | undefined;
  framework: string;
  endpoint: FlowEndpoint;
  trace: TraceState;
  enabled: ReadonlySet<string>;
  onTrace: (next: TraceState) => void;
  onOpenFunction: (id: string) => void;
}

/** The ways from an endpoint to the changes of the pull request, as ready-made choices. */
export function changeSelections(data: MapData, changes: ChangeIndex | undefined, framework: string, endpoint: string): Selection[] {
  if (changes === undefined) return [];
  return changes.changes.frames.flatMap((entry) =>
    entry.reach
      .filter((way) => way.endpoint === endpoint && way.frameworks.includes(framework))
      .map((way): Selection => ({
        kind: 'change',
        name: `${changeName(data, entry)}${way.step === undefined ? '' : `（${way.step} から）`}`,
        note: entry.summary[0] ?? '',
        decisions: way.decisions,
        frames: way.frames,
        target: way.target,
      })),
  );
}

/**
 * One endpoint as a trace: what it does in a line, the ready-made choices,
 * and the outline of the frame its trace starts from (the handler of the
 * pipeline, or the Route Handler), each call opening its callee in place.
 * A step selected shows its facts beside the outline.
 */
export function EndpointScreen({ data, changes, framework, endpoint, trace, enabled, onTrace, onOpenFunction }: EndpointScreenProps) {
  const [code, setCode] = useState<string | null>(null);
  const sources = useMemo(() => endpointSources(data, endpoint), [data, endpoint]);
  const extra = useMemo(() => changeSelections(data, changes, framework, endpoint.id), [data, changes, framework, endpoint.id]);
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
          rootId={endpoint.root}
          extraSelections={extra}
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
