import type { Decisions, Selection } from '../types';
import type { TraceState } from '../lib/trace';
import { MobileMenuSection } from './MobileMenu';

export interface SelectionBarProps {
  /** The ready-made choices of the root frame (exits, steps) and the ways to the changes. */
  selections: readonly Selection[];
  state: TraceState;
  onState: (next: TraceState) => void;
  /** Open every frame down to every change below the root; absent without changes. */
  onExpandChanges?: (() => void) | undefined;
  /** How many changes are below the root. */
  changesBelow?: number;
}

/** Whether two choices choose the same sides. */
function same(a: Decisions, b: Decisions): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

const GROUPS: ReadonlyArray<{ kind: Selection['kind']; heading: string }> = [
  { kind: 'step', heading: 'ステップ' },
  { kind: 'change', heading: '変更に至る道筋' },
  { kind: 'exit', heading: '終わり方' },
  { kind: 'failure', heading: '失敗で終わる' },
];

/**
 * The ready-made choices of a trace (よく使う選択): the ways into its steps,
 * to the changes of the pull request, and to each way it ends, computed
 * from the trees. Picking one chooses its sides (and opens the frames of a
 * way that crosses them); picking several shows their union. The page shows
 * everything until one is picked.
 */
export function SelectionBar({ selections, state, onState, onExpandChanges, changesBelow = 0 }: SelectionBarProps) {
  const picked = (selection: Selection) => state.choices.some((choice) => same(choice, selection.decisions));
  const toggle = (selection: Selection) => {
    if (picked(selection)) {
      onState({ ...state, choices: state.choices.filter((choice) => !same(choice, selection.decisions)) });
      return;
    }
    const open = [...new Set([...state.open, ...(selection.frames ?? [])])];
    const focus = selection.frames !== undefined && selection.frames.length > 0 ? (selection.frames[selection.frames.length - 1] as string) : state.focus;
    onState({ ...state, open, focus, choices: [...state.choices, selection.decisions] });
  };
  const count = state.choices.length;
  return (
    <MobileMenuSection section="cases">
      <details className="selections">
        <summary role="button" aria-label="よく使う選択を開く">
          <span className="selections-title">よく使う選択</span>
          <span className="selections-current">{count === 0 ? 'すべての分岐を表示' : `${count} 個を選択中`}</span>
        </summary>
        <div className="selections-head">
          <span className="note">選ぶと、その道筋の側だけを残します。複数選ぶと和集合です。分岐ごとの側はアウトラインのボタンでも選べます。</span>
          <span className="selections-actions">
            <button type="button" onClick={() => onState({ ...state, choices: [] })} disabled={count === 0}>
              すべて表示
            </button>
            <label className="toggle">
              <input type="checkbox" checked={state.errors} onChange={(event) => onState({ ...state, errors: event.target.checked })} /> エラー時
            </label>
          </span>
        </div>
        {GROUPS.map(({ kind, heading }) => {
          const list = selections.filter((selection) => selection.kind === kind);
          if (list.length === 0) return null;
          return (
            <section key={kind} className="selection-group">
              <h4>{heading}</h4>
              <div className="selection-list">
                {list.map((selection, index) => (
                  <label key={`${kind}-${index}`} className={`selection${picked(selection) ? ' checked' : ''}${kind === 'failure' ? ' error' : ''}`} title={selection.note ?? selection.name}>
                    <input type="checkbox" checked={picked(selection)} onChange={() => toggle(selection)} />
                    <span>{selection.name}</span>
                    {selection.note !== undefined && kind !== 'exit' && kind !== 'failure' ? <span className="muted">{selection.note}</span> : null}
                  </label>
                ))}
              </div>
            </section>
          );
        })}
      </details>
      {onExpandChanges !== undefined && changesBelow > 0 ? (
        <div className="expand-changes">
          <button type="button" className="code-button" onClick={onExpandChanges}>
            変更まで展開（{changesBelow}）
          </button>
          <span className="note">この下で変わった関数まで、間の呼び出しをすべて開きます</span>
        </div>
      ) : null}
    </MobileMenuSection>
  );
}
