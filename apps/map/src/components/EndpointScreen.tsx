import { useMemo, useState } from 'react';
import type { FlowEndpoint, MapData } from '../types';
import { changesInFile, markOf, stepMark, type ChangeIndex, type Mark } from '../lib/changes';
import { endpointDiagram, type DiagramNode } from '../lib/diagram';
import { activeOf } from '../lib/graph';
import { generatedWhen } from '../lib/model';
import { endpointSources } from '../lib/source';
import { CasePicker } from './CasePicker';
import { Badge } from './ChangeParts';
import { CodeDrawer } from './CodeDrawer';
import { FlowDiagram } from './FlowDiagram';
import { ScreenHeader } from './ScreenHeader';
import { StepPanel } from './StepPanel';

export interface EndpointScreenProps {
  data: MapData;
  /** The changes of the pull request, in the map of one. */
  changes: ChangeIndex | undefined;
  endpoint: FlowEndpoint;
  selected: string | null;
  /** The labels of the checked cases, or undefined for the default (the first case). */
  checked: ReadonlySet<string> | undefined;
  onCases: (key: string, checked: Set<string>) => void;
  onSelectStep: (step: string | null) => void;
  onOpenFunction: (id: string) => void;
}

/**
 * One endpoint: what it does in a line, the cases to show, and its steps as
 * a diagram that takes the rest of the screen. The detail of a step opens
 * in a large drawer only while one is selected. In the map of a pull
 * request, the steps carry the badges of its changes, and the changed
 * functions of the endpoint's own file (whose blocks may name no function a
 * step calls) are listed under the description.
 */
export function EndpointScreen({ data, changes, endpoint, selected, checked, onCases, onSelectStep, onOpenFunction }: EndpointScreenProps) {
  const [code, setCode] = useState<string | null>(null);
  const sources = useMemo(() => endpointSources(data, endpoint), [data, endpoint]);
  const diagram = useMemo(() => endpointDiagram(endpoint, data), [endpoint, data]);
  const marks = useMemo(() => {
    const byStep = new Map<string, Mark>();
    for (const node of diagram.nodes) {
      const step = endpoint.steps.find((step) => node.target !== undefined && 'step' in node.target && node.target.step === step.id);
      if (step === undefined) continue;
      const mark = stepMark(changes, data, step);
      if (mark !== undefined) byStep.set(node.id, mark);
    }
    return byStep;
  }, [changes, data, endpoint, diagram]);
  const fileChanges = useMemo(() => changesInFile(changes, endpoint), [changes, endpoint]);
  const labels = useMemo(() => checked ?? new Set(diagram.cases.slice(0, 1).map((flowCase) => flowCase.label)), [checked, diagram]);
  const active = useMemo(() => {
    const ids = new Set(diagram.cases.filter((flowCase) => labels.has(flowCase.label)).map((flowCase) => flowCase.id));
    return activeOf(diagram.cases, ids, diagram.edges);
  }, [diagram, labels]);
  const step = endpoint.steps.find((candidate) => candidate.id === selected);
  const onSelect = (node: DiagramNode) => {
    if (node.target !== undefined && 'step' in node.target) onSelectStep(node.target.step === selected ? null : node.target.step);
    if (node.target !== undefined && 'fn' in node.target) onOpenFunction(node.target.fn);
  };
  return (
    <section className="screen" aria-label={endpoint.label}>
      <ScreenHeader title={
        <>
          <h2>{endpoint.label}</h2>
          <code className="route">
            {endpoint.methods.join(' | ')} {endpoint.path}
          </code>
          {endpoint.source !== undefined ? <button type="button" className="code-button" aria-label="エンドポイント全体のコードを見る" onClick={() => setCode(endpoint.source as string)}>コードを見る</button> : null}
        </>
      }>
        {endpoint.summary ? <p className="lead">{endpoint.summary}</p> : null}
        {endpoint.spec ? <span className="chip">{endpoint.spec}</span> : null}
        <p className="note">
          {generatedWhen(data.features, endpoint.feature)} · ステップ {endpoint.steps.length} 個 · 箱を選ぶと、そのステップの詳細を開きます
          {marks.size > 0 ? ` · このPRの変更の札が付いたステップ ${marks.size} 個` : ''}
        </p>
        {fileChanges.length > 0 ? (
          <p className="note file-changes">
            このエンドポイントのファイル（{endpoint.module}）で、このPRが変えた関数:
            {fileChanges.map((change) => (
              <span key={change.id}>
                <Badge mark={markOf(change.kind)} />{' '}
                <button type="button" className="link mono" onClick={() => onOpenFunction(change.id)}>
                  {change.name}()
                </button>
              </span>
            ))}
          </p>
        ) : null}
      </ScreenHeader>
      <CasePicker cases={diagram.cases} checked={labels} onChange={(next) => onCases(diagram.key, next)} />
      <div className="work">
        <div className="canvas">
          <FlowDiagram diagram={diagram} active={active} selected={selected} label={`${endpoint.label} のステップ`} marks={marks} onSelect={onSelect} />
        </div>
        {step ? <StepPanel data={data} changes={changes} endpoint={endpoint} step={step} onClose={() => onSelectStep(null)} onOpenFunction={onOpenFunction} onOpenCode={setCode} /> : null}
      </div>
      {code !== null ? <CodeDrawer key={code} data={data} targets={sources} initial={code} onClose={() => setCode(null)} /> : null}
    </section>
  );
}
