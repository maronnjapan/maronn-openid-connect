import type { FlowCase } from '../lib/graph';

export interface CasePickerProps {
  cases: readonly FlowCase[];
  /** The labels of the checked cases. */
  checked: ReadonlySet<string>;
  onChange: (checked: Set<string>) => void;
}

/** A checkbox per case of a diagram: the diagram shows the boxes and arrows of the checked ones only. */
export function CasePicker({ cases, checked, onChange }: CasePickerProps) {
  if (cases.length === 0) return null;
  const toggle = (label: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(label);
    else next.delete(label);
    onChange(next);
  };
  return (
    <div className="cases" role="group" aria-label="表示するケース">
      <div className="cases-head">
        <span className="cases-title">ケース</span>
        <span className="note">チェックしたケースで通るステップと矢印だけを表示します</span>
        <span className="cases-actions">
          <button type="button" onClick={() => onChange(new Set(cases.map((flowCase) => flowCase.label)))}>
            すべて
          </button>
          <button type="button" onClick={() => onChange(new Set())}>
            解除
          </button>
        </span>
      </div>
      <div className="case-list">
        {cases.map((flowCase) => (
          <label key={flowCase.id} title={flowCase.label} className={`case${flowCase.kind === 'error' ? ' error' : ''}${checked.has(flowCase.label) ? ' checked' : ''}`}>
            <input type="checkbox" checked={checked.has(flowCase.label)} onChange={(event) => toggle(flowCase.label, event.target.checked)} />
            <span>{flowCase.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
