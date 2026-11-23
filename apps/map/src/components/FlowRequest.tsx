import { useId, useState, type FormEvent } from 'react';
import { PREMISES } from '@maronn-openid-connect/map-sandbox/premises';
import { Rows } from './Rows';
import { PremisesPanel } from './PremisesPanel';
import { StoredReads, StoredWrites } from './StoredRecords';
import { carryOver, valuesBetween } from '../lib/premises';
import { basicCredentials, statusLine, statusTone, wayRequestsOf, PARAM_PLACES } from '../lib/requests';
import { blankDraft, bodiless, draftOf, draftProblem, oauthErrorOf, type ParamPlace, type RequestDraft } from '../lib/run';
import type { RootRequests, Selection, WaySample } from '../types';
import type { PreparedPremises } from '@maronn-openid-connect/map-sandbox';
import type { CurrentPremises, RootRequestsState } from './useRequests';
import type { RequestRunState } from './useRun';

/** The words of the body of a request, by its kind. */
const BODY_WORDS: Record<RequestDraft['body'], string> = { form: 'ボディ（フォーム）', json: 'ボディ（JSON）', none: 'ボディ' };

/** A request written on some premises, as written on others: their codes and tokens, grant by grant (carryOver); as it is when either is unknown or they are the same. */
function carried(draft: RequestDraft, from: PreparedPremises | undefined, to: PreparedPremises | undefined): RequestDraft {
  return from === undefined || to === undefined || from === to ? draft : carryOver(draft, valuesBetween(from, to));
}

/** The request the OP of the map answered the endpoint with, which the reader may copy to start a way no request is known for: the sample of an end it answered without an error, else the first sample. */
function baseSample(requests: RootRequests | undefined): { request: WaySample; way: string } | undefined {
  const ways = requests?.ways ?? [];
  const found = ways.find((way) => way.kind === 'exit' && way.sample !== undefined && way.sample.status < 400) ?? ways.find((way) => way.sample !== undefined);
  return found?.sample === undefined ? undefined : { request: found.sample, way: found.name.replace(/`/g, '') };
}

/** What a request run gave: the response, the way it ended by, and whether the playback follows the way it took. */
function RunResult({ run, ending, assumed, onFollow, premises }: { run: RequestRunState; ending: string | undefined; assumed: number; onFollow: () => void; premises: CurrentPremises['state'] }) {
  if (run.status === 'running') return <p className="note req-result">地図の OP で実行しています…（最初の実行では OP を読み込みます）</p>;
  if (run.status === 'failed') return <p className="note req-result req-problem">実行できませんでした: {run.message}</p>;
  const { response } = run.run;
  const error = response === undefined ? undefined : oauthErrorOf(response);
  const location = response?.headers.find(([name]) => name === 'location')?.[1];
  let body = response?.body;
  try {
    if (body !== undefined) body = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON: as it is.
  }
  return (
    <div className="req-result" aria-live="polite">
      {response === undefined ? (
        <p className="req-line req-problem">OP が応答せずに失敗しました: {run.run.error}</p>
      ) : (
        <p className="req-line">
          <span className="flow-label">応答</span>
          <span className={`req-status req-${statusTone(response.status)}`}>{statusLine(response)}</span>
          {error !== undefined ? <code className="mono req-error-code">{error}</code> : null}
        </p>
      )}
      {location !== undefined ? (
        <p className="req-line">
          <span className="flow-label">Location</span>
          <code className="mono req-path">{location}</code>
        </p>
      ) : null}
      {run.follow ? (
        <p className="note">
          このリクエストが通った道筋を再生しています{ending !== undefined ? `（${ending}）` : ''}。{assumed > 0 ? `実行からは決まらなかった分岐 ${assumed} 個は、仮の側へ進みます。` : ''}
        </p>
      ) : (
        <p className="note">
          ほかの側や道筋を選んだので、再生はこのリクエストの道筋から離れています。{' '}
          <button type="button" className="link small" onClick={onFollow}>
            このリクエストの道筋に戻す
          </button>
        </p>
      )}
      <StoredWrites wrote={run.run.store.wrote} now={PREMISES.now} premises={premises} />
      {body !== undefined ? (
        <details className="req-body">
          <summary>応答のボディ{response?.truncated === true ? '（16 KiB で切れています）' : ''}</summary>
          <pre className="mono">{body}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** What the flow view shows of the request of the way played (see FlowRequest). */
export interface FlowRequestProps {
  /** The requests the OP of the map took the ways of the root with (useRootRequests). */
  state: RootRequestsState;
  /** What the OP of the map holds before any request: the premises of the build, or those the reader made in the page (useCurrentPremises). */
  premises: CurrentPremises;
  /** The ready-made way chosen; undefined for おまかせ, a way the reader chose side by side, or the way of a request run. */
  selection: Selection | undefined;
  /** A request run is played: the request keeps the way it was taken from, whatever way the run took. */
  keep: boolean;
  /** How many decisions the way played takes on an assumed side. */
  assumed: number;
  /** The framework the map shows: express and fastify, generated from hono, run on the OP of hono, and say so. */
  framework: string;
  /** The method and the path of the endpoint the trace starts from; absent for the trace of a function, which takes no request of its own. */
  endpoint: { method: string; path: string } | undefined;
  /** Why the request cannot be run on the OP of the map; undefined when it can. */
  unrunnable: string | undefined;
  /** Some feature is off: the OP of the map runs with every feature. */
  featuresOff: boolean;
  /** The request run last, and what it gave. */
  run: RequestRunState | undefined;
  /** The ready-made way the run ended by, in words. */
  ending: string | undefined;
  onRun: (draft: RequestDraft) => void;
  onFollow: () => void;
}

/**
 * The request of the way the flow view plays, to read and to run. For a
 * ready-made way (a case) it starts as the request the OP of the map was
 * seen to take it with; for a way no request took, with no parameters (a
 * request of another way would not take it), which the reader may replace
 * with a copy of the request the OP answered the endpoint with, said to be
 * one that does not take the way. The reader writes its
 * query, its body and its headers and runs it on the OP of the map: the
 * response comes back, and the playback follows the way the request took
 * there (useRun.ts). Above the request, the records of the OP it reads (the
 * code, the refresh token, the client), each with its fields and the
 * requests that stored it when the build made the premises, or that the OP
 * holds none; after a run, those the run read, and below its response, the
 * records it stored, changed or removed. The values the OP holds and the
 * requests that made them are listed to write with. The tests play no part
 * here: what a test sent is the tests page's to show.
 */
export function FlowRequest({ state, premises, selection, keep, assumed, framework, endpoint, unrunnable, featuresOff, run, ending, onRun, onFollow }: FlowRequestProps) {
  const headingId = useId();
  // The way the request was taken from: a ready-made way picked later takes its place, and so does no way (おまかせ, sides the reader chose), while the way of a run keeps it.
  const [base, setBase] = useState<{ selection: Selection | undefined }>({ selection });
  if (selection !== base.selection && (selection !== undefined || !keep)) setBase({ selection });
  const requests = state.kind === 'ready' ? state.requests : undefined;
  const way = wayRequestsOf(requests, base.selection);
  // The request the OP of the map took the way with; a way no request took starts from no parameters, as a request of another way would not take it.
  const shown = way?.sample;
  const borrowable = base.selection === undefined || way !== undefined ? undefined : baseSample(requests);
  const originKey = `${base.selection?.kind ?? ''}|${base.selection?.target ?? ''}|${way?.id ?? ''}`;
  const origin = shown !== undefined ? draftOf(shown) : endpoint !== undefined ? blankDraft(endpoint.method, endpoint.path) : undefined;
  // What the reader wrote over it, the premises it was written on, and the way of the request it was copied from, when the reader copied one.
  const [edited, setEdited] = useState<{ key: string; draft: RequestDraft; on: PreparedPremises | undefined; copiedFrom?: string } | undefined>(undefined);
  // The premises a request runs on now: a request written on others (the samples on the build's) is carried over to them, its codes and tokens those of the same grants.
  const current = premises.made?.premises ?? premises.build;
  const changed = edited?.key === originKey;
  const draft = changed && edited !== undefined ? carried(edited.draft, edited.on, current) : origin === undefined ? undefined : carried(origin, premises.build, current);
  const copiedFrom = changed ? edited?.copiedFrom : undefined;
  // Once the reader writes over a copy, it is the reader's request, no longer the copy said not to take the case.
  const update = (next: RequestDraft) => setEdited({ key: originKey, draft: next, on: current });

  let note: string;
  if (base.selection === undefined) note = '「道筋」からケースを選ぶと、そのケースを通るリクエストから始めます。値を書いて実行すると、地図の OP で動かし、通った道筋を再生します。';
  else if (state.kind === 'loading') note = '読み込んでいます…';
  else if (state.kind === 'failed') note = `このケースを通るリクエストを読み込めませんでした: ${state.message}`;
  else if (shown !== undefined && premises.made !== undefined) note = '地図のビルドの前提で、このケースを通ると確かめたリクエストです。コードとトークンは、いまの前提の同じグラントのものに置き換えています。いまの前提でもこのケースを通るかは、実行して確かめます。';
  else if (shown !== undefined) note = '地図の OP で、このケースを通ると確かめたリクエストです。値を書き換えて実行すると、通る道筋がどう変わるかを再生します。';
  else if (copiedFrom !== undefined) note = `地図の OP が「${copiedFrom}」で応えたリクエストを写したものです。このケースは通りません。値を書き換えて実行すると、通った道筋を再生します。`;
  else note = 'このケースを通るリクエストは、地図の OP ではまだ見つかっていません。フローはこのケースの道筋を再生しています（決まらない分岐は仮の側）。リクエストを書いて実行すると、そのリクエストが通った道筋に替わります。';

  if (draft === undefined) {
    return (
      <section className="flow-request" aria-labelledby={headingId}>
        <h4 id={headingId}>リクエスト</h4>
        <p className="note req-empty">関数のトレースには、送るリクエストがありません。エンドポイントの画面で書いて実行できます。</p>
      </section>
    );
  }

  const problem = draftProblem(draft);
  const running = run?.status === 'running';
  // What the request reads of the records the OP holds: that of the request run, else that of the request the view started from.
  const ranStore = run?.status === 'done' ? run.run.store : undefined;
  const sampleStore = shown?.store;
  // The reads of the sample were seen on the premises of the build: on premises made again they may not be what the request reads.
  const reads =
    ranStore !== undefined
      ? { reads: ranStore.read, title: '実行したリクエストが読んだ、OP の保存済みの情報' }
      : sampleStore !== undefined && premises.made === undefined
        ? { reads: sampleStore.read, title: 'このリクエストが読む、OP の保存済みの情報', note: changed ? '書き換える前のリクエストが読むものです。実行すると、書き換えたリクエストが読んだものに替わります。' : undefined }
        : undefined;
  const noReads = premises.made !== undefined ? '前提を作り直したので、このリクエストが読むものは、実行して確かめます（ビルドの前提で読んだものは出しません）。実行すると、この前提で読んだもの、保存したものを出します。' : '実行すると、このリクエストが OP の保存済みの情報（認可コード、トークン、クライアントなど）から何を読み、何を保存したかを出します。';
  const groups: Array<{ place: ParamPlace; label: string }> = [{ place: 'query', label: PARAM_PLACES.query }, ...(bodiless(draft.method) ? [] : [{ place: draft.body === 'json' ? ('json' as const) : ('form' as const), label: BODY_WORDS[draft.body] }])];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem === undefined && unrunnable === undefined && !running) onRun(draft);
  };

  return (
    <section className="flow-request" aria-labelledby={headingId}>
      <div className="flow-request-head">
        <h4 id={headingId}>リクエスト</h4>
      </div>
      <p className="note req-empty">{note}</p>
      {reads !== undefined ? <StoredReads reads={reads.reads} premises={premises.state} title={reads.title} note={reads.note} /> : <p className="note">{noReads}</p>}
      <p className="note">前提（認可リクエストのスコープ、クライアントの grant_types など）は、下の「地図の OP が持っているもの」で書き換えて作り直せます。</p>
      <form className="req" onSubmit={submit} aria-label="実行するリクエスト">
        <p className="req-line">
          <span className="req-method">{draft.method}</span>
          <code className="req-path">{draft.path}</code>
          {shown !== undefined && !changed ? (
            <span className={`req-status req-${statusTone(shown.status)}`}>
              → {statusLine(shown)}（{premises.made === undefined ? '地図の OP' : 'ビルドの前提の地図の OP'}）
            </span>
          ) : null}
        </p>
        {borrowable !== undefined && !changed ? (
          <p className="note">
            <button type="button" className="link small" onClick={() => setEdited({ key: originKey, draft: carried(draftOf(borrowable.request), premises.build, current), on: current, copiedFrom: borrowable.way })}>
              地図の OP が「{borrowable.way}」で応えたリクエストを写して書き始める
            </button>
          </p>
        ) : null}
        {groups.map(({ place, label }) => {
          const rows = draft.params.map((param, index) => ({ param, index })).filter((item) => item.param.in === place);
          return (
            <Rows
              key={place}
              label={label}
              rows={rows.map((item) => item.param)}
              onChange={(index, name, value) => update({ ...draft, params: draft.params.map((param, at) => (at === rows[index]?.index ? { ...param, name, value } : param)) })}
              onAdd={() => update({ ...draft, params: [...draft.params, { name: '', value: '', in: place }] })}
              onRemove={(index) => update({ ...draft, params: draft.params.filter((_, at) => at !== rows[index]?.index) })}
            />
          );
        })}
        <Rows
          label="ヘッダー"
          rows={draft.headers.map(([name, value]) => ({ name, value }))}
          onChange={(index, name, value) => update({ ...draft, headers: draft.headers.map((header, at): [string, string] => (at === index ? [name, value] : header)) })}
          onAdd={() => update({ ...draft, headers: [...draft.headers, ['', '']] })}
          onRemove={(index) => update({ ...draft, headers: draft.headers.filter((_, at) => at !== index) })}
          note={(row) => {
            const credentials = row.name.trim().toLowerCase() === 'authorization' ? basicCredentials(row.value) : undefined;
            return credentials === undefined ? undefined : `↳ client_id: ${credentials.client}`;
          }}
        />
        {problem !== undefined ? <p className="note req-problem">{problem}</p> : null}
        {unrunnable !== undefined ? <p className="note">{unrunnable}</p> : null}
        {unrunnable === undefined && featuresOff ? <p className="note">地図の OP は全機能オンで動きます。オフの機能のステップを通るリクエストは、生成した OP とは道筋が変わります。</p> : null}
        {unrunnable === undefined && framework !== 'hono' ? <p className="note">{framework} の OP は hono の OP から生成したもので、このエンドポイントの処理は同じなので、hono の OP で動かします。</p> : null}
        <div className="req-actions">
          <button type="submit" className="flow-play req-run" disabled={problem !== undefined || unrunnable !== undefined || running}>
            {running ? '実行しています…' : '▶ このリクエストを実行'}
          </button>
          {changed ? (
            <button type="button" className="link small" onClick={() => setEdited(undefined)}>
              元のリクエストに戻す
            </button>
          ) : null}
        </div>
      </form>
      {run !== undefined ? <RunResult run={run} ending={ending} assumed={assumed} onFollow={onFollow} premises={premises.state} /> : null}
      <PremisesPanel premises={premises} />
    </section>
  );
}
