/** The rows of one place of a request (its query, its body, or its headers), each a name and a value to write, with a row to add. */
export function Rows({ label, rows, onChange, onAdd, onRemove, note }: { label: string; rows: ReadonlyArray<{ name: string; value: string }>; onChange: (index: number, name: string, value: string) => void; onAdd: () => void; onRemove: (index: number) => void; note?: (row: { name: string; value: string }) => string | undefined }) {
  return (
    <fieldset className="req-rows">
      <legend>{label}</legend>
      {rows.length === 0 ? <p className="note">ありません。</p> : null}
      <ul>
        {rows.map((row, index) => {
          const said = note?.(row);
          return (
            <li key={index} className="req-row">
              <input className="mono req-name" aria-label={`${label}の${index + 1} 行目の名前`} value={row.name} spellCheck={false} autoComplete="off" onChange={(event) => onChange(index, event.target.value, row.value)} />
              <input className="mono req-input" aria-label={`${row.name || `${label}の${index + 1} 行目`}の値`} value={row.value} spellCheck={false} autoComplete="off" onChange={(event) => onChange(index, row.name, event.target.value)} />
              <button type="button" className="icon req-remove" aria-label={`${row.name || `${index + 1} 行目`}を消す`} title="この行を消す" onClick={() => onRemove(index)}>
                ×
              </button>
              {said !== undefined ? <span className="req-note">{said}</span> : null}
            </li>
          );
        })}
      </ul>
      <button type="button" className="link small" onClick={onAdd}>
        + 行を足す
      </button>
    </fieldset>
  );
}
