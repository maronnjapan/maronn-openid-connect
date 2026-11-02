import { useMemo } from 'react';
import type { FlowEndpoint, MapData } from '../types';
import { endpointDiagram, type DiagramNode } from '../lib/diagram';
import { activeOf } from '../lib/graph';
import { generatedWhen } from '../lib/model';
import { CasePicker } from './CasePicker';
import { FlowDiagram } from './FlowDiagram';
import { StepPanel } from './StepPanel';

export interface EndpointScreenProps {
  data: MapData;
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
 * beside the diagram only while one is selected.
 */
export function EndpointScreen({ data, endpoint, selected, checked, onCases, onSelectStep, onOpenFunction }: EndpointScreenProps) {
  const diagram = useMemo(() => endpointDiagram(endpoint, data), [endpoint, data]);
  const labels = useMemo(() => checked ?? new Set(diagram.cases.slice(0, 1).map((flowCase) => flowCase.label)), [checked, diagram]);
  const active = useMemo(() => {
    const ids = new Set(diagram.cases.filter((flowCase) => labels.has(flowCase.label)).map((flowCase) => flowCase.id));
    return activeOf(diagram.cases, ids, diagram.edges);
  }, [diagram, labels]);
  const step = endpoint.steps.find((candidate) => candidate.id === selected);
  const onSelect = (node: DiagramNode) => {
    if (node.target !== undefined && 'step' in node.target) onSelectStep(node.target.step === selected ? null : node.target.step);
  };
  return (
    <section className="screen" aria-label={endpoint.label}>
      <header className="screen-head">
        <div className="title-row">
          <h2>{endpoint.label}</h2>
          <code className="route">
            {endpoint.methods.join(' | ')} {endpoint.path}
          </code>
          {endpoint.spec ? <span className="chip">{endpoint.spec}</span> : null}
        </div>
        {endpoint.summary ? <p className="lead">{endpoint.summary}</p> : null}
        <p className="note">
          {generatedWhen(data.features, endpoint.feature)} · ステップ {endpoint.steps.length} 個 · ボックスを選ぶとそのステップの詳細を開きます
        </p>
      </header>
      <CasePicker cases={diagram.cases} checked={labels} onChange={(next) => onCases(diagram.key, next)} />
      <div className={`work${step ? ' with-panel' : ''}`}>
        <div className="canvas">
          <FlowDiagram diagram={diagram} active={active} selected={selected} label={`${endpoint.label} のステップ`} onSelect={onSelect} />
        </div>
        {step ? <StepPanel data={data} endpoint={endpoint} step={step} onClose={() => onSelectStep(null)} onOpenFunction={onOpenFunction} /> : null}
      </div>
    </section>
  );
}
