import { useId, useState, type FormEvent } from 'react';
import { PREMISES } from '@maronn-openid-connect/map-sandbox/premises';
import { basicCredentials, statusLine, statusTone, wayRequestsOf, PARAM_PLACES } from '../lib/requests';
import { blankDraft, bodiless, draftOf, draftProblem, oauthErrorOf, type ParamPlace, type RequestDraft } from '../lib/run';
import type { RootRequests, Selection, WaySample } from '../types';
import type { RootRequestsState } from './useRequests';
import type { RequestRunState } from './useRun';

/** The words of the body of a request, by its kind. */
const BODY_WORDS: Record<RequestDraft['body'], string> = { form: 'ボディ（フォーム）', json: 'ボディ（JSON）', none: 'ボディ' };

/** The rows of one place of a request (its query, its body, or its headers), each a name and a value to write, with a row to add. */
function Rows({ label, rows, onChange, onAdd, onRemove, note }: { label: string; rows: ReadonlyArray<{ name: string; value: string }>; onChange: (index: number, name: string, value: string) => void; onAdd: () => void; onRemove: (index: number) => void; note?: (row: { name: string; value: string }) => string | undefined }) {
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

/** Where the request of a way starts from: the request the OP of the map took the way with, or for a way no request took, the request the OP answered the endpoint with. */
type Origin = { kind: 'sample'; request: WaySample } | { kind: 'base'; request: WaySample; way: string };

/** The request the OP of the map answered the endpoint with, to start a way no request is known for: the sample of an end it answered without an error, else the first sample. */
function baseSample(requests: RootRequests | undefined): { request: WaySample; way: string } | undefined {
  const ways = requests?.ways ?? [];
  const found = ways.find((way) => way.kind === 'exit' && way.sample !== undefined && way.sample.status < 400) ?? ways.find((way) => way.sample !== undefined);
  return found?.sample === undefined ? undefined : { request: found.sample, way: found.name.replace(/`/g, '') };
}

/** What the OP of the map holds when a request starts: what a request can use. */
function Premises() {
  return (
    <details className="req-premises">
      <summary>地図の OP が持っているもの（リクエストで使える値）</summary>
      <p className="note">
        発行者 <code className="mono">{PREMISES.issuer}</code>、時計は <code className="mono">{new Date(PREMISES.now * 1000).toISOString()}</code> で止まっています。どのリクエストも、この状態の新しい OP で動きます。
      </p>
      <dl>
        {PREMISES.clients.map((client) => (
          <div key={client.clientId}>
            <dt>
              クライアント <code className="mono">{client.clientId}</code>
            </dt>
            <dd>
              {client.authMethod}
              {client.clientSecret !== undefined ? (
                <>
                  、シークレット <code className="mono">{client.clientSecret}</code>
                </>
              ) : null}
              、グラント {client.grantTypes.join(' / ')}、redirect_uri <code className="mono">{client.redirectUris.join(' ')}</code>
            </dd>
          </div>
        ))}
        {PREMISES.codes.map((code) => (
          <div key={code.code}>
            <dt>
              認可コード <code className="mono">{code.code}</code>
            </dt>
            <dd>
              {code.clientId} に {code.redirectUri} で、scope {code.scope.join(' ')}
              {code.pkce !== undefined ? (
                <>
                  、PKCE（{code.pkce.method}）の code_verifier <code className="mono">{code.pkce.verifier}</code>
                </>
              ) : null}
              、{code.expiresIn} 秒で失効
            </dd>
          </div>
        ))}
        {PREMISES.refreshTokens.map((token) => (
          <div key={token.token}>
            <dt>
              リフレッシュトークン <code className="mono">{token.token}</code>
            </dt>
            <dd>
              {token.clientId} に、scope {token.scope.join(' ')}
            </dd>
          </div>
        ))}
        <div>
          <dt>ユーザー</dt>
          <dd>
            {PREMISES.users.map((user) => (
              <span key={user.username}>
                <code className="mono">{user.username}</code> / <code className="mono">{user.password}</code>{' '}
              </span>
            ))}
          </dd>
        </div>
      </dl>
    </details>
  );
}

/** What a request run gave: the response, the way it ended by, and whether the playback follows the way it took. */
function RunResult({ run, ending, assumed, onFollow }: { run: RequestRunState; ending: string | undefined; assumed: number; onFollow: () => void }) {
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
  /** The ready-made way chosen; undefined for おまかせ, a way the reader chose side by side, or the way of a request run. */
  selection: Selection | undefined;
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
 * seen to take it with; for a way no request took, as the request the OP
 * answered the endpoint with, else with no parameters. The reader writes its
 * query, its body and its headers and runs it on the OP of the map: the
 * response comes back, and the playback follows the way the request took
 * there (useRun.ts). The values the OP holds (its clients, codes and tokens)
 * are listed to write with. The tests play no part here: what a test sent is
 * the tests page's to show.
 */
export function FlowRequest({ state, selection, assumed, framework, endpoint, unrunnable, featuresOff, run, ending, onRun, onFollow }: FlowRequestProps) {
  const headingId = useId();
  // The way the request was taken from: a ready-made way picked later takes its place, while the way of a run (no ready-made way) keeps it.
  const [base, setBase] = useState<{ selection: Selection | undefined }>({ selection });
  if (selection !== undefined && selection !== base.selection) setBase({ selection });
  const requests = state.kind === 'ready' ? state.requests : undefined;
  const way = wayRequestsOf(requests, base.selection);
  // The request the OP of the map took the way with; for a way no request took, the one it answered the endpoint with.
  const fallback = base.selection === undefined || way !== undefined ? undefined : baseSample(requests);
  const shown: Origin | undefined = way !== undefined ? { kind: 'sample', request: way.sample } : fallback === undefined ? undefined : { kind: 'base', ...fallback };
  const originKey = `${base.selection?.kind ?? ''}|${base.selection?.target ?? ''}|${way?.id ?? ''}`;
  const origin = shown !== undefined ? draftOf(shown.request) : endpoint !== undefined ? blankDraft(endpoint.method, endpoint.path) : undefined;
  const [edited, setEdited] = useState<{ key: string; draft: RequestDraft } | undefined>(undefined);
  const draft = edited?.key === originKey ? edited.draft : origin;
  const changed = edited?.key === originKey;
  const update = (next: RequestDraft) => setEdited({ key: originKey, draft: next });

  let note: string;
  if (base.selection === undefined) note = '「道筋」からケースを選ぶと、そのケースを通るリクエストから始めます。値を書いて実行すると、地図の OP で動かし、通った道筋を再生します。';
  else if (state.kind === 'loading') note = '読み込んでいます…';
  else if (state.kind === 'failed') note = `このケースを通るリクエストを読み込めませんでした: ${state.message}`;
  else if (shown?.kind === 'sample') note = '地図の OP で、このケースを通ると確かめたリクエストです。値を書き換えて実行すると、通る道筋がどう変わるかを再生します。';
  else if (shown?.kind === 'base') note = `このケースを通るリクエストは見つかっていないので、地図の OP が「${shown.way}」で応えたリクエストから始めます。値を書き換えて、このケースを通るか確かめられます。`;
  else note = 'このケースを通るリクエストは見つかっていません。値を書いて実行すると、通った道筋を再生します。';

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
      <form className="req" onSubmit={submit} aria-label="実行するリクエスト">
        <p className="req-line">
          <span className="req-method">{draft.method}</span>
          <code className="req-path">{draft.path}</code>
          {shown !== undefined && !changed ? (
            <span className={`req-status req-${statusTone(shown.request.status)}`}>
              → {statusLine(shown.request)}（地図の OP）
            </span>
          ) : null}
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
      {run !== undefined ? <RunResult run={run} ending={ending} assumed={assumed} onFollow={onFollow} /> : null}
      <Premises />
    </section>
  );
}
