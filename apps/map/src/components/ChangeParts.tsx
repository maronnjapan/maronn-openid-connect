import type { DiffHunk, FrameChangeEntry } from '../types';
import { countWords, diffStat, inlineParts, markOf, noteBlocks, numberHunk, type Mark } from '../lib/changes';

/** A badge that says how something changed in the pull request; its tooltip says what that means. */
export function Badge({ mark }: { mark: Mark }) {
  return (
    <span className={`badge badge-${mark.kind}`} title={mark.title}>
      {mark.label}
    </span>
  );
}

/** A line of a note, with its `code` set in code. */
export function Inline({ text }: { text: string }) {
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
              <span className="text">{hunk.tokens?.[at]?.map((token, index) => (
                <span key={index} className="diff-token" style={{ color: token.color }}>{token.content}</span>
              )) ?? line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** What the pull request did to a frame, in a phrase. */
export function changeHeadline(change: FrameChangeEntry): string {
  const what = change.body === true ? 'エンドポイントの処理' : '関数';
  switch (change.kind) {
    case 'added':
      return `このPRで足した${what}です`;
    case 'modified':
      return change.from === undefined ? 'このPRでコードを変えました' : `このPRでコードを変え、${change.from} から移しました`;
    case 'moved':
      return `このPRで ${change.from ?? '別のファイル'} から移しました（コードは同じ）`;
    case 'docs':
      return 'このPRで JSDoc だけ変えました（コードは同じ）';
    case 'removed':
      return `このPRで消した${what}です`;
    case 'noted':
      return 'コードは変えていません。このPRの変更メモが説明しています';
  }
}

/** What the notes of the pull request say about a frame, or that they say nothing. */
export function ChangeNotes({ change }: { change: FrameChangeEntry }) {
  const notes = (change.notes ?? []).filter((note) => note.text.trim() !== '');
  if (notes.length === 0) return <p className="note">変更メモにこの変更の説明はありません。</p>;
  return (
    <>
      {notes.map((note, index) => (
        <NoteText key={index} text={note.text} />
      ))}
    </>
  );
}

/** The diff of a frame in words: what the tree diff found, with the counts. */
export function ChangeSummary({ change }: { change: FrameChangeEntry }) {
  if (change.summary.length === 0) return null;
  const counts = countWords(change.counts);
  return (
    <div className="change-summary">
      <ul>
        {change.summary.slice(0, 12).map((line, index) => (
          <li key={index}>
            <Inline text={line} />
          </li>
        ))}
      </ul>
      {change.summary.length > 12 ? <p className="note">ほか {change.summary.length - 12} 個</p> : null}
      {counts !== '' ? <p className="note">{counts}</p> : null}
      {change.failuresAdded !== undefined ? <p className="note">新しく外へ出る失敗: {change.failuresAdded.join('、')}</p> : null}
      {change.failuresRemoved !== undefined ? <p className="note">外へ出なくなった失敗: {change.failuresRemoved.join('、')}</p> : null}
      {change.members !== undefined ? <p className="note">実装を変えたメンバー: {change.members.map((id) => id.slice(id.indexOf('#') + 1)).join('、')}（そのメンバーを呼ぶところすべてに届く）</p> : null}
      {change.untraceable !== undefined ? <p className="note">型で呼び先を引けない呼び出しが {change.untraceable} 個あります（届く先はその分を含みません）。</p> : null}
    </div>
  );
}

/**
 * What the pull request did to a frame: how it changed, the diff in words,
 * what the change notes say, and its diff on demand.
 */
export function ChangeDetail({ change, hunks }: { change: FrameChangeEntry; hunks?: readonly DiffHunk[] | undefined }) {
  const stat = diffStat(hunks);
  return (
    <section className="change" aria-label="このPRでの変更">
      <div className="change-head">
        <Badge mark={markOf(change.kind)} />
        <span className="change-title">{changeHeadline(change)}</span>
      </div>
      <ChangeSummary change={change} />
      <div className="change-notes">
        <ChangeNotes change={change} />
      </div>
      {hunks !== undefined && hunks.length > 0 ? (
        <details className="change-diff">
          <summary>
            差分を見る（+{stat.added} −{stat.removed}）
          </summary>
          <DiffView hunks={hunks} />
        </details>
      ) : null}
    </section>
  );
}
