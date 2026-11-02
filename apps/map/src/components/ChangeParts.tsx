import type { DiffHunk, FunctionChange } from '../types';
import { diffStat, inlineParts, markOf, noteBlocks, numberHunk, type Mark, type ReachedChange } from '../lib/changes';

/** A badge that says how something changed in the pull request; its tooltip says what that means. */
export function Badge({ mark }: { mark: Mark }) {
  return (
    <span className={`badge badge-${mark.kind}`} title={mark.title}>
      {mark.label}
    </span>
  );
}

/** A line of a note, with its `code` set in code. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) => (part.code ? <code key={index}>{part.text}</code> : <span key={index}>{part.text}</span>))}
    </>
  );
}

/** The text of a change note: paragraphs (their line breaks kept), lists and code blocks. */
export function NoteText({ text }: { text: string }) {
  return (
    <div className="note-text">
      {noteBlocks(text).map((block, index) => {
        if (block.type === 'code') {
          return (
            <pre key={index} className="mono">
              {block.text}
            </pre>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={index}>
              {block.items.map((item, at) => (
                <li key={at}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

/** The hunks of a function as a unified diff, each line with its number in the base and in the head. */
export function DiffView({ hunks }: { hunks: readonly DiffHunk[] }) {
  return (
    <div className="diff mono">
      {hunks.map((hunk, index) => (
        <div key={index} className="hunk">
          {numberHunk(hunk).map((line, at) => (
            <div key={at} className={`diff-line ${line.op === '+' ? 'add' : line.op === '-' ? 'remove' : 'keep'}`}>
              <span className="ln" aria-hidden="true">
                {line.base ?? ''}
              </span>
              <span className="ln" aria-hidden="true">
                {line.head ?? ''}
              </span>
              <span className="op" aria-label={line.op === '+' ? '追加した行' : line.op === '-' ? '消した行' : undefined}>
                {line.op}
              </span>
              <span className="text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** What the pull request did to a function, in a phrase. */
export function changeHeadline(change: FunctionChange): string {
  switch (change.kind) {
    case 'added':
      return 'このPRで足した関数です';
    case 'modified':
      return change.from === undefined ? 'このPRでコードを変えました' : `このPRでコードを変え、${change.from} から移しました`;
    case 'moved':
      return `このPRで ${change.from ?? '別のファイル'} から移しました（コードは同じ）`;
    case 'docs':
      return 'このPRで JSDoc だけ変えました（コードは同じ）';
    case 'removed':
      return 'このPRで消した関数です';
    case 'noted':
      return 'コードは変えていません。このPRの変更メモが説明しています';
  }
}

/** What the notes of the pull request say about a function, or that they say nothing. */
export function ChangeNotes({ change }: { change: FunctionChange }) {
  if (change.notes === undefined || change.notes.length === 0) return <p className="note">変更メモにこの関数の説明はありません。</p>;
  return (
    <>
      {change.notes.map((note, index) => (
        <NoteText key={index} text={note.text} />
      ))}
    </>
  );
}

/**
 * What the pull request did to a function: how it changed, what the change
 * notes say, and its diff on demand (folded, so the diagram keeps the room).
 */
export function ChangeDetail({ change }: { change: FunctionChange }) {
  const stat = diffStat(change.hunks);
  return (
    <section className="change" aria-label="このPRでの変更">
      <div className="change-head">
        <Badge mark={markOf(change.kind)} />
        <span className="change-title">{changeHeadline(change)}</span>
      </div>
      <div className="change-notes">
        <ChangeNotes change={change} />
      </div>
      {change.hunks !== undefined && change.hunks.length > 0 ? (
        <details className="change-diff">
          <summary>
            差分を見る（+{stat.added} −{stat.removed}）
          </summary>
          <DiffView hunks={change.hunks} />
        </details>
      ) : null}
    </section>
  );
}

/** The changed functions below a step or a function, each a link to its page with the way down to it. */
export function ReachedList({ reached, limit = 8, onOpenFunction }: { reached: readonly ReachedChange[]; limit?: number; onOpenFunction: (id: string) => void }) {
  return (
    <ul className="links">
      {reached.slice(0, limit).map(({ change, card, via }) => (
        <li key={card.id}>
          <button type="button" className="row" onClick={() => onOpenFunction(card.id)}>
            <span className="row-title">
              <Badge mark={markOf(change.kind)} /> <span className="mono">{card.name}()</span>
            </span>
            <span className="row-text">{via.length === 0 ? '直接呼ぶ' : `${via.map((between) => `${between.name}()`).join(' → ')} を経由して呼ぶ`}</span>
            {change.notes?.[0] !== undefined ? <span className="row-text">{change.notes[0].text.split('\n')[0]}</span> : null}
          </button>
        </li>
      ))}
      {reached.length > limit ? <li className="note">ほか {reached.length - limit} 個</li> : null}
    </ul>
  );
}
