import { useState, type FormEvent } from 'react';
import type { GrantResult, LiveState } from '@maronn-openid-connect/live-op/api';
import { codeChallengeOf, newCodeVerifier, offsetWords, randomToken, recordsByCollection } from '../lib/live';
import { collectionWord } from '../lib/records';
import { statusLine, statusTone } from '../lib/requests';
import { Rows } from './Rows';
import { ExchangeLink, RecordItem } from './StoredRecords';
import { liveClient, liveProblem, notifyLiveChanged, refreshLiveState, takeLiveState, useLiveState } from './useLive';

/** How far the clock buttons move the OP's clock on, in seconds, and their words. */
const CLOCK_STEPS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 60, label: '+60 秒' },
  { seconds: 600, label: '+10 分' },
  { seconds: 3600, label: '+1 時間' },
];

/** The authorization request a grant starts from: client-1's code flow with offline access and its consent asked for (OAuth 2.0 §4.1.1, OIDC Core 1.0 §3.1.2.1, §11). */
function defaultAuthorize(): Array<{ name: string; value: string }> {
  return [
    { name: 'response_type', value: 'code' },
    { name: 'client_id', value: 'client-1' },
    { name: 'redirect_uri', value: 'https://rp.example.com/callback' },
    { name: 'scope', value: 'openid profile offline_access' },
    { name: 'prompt', value: 'consent' },
    { name: 'state', value: randomToken() },
    { name: 'nonce', value: randomToken() },
  ];
}

/** The OP's clock at a time (Unix milliseconds) in the reader's locale. */
function clockOf(at: number): string {
  return new Date(at).toLocaleString('ja-JP', { hour12: false });
}

/** What a grant left: the code, the verifier, the tokens of its exchange, the requests it sent (each to open), or why the OP gave no code. */
function GrantOutcome({ result, onOpen }: { result: GrantResult; onOpen: (id: string) => void }) {
  return (
    <div className="req-result" aria-live="polite">
      {result.failure !== undefined ? <p className="req-line req-problem">{result.failure}</p> : null}
      <dl className="grant-values">
        <div>
          <dt>クライアント</dt>
          <dd>
            <code className="mono">{result.clientId}</code> → <code className="mono">{result.redirectUri}</code>
          </dd>
        </div>
        {result.code !== undefined ? (
          <div>
            <dt>code</dt>
            <dd>
              <code className="mono">{result.code}</code>
            </dd>
          </div>
        ) : null}
        {result.codeVerifier !== undefined ? (
          <div>
            <dt>code_verifier</dt>
            <dd>
              <code className="mono">{result.codeVerifier}</code>
            </dd>
          </div>
        ) : null}
        {Object.entries(result.tokens ?? {}).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              <code className="mono">{typeof value === 'string' ? value : JSON.stringify(value)}</code>
            </dd>
          </div>
        ))}
      </dl>
      <p className="note">このグラントが送ったリクエスト（{result.steps.length} 件）</p>
      <ol className="store-steps">
        {result.steps.map((step) => (
          <li key={step.id} className="store-step">
            <p className="req-line">
              <ExchangeLink id={step.id} onOpen={onOpen} />
              <span className="req-method">{step.method}</span>
              <code className="req-path">{step.path.split('?')[0]}</code>
              {step.status !== undefined ? <span className={`req-status req-${statusTone(step.status)}`}>→ {statusLine({ status: step.status })}</span> : null}
              {step.error !== undefined ? <code className="mono req-error-code">{step.error}</code> : null}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * A grant the page asks the OP for, as a browser and a client would: the
 * query of the authorization request, PKCE (S256, the verifier made in the
 * page with WebCrypto), the user who signs in on the OP's login page and
 * consents, and whether the client exchanges the code at the token
 * endpoint. What it leaves (the code, the tokens) is the workspace's.
 */
function GrantForm({ state, onOpen }: { state: LiveState; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState(defaultAuthorize);
  const [pkce, setPkce] = useState(true);
  const [username, setUsername] = useState(state.users[0]?.username ?? 'testuser');
  const [exchange, setExchange] = useState(true);
  const [status, setStatus] = useState<{ kind: 'idle' } | { kind: 'running' } | { kind: 'done'; result: GrantResult } | { kind: 'failed'; message: string }>({ kind: 'idle' });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setStatus({ kind: 'running' });
    void (async () => {
      const authorize = Object.fromEntries(rows.filter((row) => row.name.trim() !== '').map((row) => [row.name.trim(), row.value]));
      let codeVerifier: string | undefined;
      if (pkce) {
        codeVerifier = newCodeVerifier();
        authorize['code_challenge'] = await codeChallengeOf(codeVerifier);
        authorize['code_challenge_method'] = 'S256';
      }
      return liveClient().grant({ authorize, username, exchange, ...(codeVerifier === undefined ? {} : { codeVerifier }) });
    })().then(
      (result) => {
        setStatus({ kind: 'done', result });
        notifyLiveChanged();
      },
      (error: unknown) => setStatus({ kind: 'failed', message: liveProblem(error) }),
    );
  };
  return (
    <form className="store-grant" onSubmit={submit} aria-label="グラントを作る">
      <h6 className="store-subtitle">グラントを作る（認可リクエスト、ログイン、同意、引き換えをブラウザとクライアントのように送る）</h6>
      <fieldset className="store-edit" disabled={status.kind === 'running'}>
        <Rows
          label="認可リクエストのクエリ（GET /authorize）"
          rows={rows}
          onChange={(index, name, value) => setRows(rows.map((row, at) => (at === index ? { name, value } : row)))}
          onAdd={() => setRows([...rows, { name: '', value: '' }])}
          onRemove={(index) => setRows(rows.filter((_, at) => at !== index))}
        />
        <label className="store-check">
          <input type="checkbox" checked={pkce} onChange={(event) => setPkce(event.target.checked)} /> PKCE（S256）を付ける（code_verifier はこのページで作る）
        </label>
        <span className="store-client">
          <label>
            ログインするユーザー
            <select value={username} onChange={(event) => setUsername(event.target.value)}>
              {state.users.map((user) => (
                <option key={user.username} value={user.username}>
                  {user.username}
                </option>
              ))}
            </select>
          </label>
        </span>
        <label className="store-check">
          <input type="checkbox" checked={exchange} onChange={(event) => setExchange(event.target.checked)} /> 受け取ったコードをトークンエンドポイントで引き換える（使用済みのコードと、発行したトークンが残る）
        </label>
        <div className="req-actions store-actions">
          <button type="submit" className="flow-play">
            {status.kind === 'running' ? 'グラントを作っています…' : 'このグラントを作る'}
          </button>
          <button type="button" className="link small" onClick={() => setRows(defaultAuthorize())}>
            既定に戻す
          </button>
        </div>
      </fieldset>
      {status.kind === 'failed' ? <p className="note req-problem">グラントを作れませんでした: {status.message}</p> : null}
      {status.kind === 'done' ? <GrantOutcome result={status.result} onOpen={onOpen} /> : null}
    </form>
  );
}

/**
 * 「地図の OP の状態」: what the reader's workspace of the live OP is and
 * holds. Its clock (moved on by the buttons, to see what expires) and the
 * workspace made again from nothing; the clients and the users it is
 * configured with (their secrets and passwords, a playground's); every
 * record it holds by collection, each with the exchanges that stored and
 * changed it (to open); and a form that makes a grant.
 */
export function LiveStatePanel({ onOpen }: { onOpen: (id: string) => void }) {
  const live = useLiveState();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** Do something to the workspace, then show the state the OP gave for it. */
  const change = (label: string, act: () => Promise<LiveState>) => {
    setBusy(label);
    setProblem(undefined);
    act().then(
      (next) => {
        notifyLiveChanged();
        takeLiveState(next);
        setBusy(undefined);
      },
      (error: unknown) => {
        setProblem(liveProblem(error));
        setBusy(undefined);
      },
    );
  };
  const state = live.kind === 'ready' ? live.state : undefined;
  return (
    <details
      className="live-state"
      onToggle={(event) => {
        if (event.currentTarget.open) void refreshLiveState(true);
      }}
    >
      <summary>地図の OP の状態（時計、クライアントとユーザー、保存した記録。グラントを作れる）</summary>
      {live.kind === 'loading' ? <p className="note">読み込んでいます…</p> : null}
      {live.kind === 'failed' ? <p className="note req-problem">{live.message}</p> : null}
      {state !== undefined ? (
        <>
          {state.notice !== undefined ? <p className="note req-problem">{state.notice}</p> : null}
          <p className="note">
            ワークスペース <code className="mono">{state.workspace}</code>、発行者 <code className="mono">{state.issuer}</code>。リクエストの間で状態を保ち、このブラウザの別のタブで開いた OP の画面も同じワークスペースに届きます。
          </p>
          <div className="live-clock">
            <span>
              OP の時計 <code className="mono">{clockOf(state.now)}</code>（{offsetWords(state.clockOffset)}）
            </span>
            <span className="seg" role="group" aria-label="OP の時計を進める">
              {CLOCK_STEPS.map((step) => (
                <button key={step.seconds} type="button" disabled={busy !== undefined} onClick={() => change('clock', () => liveClient().advanceClock(step.seconds))}>
                  {step.label}
                </button>
              ))}
            </span>
            <button
              type="button"
              className="link small"
              disabled={busy !== undefined}
              onClick={() => {
                if (window.confirm('ワークスペースを作り直すと、保存した記録、最近のリクエスト、進めた時計が消えます。作り直しますか？')) change('reset', () => liveClient().reset());
              }}
            >
              {busy === 'reset' ? '作り直しています…' : 'ワークスペースを作り直す'}
            </button>
            <button type="button" className="link small" disabled={busy !== undefined} onClick={() => void refreshLiveState(true)}>
              読み直す
            </button>
          </div>
          {problem !== undefined ? <p className="note req-problem">{problem}</p> : null}
          <h6 className="store-subtitle">OP の設定で登録したクライアント</h6>
          <dl>
            {state.clients.map((client) => (
              <div key={client.clientId}>
                <dt>
                  <code className="mono">{client.clientId}</code> <span className="req-note live-inline">{client.note}</span>
                </dt>
                <dd>
                  認証 <code className="mono">{client.authMethod}</code>
                  {client.clientSecret !== undefined ? (
                    <>
                      、シークレット <code className="mono">{client.clientSecret}</code>
                    </>
                  ) : null}
                  、grant_types <code className="mono">{client.grantTypes.join(' ')}</code>
                  {client.redirectUris.length > 0 ? (
                    <>
                      、redirect_uri <code className="mono">{client.redirectUris.join(' ')}</code>
                    </>
                  ) : null}
                </dd>
              </div>
            ))}
            <div>
              <dt>ユーザー（名前 / パスワード）</dt>
              <dd>
                {state.users.map((user) => (
                  <span key={user.username}>
                    <code className="mono">{user.username}</code> / <code className="mono">{user.password}</code>{' '}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
          <h6 className="store-subtitle">保存した記録（{state.records.length} 件。保存・変更したリクエストを開ける）</h6>
          {state.records.length === 0 ? <p className="note">ありません。</p> : null}
          <ul className="store-list">
            {recordsByCollection(state.records).map((group) => (
              <li key={group.collection} className="store-item">
                <details>
                  <summary>
                    <span className="store-what">{collectionWord(group.collection)}</span> <span className="req-note">{group.records.length} 件</span>
                  </summary>
                  <ul className="store-list store-walk">
                    {group.records.map((record) => (
                      <li key={record.key} className="store-item">
                        <RecordItem record={record} now={Math.floor(state.now / 1000)} onOpen={onOpen} />
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
          <GrantForm state={state} onOpen={onOpen} />
        </>
      ) : null}
    </details>
  );
}
