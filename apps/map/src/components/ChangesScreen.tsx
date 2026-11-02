import { useMemo } from 'react';
import type { FunctionChange, MapData, OpFlow } from '../types';
import { endpointMark, groupChanges, markOf, marksCode, type ChangeIndex, type Mark } from '../lib/changes';
import { locationOf } from '../lib/model';
import { Badge, ChangeNotes, NoteText } from './ChangeParts';

export interface ChangesScreenProps {
  data: MapData;
  index: ChangeIndex;
  /** The flow of the framework shown, every feature on: the endpoints a change shows in. */
  flow: OpFlow;
  onOpenFunction: (id: string) => void;
  onOpenEndpoint: (id: string) => void;
}

/** Groups longer than this start folded, so a pull request that touches every JSDoc does not bury the others. */
const OPEN_UP_TO = 40;

/** The revision the changes are compared with: its name and its commit, or the commit alone when the name is the commit. */
function baseOf(base: { ref: string; commit: string }): string {
  const commit = base.commit.slice(0, 7);
  return base.commit.startsWith(base.ref) ? commit : `${base.ref}（${commit}）`;
}

/** Endpoints with their badge, each a link to the endpoint. */
function MarkedEndpoints({ marked, onOpenEndpoint }: { marked: ReadonlyArray<{ endpoint: OpFlow['endpoints'][number]; mark: Mark }>; onOpenEndpoint: (id: string) => void }) {
  return (
    <ul className="links">
      {marked.map(({ endpoint, mark }) => (
        <li key={endpoint.id}>
          <button type="button" className="row" onClick={() => onOpenEndpoint(endpoint.id)}>
            <span className="route mono">
              {endpoint.methods.join(' | ')} {endpoint.path}
            </span>
            <span className="row-title">
              <Badge mark={mark} /> {endpoint.label}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** One changed function: its badge and name (a link to its page, unless it was removed), where it is, and what the notes say. */
function ChangeRow({ change, onOpenFunction }: { change: FunctionChange; onOpenFunction: (id: string) => void }) {
  const name = `${change.name}()`;
  return (
    <li className="change-row">
      <div className="change-row-head">
        <Badge mark={markOf(change.kind)} />
        {change.kind === 'removed' ? (
          <span className="mono">{name}</span>
        ) : (
          <button type="button" className="link mono" onClick={() => onOpenFunction(change.id)}>
            {name}
          </button>
        )}
        <span className="muted mono where-inline">{locationOf(change)}</span>
        {change.from !== undefined ? <span className="muted">（{change.from} から移した）</span> : null}
      </div>
      {change.kind === 'removed' && change.summary ? <p className="note">{change.summary}</p> : null}
      <ChangeNotes change={change} />
    </li>
  );
}

/**
 * The changes of the pull request the map is built for: what its change
 * notes say it does, the functions it changed grouped by how (each with what
 * the notes say about it), and the endpoints whose diagrams show a badge.
 */
export function ChangesScreen({ data, index, flow, onOpenFunction, onOpenEndpoint }: ChangesScreenProps) {
  const { changes } = index;
  const groups = useMemo(() => groupChanges(changes), [changes]);
  const marked = useMemo(
    () => flow.endpoints.flatMap((endpoint) => {
      const mark = endpointMark(index, data, flow, endpoint);
      return mark === undefined ? [] : [{ endpoint, mark }];
    }),
    [index, data, flow],
  );
  const code = marked.filter(({ mark }) => marksCode(mark));
  const rest = marked.filter(({ mark }) => !marksCode(mark));
  const counted = changes.functions.filter((change) => change.kind !== 'noted').length;
  const pullRequest = changes.pullRequest;
  return (
    <section className="screen" aria-label="このPRの変更">
      <header className="screen-head">
        <div className="title-row">
          <h2>このPRの変更</h2>
          {pullRequest !== undefined ? (
            pullRequest.url !== undefined ? (
              <a className="chip" href={pullRequest.url} target="_blank" rel="noreferrer">
                #{pullRequest.number}
              </a>
            ) : (
              <span className="chip">#{pullRequest.number}</span>
            )
          ) : null}
          <span className="chip mono" title={changes.base.commit}>
            {baseOf(changes.base)} からの差分{changes.head.dirty ? '・未コミットの変更を含む' : ''}
          </span>
        </div>
        {pullRequest?.title !== undefined ? <p className="lead">{pullRequest.title}</p> : null}
        <p className="note">
          変えた関数 {counted} 個 · 地図に載らないファイルの変更 {changes.otherFiles} 個 · 図の箱と左の一覧に、このPRの変更の札（変更・追加・中で変更・説明など）が付きます
        </p>
      </header>
      <div className="work with-panel changes-work">
        <div className="changes-body">
          <section className="pr-notes" aria-label="変更メモ">
            <h3>変更メモ</h3>
            {changes.notes.length > 0 ? (
              changes.notes.map((note) => (
                <article key={note.file} className="pr-note">
                  {note.title !== undefined ? <h4>{note.title}</h4> : null}
                  {note.summary !== '' ? <NoteText text={note.summary} /> : null}
                  <p className="where mono">{note.file}</p>
                </article>
              ))
            ) : (
              <p className="note">
                このPRには変更メモ（<code>apps/map/changes/*.md</code>）がありません。どの関数をどう変えたかを書くと、ここと各関数のページに表示されます（書き方は <code>apps/map/changes/README.md</code>）。
              </p>
            )}
            {changes.unmatched.map((section, at) => (
              <article key={`${section.file}/${at}`} className="pr-note">
                <h4>{section.heading}</h4>
                <NoteText text={section.text} />
              </article>
            ))}
          </section>
          {groups.length === 0 ? <p className="note">地図に載る関数（関数カタログ）は変えていません。</p> : null}
          {groups.map((group) => (
            <details key={group.kind} className="change-group" open={group.functions.length <= OPEN_UP_TO}>
              <summary>
                <h3>
                  {group.heading}（{group.functions.length}）
                </h3>
              </summary>
              <ul className="change-list">
                {group.functions.map((change) => (
                  <ChangeRow key={change.id} change={change} onOpenFunction={onOpenFunction} />
                ))}
              </ul>
            </details>
          ))}
        </div>
        <aside className="side-panel" aria-label="札の付くエンドポイント">
          <h3>札の付くエンドポイント</h3>
          {marked.length === 0 ? <p className="note">このPRで変えた関数は、どのエンドポイントのステップからも呼ばれません。</p> : null}
          {code.length > 0 ? (
            <section>
              <h4>コードの変更が届くエンドポイント（{code.length}）</h4>
              <MarkedEndpoints marked={code} onOpenEndpoint={onOpenEndpoint} />
            </section>
          ) : null}
          {rest.length > 0 ? (
            <section>
              <h4>JSDoc・移動・メモだけのエンドポイント（{rest.length}）</h4>
              <MarkedEndpoints marked={rest} onOpenEndpoint={onOpenEndpoint} />
            </section>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
