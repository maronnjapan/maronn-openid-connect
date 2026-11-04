import type { DiffHunk, FrameChangeEntry, MapData } from '../types';
import { countWords, diffStat, failureCatchers, inlineParts, markOf, noteBlocks, numberHunk, type Mark } from '../lib/changes';
import { entryOf } from '../lib/trace';

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

/** What a change summary needs besides the change: the map (the names of the endpoints and the frames), the framework shown, and a way to open a function. */
export interface ChangeContext {
  data: Pick<MapData, 'flows' | 'functions' | 'bodies'>;
  framework: string;
  onOpenFunction?: ((id: string) => void) | undefined;
}

/** The name of an endpoint of a way, by its label in the framework shown (the source's first framework for the other source). */
function endpointName(data: ChangeContext['data'], framework: string, way: { endpoint: string; source: string }): string {
  const shown = way.source === (framework === 'nextjs' ? 'nextjs' : 'hono') ? framework : way.source;
  const label = data.flows[shown]?.endpoints.find((candidate) => candidate.id === way.endpoint)?.label ?? way.endpoint;
  return shown === framework ? label : `${label}（${shown === 'nextjs' ? 'Next.js' : 'Hono'}）`;
}

/**
 * The diff of a frame in words: what the tree diff found, with the counts;
 * the failures it makes leave the frame, and where each is caught on the
 * ways from the endpoints of the framework shown; the members whose
 * implementation it changed; and the calls the types do not tell, inside
 * it (the map cannot follow them down) and outside it that may call it
 * (the ways it reaches leave them out).
 */
export function ChangeSummary({ change, data, framework, onOpenFunction }: { change: FrameChangeEntry } & ChangeContext) {
  if (change.summary.length === 0) return null;
  const counts = countWords(change.counts);
  const catchers = change.failuresAdded === undefined ? [] : failureCatchers(change, framework);
  const callers = change.untraceableCallers ?? [];
  const frameName = (id: string) => {
    const entry = entryOf(data, id);
    return entry === undefined ? id.slice(id.indexOf('#') + 1) : 'endpoint' in entry ? entry.name : `${entry.name}()`;
  };
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
      {change.failuresAdded !== undefined ? (
        <div className="note change-effect">
          <p>
            新しく外へ出る失敗:{' '}
            {change.failuresAdded.map((error, index) => (
              <span key={error}>
                {index > 0 ? '、' : ''}
                <code>{error}</code>
              </span>
            ))}
          </p>
          {catchers.length > 0 ? (
            <ul className="plain">
              {catchers.map((catcher) => (
                <li key={`${catcher.kind}:${catcher.by ?? ''}`}>
                  {catcher.kind === 'answer' ? (
                    <>
                      catch で捕まえて <code>{catcher.by}</code> が応答する
                    </>
                  ) : catcher.kind === 'frame' ? (
                    <>
                      <code>{catcher.by}</code> の catch で捕まえる
                    </>
                  ) : (
                    'どこでも捕まえずにエンドポイントの外へ出る'
                  )}
                  （{catcher.endpoints.map((way) => endpointName(data, framework, way)).join('、')}）
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {change.failuresRemoved !== undefined ? <p className="note">外へ出なくなった失敗: {change.failuresRemoved.join('、')}</p> : null}
      {change.members !== undefined ? <p className="note">実装を変えたメンバー: {change.members.map((id) => id.slice(id.indexOf('#') + 1)).join('、')}（型で引けるそのメンバーの呼び出しすべてに届く）</p> : null}
      {callers.length > 0 ? (
        <div className="note change-effect untraceable-callers">
          <p>
            <span className="badge badge-required">追えない呼び出しあり</span> 型で呼び先を引けない次の {callers.length} 箇所の呼び出しが、この変更を呼んでいるかもしれません。届く経路にはこれらを入れていません。
          </p>
          <ul className="plain">
            {callers.map((site) => (
              <li key={`${site.frame}/${site.node}`}>
                {onOpenFunction !== undefined && data.functions[site.frame] !== undefined ? (
                  <button type="button" className="link mono" onClick={() => onOpenFunction(site.frame)}>
                    {frameName(site.frame)}
                  </button>
                ) : (
                  <span className="mono">{frameName(site.frame)}</span>
                )}
                : {site.why}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {change.untraceable !== undefined ? <p className="note">この中の {change.untraceable} 個の呼び出しは型で呼び先を引けないため、地図はその先をたどれません（その先の変更は下の変更に数えていません）。</p> : null}
    </div>
  );
}

/**
 * What the pull request did to a frame: how it changed, the diff in words,
 * what the change notes say, and its diff on demand.
 */
export function ChangeDetail({ change, hunks, ...context }: { change: FrameChangeEntry; hunks?: readonly DiffHunk[] | undefined } & ChangeContext) {
  const stat = diffStat(hunks);
  return (
    <section className="change" aria-label="このPRでの変更">
      <div className="change-head">
        <Badge mark={markOf(change.kind)} />
        <span className="change-title">{changeHeadline(change)}</span>
      </div>
      <ChangeSummary change={change} {...context} />
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
