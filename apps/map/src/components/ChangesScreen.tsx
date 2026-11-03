import { useState } from 'react';
import type { DiffHunk, FrameChangeEntry, MapData, Reach } from '../types';
import { allHunks, changeName, groupChanges, markOf, type ChangeIndex } from '../lib/changes';
import { locationOf } from '../lib/model';
import { entryOf } from '../lib/trace';
import { Badge, ChangeNotes, ChangeSummary, DiffView, NoteText } from './ChangeParts';
import { fetchFrame } from './useFrames';

export interface ChangesScreenProps {
  data: MapData;
  index: ChangeIndex;
  framework: string;
  onOpenFunction: (id: string) => void;
  onOpenEndpoint: (id: string) => void;
  /** Open the trace of an endpoint along a way to a change: its frames open and its sides chosen. */
  onOpenWay: (way: Reach) => void;
}

/** The revision the changes are compared with: its name and its commit, or the commit alone when the name is the commit. */
function baseOf(base: { ref: string; commit: string }): string {
  const commit = base.commit.slice(0, 7);
  return base.commit.startsWith(base.ref) ? commit : `${base.ref}（${commit}）`;
}

/** The diff of a frame, read from its file when the reader opens it. */
function LazyDiff({ data, id }: { data: MapData; id: string }) {
  const [hunks, setHunks] = useState<DiffHunk[] | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const url = entryOf(data, id)?.frame;
  return (
    <details
      className="change-diff"
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open || hunks !== undefined || url === undefined || url === '') return;
        fetchFrame(url)
          .then((file) => setHunks(allHunks(file.change)))
          .catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)));
      }}
    >
      <summary>差分を見る</summary>
      {failed !== undefined ? <p className="note">読み込めませんでした: {failed}</p> : hunks === undefined ? <p className="note">読み込んでいます…</p> : <DiffView hunks={hunks} />}
    </details>
  );
}

/** The ways a change reaches the endpoints: each a button that opens the trace along it. */
function Ways({ data, entry, framework, onOpenWay }: { data: MapData; entry: FrameChangeEntry; framework: string; onOpenWay: (way: Reach) => void }) {
  if (entry.reach.length === 0) return <p className="note">{entry.body === true ? 'エンドポイントの処理そのものです。' : 'どのエンドポイントからも届きません。'}</p>;
  const ordered = [...entry.reach].sort((a, b) => Number(!a.frameworks.includes(framework)) - Number(!b.frameworks.includes(framework)));
  return (
    <ul className="ways">
      {ordered.map((way, index) => {
        const flow = data.flows[way.frameworks.includes(framework) ? framework : (way.frameworks[0] as string)];
        const endpoint = flow?.endpoints.find((candidate) => candidate.id === way.endpoint);
        const step = endpoint?.steps.find((candidate) => candidate.id === way.step);
        const via = way.via.slice(0, -1).map((id) => entryOf(data, id)?.name ?? id);
        return (
          <li key={index}>
            <button type="button" className="row" onClick={() => onOpenWay(way)}>
              <span className="row-title">
                {endpoint?.label ?? way.endpoint}
                {step !== undefined ? ` › ${step.label}` : ''}
                {via.length > 0 ? ` › ${via.join(' › ')}` : ''} › {changeName(data, entry)}
              </span>
              <span className="row-text">
                {way.source === 'hono' ? 'Hono・Express・Fastify' : 'Next.js'}
                {Object.keys(way.decisions).length > 0 ? ` · 決定 ${Object.keys(way.decisions).length} 個を選んで開く` : ''}
                {way.features.length > 0 ? ` · 要る機能: ${way.features.join('、')}` : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One changed frame: its badge and name, where it is, the diff in words, the notes, the diff, and the ways it reaches the endpoints. */
function ChangeRow({ data, entry, framework, onOpenFunction, onOpenWay }: { data: MapData; entry: FrameChangeEntry; framework: string; onOpenFunction: (id: string) => void; onOpenWay: (way: Reach) => void }) {
  const name = changeName(data, entry);
  const opens = entry.kind !== 'removed' && entry.body !== true && data.functions[entry.id] !== undefined;
  return (
    <li className="change-row">
      <div className="change-row-head">
        <Badge mark={markOf(entry.kind)} />
        {opens ? (
          <button type="button" className="link mono" onClick={() => onOpenFunction(entry.id)}>
            {name}
          </button>
        ) : (
          <span className="mono">{name}</span>
        )}
        <span className="muted mono where-inline">{locationOf(entry)}</span>
        {entry.from !== undefined ? <span className="muted">（{entry.from} から移した）</span> : null}
        {entry.required && !entry.documented ? <span className="badge badge-required">説明なし</span> : null}
      </div>
      <ChangeSummary change={entry} />
      <ChangeNotes change={entry} />
      {entry.kind === 'modified' || entry.kind === 'added' || entry.kind === 'docs' ? <LazyDiff data={data} id={entry.id} /> : null}
      {entry.kind === 'modified' || entry.kind === 'added' ? (
        <section>
          <h4>届く経路</h4>
          <Ways data={data} entry={entry} framework={framework} onOpenWay={onOpenWay} />
        </section>
      ) : null}
    </li>
  );
}

/**
 * The changes of the pull request, the way into its review: first the
 * changes that need a note and have none, then what its notes say it does,
 * then every changed frame with the diff in words, its notes, its diff and
 * the ways it reaches the endpoints (each opens the trace along it).
 */
export function ChangesScreen({ data, index, framework, onOpenFunction, onOpenEndpoint, onOpenWay }: ChangesScreenProps) {
  const { changes } = index;
  const groups = groupChanges(changes);
  const missing = changes.frames.filter((entry) => (entry.kind === 'added' || entry.kind === 'modified') && !entry.documented);
  const counted = changes.frames.filter((entry) => entry.kind !== 'noted').length;
  const pullRequest = changes.pullRequest;
  const endpoints = new Map<string, number>();
  for (const entry of changes.frames) for (const way of entry.reach) if (way.frameworks.includes(framework)) endpoints.set(way.endpoint, (endpoints.get(way.endpoint) ?? 0) + 1);
  const flow = data.flows[framework];
  return (
    <section className="screen changes-screen" aria-label="このPRの変更">
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
          変えた関数とエンドポイントの処理 {counted} 個 · 地図に載らないファイルの変更 {changes.otherFiles} 個 · 何を変えたかとどこに効くかは地図が計算し、なぜ変えたかは変更メモ（<code>apps/map/changes/*.md</code>）が書きます
        </p>
      </header>
      <div className="work with-pane changes-work">
        <div className="changes-body">
          {missing.length > 0 ? (
            <section className="undocumented" aria-label="説明の無い変更">
              <h3>説明の無い変更（{missing.length}）</h3>
              <p className="note">
                {changes.undocumented.length > 0
                  ? `このうち ${changes.undocumented.length} 個はエンドポイントに届く変更かエンドポイントの処理の変更で、変更メモに説明が要ります（無いと地図の検査が落ちます）。雛形は pnpm --filter @maronn-openid-connect/map changes:draft で書けます。`
                  : 'どれもエンドポイントに届かないので、検査は落ちません。'}
              </p>
              <ul className="change-list">
                {missing.map((entry) => (
                  <ChangeRow key={entry.id} data={data} entry={entry} framework={framework} onOpenFunction={onOpenFunction} onOpenWay={onOpenWay} />
                ))}
              </ul>
            </section>
          ) : null}
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
              <p className="note">このPRには変更メモがありません。なぜ変えたかを書くと、ここと各関数のページに表示されます（書き方は apps/map/changes/README.md）。</p>
            )}
            {changes.unmatched.map((section, at) => (
              <article key={`${section.file}/${at}`} className="pr-note">
                <h4>{section.heading}</h4>
                <NoteText text={section.text} />
              </article>
            ))}
            {changes.ambiguous.map((warning) => (
              <p key={`${warning.file}/${warning.reference}`} className="note">
                見出し <code>{warning.reference}</code>（{warning.file}）は {warning.matches.length} 個の変更に当たります。ルート（<code>core:{warning.reference}</code>）か id で絞り込んでください。
              </p>
            ))}
          </section>
          {groups.length === 0 ? <p className="note">地図に載る関数とエンドポイントの処理は変えていません。</p> : null}
          {groups.map((group) => (
            <details key={group.kind} className="change-group" open={group.frames.length <= 40}>
              <summary>
                <h3>
                  {group.heading}（{group.frames.length}）
                </h3>
              </summary>
              <ul className="change-list">
                {group.frames.map((entry) => (
                  <ChangeRow key={entry.id} data={data} entry={entry} framework={framework} onOpenFunction={onOpenFunction} onOpenWay={onOpenWay} />
                ))}
              </ul>
            </details>
          ))}
          {changes.outside.length > 0 ? (
            <section>
              <h3>関数の外の変更</h3>
              <p className="note">import、型、定数など、どのフレームにも属さない行です。</p>
              <ul className="plain">
                {changes.outside.map((file) => (
                  <li key={file.file} className="mono">
                    {file.file}: {file.lines.length} 行
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        <aside className="side-panel" aria-label="変更が届くエンドポイント">
          <h3>変更が届くエンドポイント（{framework}）</h3>
          {endpoints.size === 0 ? <p className="note">このPRの変更は、このフレームワークのどのエンドポイントにも届きません。</p> : null}
          <ul className="links">
            {[...endpoints].map(([id, count]) => {
              const endpoint = flow?.endpoints.find((candidate) => candidate.id === id);
              return (
                <li key={id}>
                  <button type="button" className="row" onClick={() => onOpenEndpoint(id)}>
                    <span className="route mono">
                      {endpoint?.methods.join(' | ')} {endpoint?.path}
                    </span>
                    <span className="row-title">
                      <Badge mark={markOf('inside')} /> {endpoint?.label ?? id}
                    </span>
                    <span className="row-text">経路 {count} 本</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
    </section>
  );
}
