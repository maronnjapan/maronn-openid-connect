import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ExchangeSummary } from '@maronn-openid-connect/live-op/api';
import type { RequestScenario } from '@maronn-openid-connect/test-catalog/premises';
import { LiveStatePanel } from './LiveStatePanel';
import { RecentExchanges } from './RecentExchanges';
import { Rows } from './Rows';
import { StoredReads, StoredWrites } from './StoredRecords';
import { browserPath, expectationGaps, SOURCE_WORDS } from '../lib/live';
import { basicCredentials, statusLine, statusTone, wayRequestsOf, PARAM_PLACES } from '../lib/requests';
import { blankDraft, bodiless, draftProblem, headerValue, liveRequestOf, oauthErrorOf, type ParamPlace, type RequestDraft } from '../lib/run';
import type { MapData, Selection } from '../types';
import type { RootRequestsState } from './useRequests';
import { useLiveState } from './useLive';
import type { Replay, RequestRunState } from './useRun';

/** The words of the body of a request, by its kind. */
const BODY_WORDS = { form: 'ボディ（フォーム）', json: 'ボディ（JSON）' };

/** The OP's clock at a time (Unix milliseconds) in the reader's locale. */
function clockOf(at: number): string {
  return new Date(at).toLocaleString('ja-JP', { hour12: false });
}

/** What a request run shows besides its state (see RunResult). */
interface RunResultProps {
  run: RequestRunState;
  replay: Replay | undefined;
  /** The ready-made way the replay ended by, in words. */
  ending: string | undefined;
  /** How many decisions the way played takes on an assumed side. */
  assumed: number;
  /** What the case selected expects of its response; undefined without a case. */
  expected: RequestScenario['expected'] | undefined;
  onFollow: () => void;
  onOpen: (id: string) => void;
}

/**
 * What a request gave on the live OP: which exchange it is (sent from the
 * page, or opened from the list), the response as the OP sent it (its
 * status, every header, each Set-Cookie and the Location among them, the
 * body) and its OAuth error, the response its case expects beside it, how
 * the replay follows the way it took, and the records it read and wrote.
 * Times are the OP's clock when the request came.
 */
function RunResult({ run, replay, ending, assumed, expected, onFollow, onOpen }: RunResultProps) {
  const live = useLiveState();
  const records = live.kind === 'ready' ? live.state.records : undefined;
  // A new response is brought into view in the scroll of the request, where it comes below the form.
  const panel = useRef<HTMLDivElement>(null);
  const shownId = run.status === 'done' ? run.exchange.id : undefined;
  useEffect(() => {
    if (shownId !== undefined) panel.current?.scrollIntoView({ block: 'nearest' });
  }, [shownId]);
  if (run.status === 'running') return <p className="note req-result">{run.opening !== undefined ? `記録したリクエスト ${run.opening} を読み込んでいます…` : '地図の OP に送っています…'}</p>;
  if (run.status === 'failed') return <p className="note req-result req-problem">{run.unreachable ? run.message : `実行できませんでした: ${run.message}`}</p>;
  const { exchange } = run;
  const { response } = exchange;
  const error = response === undefined ? undefined : oauthErrorOf(response);
  const location = response === undefined ? undefined : headerValue(response.headers, 'location');
  const gaps = expected === undefined || response === undefined ? [] : expectationGaps(expected, { status: response.status, error, location });
  let body = response?.body;
  try {
    if (body !== undefined) body = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON: as it is.
  }
  const now = Math.floor(exchange.at / 1000);
  return (
    <div className="req-result" aria-live="polite" ref={panel}>
      <p className="req-line">
        <span className="flow-label">{run.opened ? '開いたリクエスト' : '実行したリクエスト'}</span>
        <span className="mono store-num">{exchange.id}</span>
        <span className={`req-source req-source-${exchange.source}`}>{SOURCE_WORDS[exchange.source]}</span>
        <span className="req-at" title="OP の時計">
          {clockOf(exchange.at)}
        </span>
      </p>
      {run.opened ? (
        <p className="req-line">
          <span className="req-method">{exchange.method}</span>
          <code className="req-path">{exchange.path}</code>
        </p>
      ) : null}
      {response === undefined ? (
        <p className="req-line req-problem">OP が応答せずに失敗しました: {exchange.thrown}</p>
      ) : (
        <p className="req-line">
          <span className="flow-label">応答</span>
          <span className={`req-status req-${statusTone(response.status)}`}>{statusLine(response)}</span>
          {error !== undefined ? <code className="mono req-error-code">{error}</code> : null}
        </p>
      )}
      {expected !== undefined && response !== undefined ? (
        <p className={`req-line req-expected${gaps.length > 0 ? ' req-problem' : ''}`}>
          <span className="flow-label">ケースが期待する応答</span>
          <span>
            {statusLine({ status: expected.status })}
            {expected.error !== undefined ? <code className="mono"> {expected.error}</code> : null}
          </span>
          <span className="req-note req-expected-words">{expected.description}</span>
          <span className={gaps.length > 0 ? 'req-gap' : 'req-match'}>{gaps.length > 0 ? `✗ 期待と違う: ${gaps.join('、')}` : '✓ ステータスと OAuth のエラーは期待どおり'}</span>
        </p>
      ) : null}
      {!run.follow ? (
        <p className="note">
          ほかの側や道筋を選んだので、再生はこのリクエストの道筋から離れています。{' '}
          <button type="button" className="link small" onClick={onFollow}>
            このリクエストの道筋に戻す
          </button>
        </p>
      ) : replay === undefined ? (
        <p className="note">このリクエストが動かした順を、地図の木で読んでいます…</p>
      ) : replay.problem !== undefined ? (
        <p className="note req-problem">{replay.problem}</p>
      ) : !replay.rootRan ? (
        <p className="note req-notran">このリクエストではエンドポイントの処理は動いていません（{response === undefined ? 'OP は応答せずに失敗しました' : `${response.status} はルーティングかミドルウェアが返しました`}）。再生する道筋はありません。</p>
      ) : (
        <p className="note">
          このリクエストが通った道筋を再生しています{ending !== undefined ? `（${ending}）` : ''}。{assumed > 0 ? `規則で読めない分岐 ${assumed} 個は、仮の側へ進みます。` : ''}
        </p>
      )}
      {run.follow && replay !== undefined && replay.mismatches.length > 0 ? (
        <p className="note req-problem" role="alert">
          ⚠ 再生する道筋に、このリクエストが動かしていない所が {replay.mismatches.length} か所あります（地図の読み方の不具合です）: {replay.mismatches.slice(0, 3).map((mismatch) => mismatch.code).join('、')}
        </p>
      ) : null}
      {response !== undefined ? (
        <table className="req-table req-headers">
          <caption>応答のヘッダー（{response.headers.length}）</caption>
          <tbody>
            {response.headers.map(([name, value], index) => (
              <tr key={index}>
                <th className="mono">{name}</th>
                <td>
                  <code className="mono">{value}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {body !== undefined ? (
        <details className="req-body" open={body.length <= 4000}>
          <summary>応答のボディ{response?.truncated === true ? '（16 KiB で切れています）' : ''}</summary>
          <pre className="mono">{body}</pre>
        </details>
      ) : null}
      <StoredReads reads={exchange.store.read} records={records} now={now} onOpen={onOpen} />
      <StoredWrites wrote={exchange.store.wrote} records={records} now={now} onOpen={onOpen} />
    </div>
  );
}

/** What the flow view shows of the request (see FlowRequest). */
export interface FlowRequestProps {
  data: MapData;
  /** What the cases do at the root (useRootRequests): the cases that take the way picked. */
  requests: RootRequestsState;
  /** The ready-made way picked; undefined for おまかせ, sides the reader chose, or the way of a request run. */
  selection: Selection | undefined;
  /** The case selected, with the request prepared for it once it is. */
  generatedCase?: { key: string; draft?: RequestDraft; scenario: RequestScenario } | undefined;
  /** The request of an exchange the reader opened, to write on. */
  origin: { key: string; draft: RequestDraft } | undefined;
  /** How many decisions the way played takes on an assumed side. */
  assumed: number;
  /** The framework the map shows: express and fastify, generated from hono, run on the OP of hono, and say so. */
  framework: string;
  /** The endpoint the trace starts from (its id, method and path); absent for the trace of a function, which takes no request of its own. */
  endpoint: { id: string; method: string; path: string } | undefined;
  /** The endpoints of the OP, for the list of the recent requests. */
  endpoints: ReadonlyArray<{ id: string; path: string; label?: string }>;
  /** Why the request cannot be run on the live OP; undefined when it can. */
  unrunnable: string | undefined;
  /** The live OP runs the requests of this framework's flows (hono, express, fastify): the recent requests and the state of the workspace show. */
  live: boolean;
  /** Some feature is off: the live OP runs with every feature. */
  featuresOff: boolean;
  /** The request run last (or the exchange opened), and what it gave. */
  run: RequestRunState | undefined;
  replay: Replay | undefined;
  /** The ready-made way the run ended by, in words. */
  ending: string | undefined;
  /** The title of a case, by its id. */
  caseTitle: (id: string) => string | undefined;
  onRun: (draft: RequestDraft) => void;
  onFollow: () => void;
  /** Select a case and prepare its request. */
  onPrepareCase: (id: string) => void;
  /** Open an exchange of the workspace: from the list, or by its id (a record's provenance, a grant's steps). */
  onOpenExchange: (summary: ExchangeSummary) => void;
  onOpenExchangeId: (id: string) => void;
}

/**
 * The request the flow view runs on the live OP (the map's OP): written
 * from the request of the case selected (prepared on the reader's
 * workspace), the request of an exchange the reader opened, or nothing;
 * for a ready-made way, the cases whose request took it, to prepare one.
 * The reader writes its query, its body and its headers and sends it: the
 * response comes back, and the playback follows the way the request took
 * (useRun.ts). A GET of a page a browser opens opens in a tab as well,
 * whose requests come to the same workspace. Below: the recent requests of
 * the workspace (any of them opens without being sent again), and the
 * state of the workspace.
 */
export function FlowRequest({ data, requests, selection, generatedCase, origin, assumed, framework, endpoint, endpoints, unrunnable, live: served, featuresOff, run, replay, ending, caseTitle, onRun, onFollow, onPrepareCase, onOpenExchange, onOpenExchangeId }: FlowRequestProps) {
  const headingId = useId();
  const live = useLiveState();
  const originKey = origin !== undefined ? origin.key : generatedCase !== undefined ? `case:${generatedCase.key}` : 'blank';
  const base = origin !== undefined ? origin.draft : generatedCase !== undefined ? generatedCase.draft : endpoint !== undefined ? blankDraft(endpoint.method, endpoint.path) : undefined;
  // What the reader wrote over it: forgotten when the request it was written from changes.
  const [edited, setEdited] = useState<{ key: string; draft: RequestDraft } | undefined>(undefined);
  if (edited !== undefined && edited.key !== originKey) setEdited(undefined);
  const changed = edited?.key === originKey;
  const draft = changed ? edited?.draft : base;
  const update = (next: RequestDraft) => setEdited({ key: originKey, draft: next });
  const ready = requests.kind === 'ready' ? requests.requests : undefined;
  const cases = generatedCase === undefined && origin === undefined && selection !== undefined ? (wayRequestsOf(ready, selection)?.scenarios ?? []) : [];

  let note: string;
  if (origin !== undefined) note = `ワークスペースが記録したリクエスト ${origin.key.slice(2)} です。送り直さずに、その道筋を再生しています。書き換えて実行すると、地図の OP に送ります。`;
  else if (generatedCase !== undefined) note = unrunnable ?? 'このケースのために地図の OP で準備したリクエストです。実行すると地図の OP に送り、実際に通った道筋を再生します。OP は状態を保つので、同じ認可コードを二度送れば二度目は使用済みで失敗します。';
  else if (selection !== undefined && requests.kind === 'loading') note = 'この道筋を通るケースを読み込んでいます…';
  else if (selection !== undefined && requests.kind === 'failed') note = `この道筋を通るケースを読み込めませんでした: ${requests.message}`;
  else if (selection !== undefined && cases.length === 0) note = 'この道筋を通るケースは、地図のビルドでは見つかっていません。フローはこの道筋を再生しています（決まらない分岐は仮の側）。リクエストを書いて実行すると、そのリクエストが通った道筋に替わります。';
  else if (selection !== undefined) note = 'この道筋は、次のケースのリクエストが地図の OP で通りました。ケースを選ぶと、そのリクエストを地図の OP で準備します。';
  else note = '値を書いて実行すると、地図の OP に送り、実際に通った道筋を再生します。「想定リクエスト」のケースか、「コードの道筋」で選んだ道筋を通るケースから、リクエストを作れます。';

  const connection = !served ? null : live.kind === 'failed' && live.unreachable ? (
    <p className="note req-problem" role="alert">{live.message}</p>
  ) : live.kind === 'ready' && data.liveOp !== undefined && live.state.probes !== data.liveOp.probes ? (
    <p className="note req-problem" role="alert">
      ⚠ 地図のデータと地図の OP は、別のコードからビルドされています（データ {data.liveOp.probes}、OP {live.state.probes}）。道筋が実際とずれることがあるので、地図のデータを作り直してください（pnpm --filter @maronn-openid-connect/map data）。
    </p>
  ) : null;

  if (draft === undefined) {
    return (
      <section className="flow-request" aria-labelledby={headingId}>
        <h4 id={headingId}>リクエスト</h4>
        {connection}
        {generatedCase === undefined ? <p className="note req-empty">エンドポイントの画面でリクエストを書いて実行できます。</p> : <p className="note req-empty">{unrunnable ?? '地図の OP で、このケースのリクエストを準備しています…'}</p>}
        {endpoint !== undefined && served ? <RecentExchanges endpoints={endpoints} endpoint={endpoint.id} current={run?.status === 'done' ? run.exchange.id : undefined} onOpen={onOpenExchange} /> : null}
      </section>
    );
  }

  const problem = draftProblem(draft);
  const running = run?.status === 'running';
  const request = liveRequestOf(draft);
  const opens = endpoint === undefined || unrunnable !== undefined ? undefined : browserPath(endpoint.id, request);
  const groups: Array<{ place: ParamPlace; label: string }> = [{ place: 'query', label: PARAM_PLACES.query }];
  if (!bodiless(draft.method) && (draft.body === 'json' || draft.body === 'form')) groups.push({ place: draft.body, label: BODY_WORDS[draft.body] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problem === undefined && unrunnable === undefined && !running) onRun(draft);
  };

  return (
    <section className="flow-request" aria-labelledby={headingId}>
      <div className="flow-request-head">
        <h4 id={headingId}>リクエスト</h4>
      </div>
      {connection}
      <p className="note req-empty">{note}</p>
      {cases.length > 0 ? (
        <ul className="plain way-cases">
          {cases.map((id) => (
            <li key={id}>
              <button type="button" className="code-button" onClick={() => onPrepareCase(id)}>
                このケースで、この道筋を通るリクエストを作る: {caseTitle(id) ?? id}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="req" onSubmit={submit} aria-label="実行するリクエスト">
        <p className="req-line">
          <span className="req-method">{draft.method}</span>
          <code className="req-path">{draft.path}</code>
        </p>
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
        {draft.body === 'raw' ? (
          <fieldset className="req-rows">
            <legend>ボディ</legend>
            <textarea className="req-raw-body" aria-label="ボディ" value={draft.rawBody ?? ''} onChange={(event) => update({ ...draft, rawBody: event.target.value })} />
          </fieldset>
        ) : null}
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
        {unrunnable !== undefined && generatedCase === undefined ? <p className="note">{unrunnable}</p> : null}
        {unrunnable === undefined && featuresOff ? <p className="note">地図の OP は全機能オンで動きます。オフの機能のステップを通るリクエストは、生成した OP とは道筋が変わります。</p> : null}
        {unrunnable === undefined && framework !== 'hono' ? <p className="note">{framework} の OP は hono の OP から生成したもので、このエンドポイントの処理は同じなので、hono の OP で動かします。</p> : null}
        <div className="req-actions">
          <button type="submit" className="flow-play req-run" disabled={problem !== undefined || unrunnable !== undefined || running}>
            {running ? '送っています…' : '▶ このリクエストを実行'}
          </button>
          {opens !== undefined ? (
            <a className="code-button" href={opens} target="_blank" rel="noopener" title="このリクエストを、このブラウザの新しいタブで地図の OP に送る">
              ブラウザで開く ↗
            </a>
          ) : null}
          {changed ? (
            <button type="button" className="link small" onClick={() => setEdited(undefined)}>
              元のリクエストに戻す
            </button>
          ) : null}
        </div>
        {opens !== undefined ? <p className="note">新しいタブが地図の OP へ送るリクエスト（ログイン、同意など）は、下の「最近のリクエスト」に出て、そこから道筋を再生できます。</p> : null}
      </form>
      {run !== undefined ? <RunResult run={run} replay={replay} ending={ending} assumed={assumed} expected={generatedCase?.scenario.expected} onFollow={onFollow} onOpen={onOpenExchangeId} /> : null}
      {endpoint !== undefined && served ? <RecentExchanges endpoints={endpoints} endpoint={endpoint.id} current={run?.status === 'done' ? run.exchange.id : undefined} onOpen={onOpenExchange} /> : null}
      {served ? <LiveStatePanel onOpen={onOpenExchangeId} /> : null}
    </section>
  );
}
