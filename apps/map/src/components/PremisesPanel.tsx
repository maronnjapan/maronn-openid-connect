import { useState } from 'react';
import type { PremiseClient, Premises, PreparedPremises } from '@maronn-openid-connect/map-sandbox';
import { PREMISES } from '@maronn-openid-connect/map-sandbox/premises';
import { Rows } from './Rows';
import { StepItem } from './StoredRecords';
import { setMadePremises, type CurrentPremises } from './useRequests';
import { prepareInSandbox } from '@maronn-openid-connect/map-sandbox/browser';

/** A grant of the premises as the reader edits it: the parameters of its authorization request as rows (a name may be empty while it is written), and whether its code is exchanged. */
interface GrantDraft {
  id: string;
  rows: Array<{ name: string; value: string }>;
  exchange: boolean;
}

/** A client of the premises as the reader edits it: the grant types it is registered for (written with spaces between) and how it authenticates at the token endpoint. */
interface ClientDraft {
  clientId: string;
  grantTypes: string;
  authMethod: PremiseClient['authMethod'];
}

/** What the reader edits of a plan: its clients and its grants. */
interface PlanDraft {
  clients: ClientDraft[];
  grants: GrantDraft[];
}

/** The clients and the grants of a plan as drafts to edit. */
function draftsOf(plan: Premises): PlanDraft {
  return {
    clients: plan.clients.map((client) => ({ clientId: client.clientId, grantTypes: client.grantTypes.join(' '), authMethod: client.authMethod })),
    grants: plan.grants.map((grant) => ({ id: grant.id, rows: Object.entries(grant.authorize).map(([name, value]) => ({ name, value })), exchange: grant.exchange })),
  };
}

/** A plan with the clients and the grants as drafted: the grant types written, the rows with a name as the authorization request, the rest as it was. */
function planOf(plan: Premises, drafts: PlanDraft): Premises {
  return {
    ...plan,
    clients: plan.clients.map((client) => {
      const draft = drafts.clients.find((candidate) => candidate.clientId === client.clientId);
      return draft === undefined ? client : { ...client, grantTypes: draft.grantTypes.split(/\s+/).filter((grant) => grant !== ''), authMethod: draft.authMethod };
    }),
    grants: plan.grants.map((grant) => {
      const draft = drafts.grants.find((candidate) => candidate.id === grant.id);
      return draft === undefined ? grant : { ...grant, authorize: Object.fromEntries(draft.rows.filter((row) => row.name.trim() !== '').map((row) => [row.name.trim(), row.value])), exchange: draft.exchange };
    }),
  };
}

/** The ways a client may authenticate at the token endpoint that the premises know (PremiseClient.authMethod). */
const AUTH_METHODS: ReadonlyArray<PremiseClient['authMethod']> = ['client_secret_basic', 'client_secret_post', 'none'];

/** The values a grant left for a request to use, or why the OP gave it none; for a code the OP gave but did not exchange, the code and why. */
function GrantValues({ premises, id }: { premises: PreparedPremises; id: string }) {
  const grant = premises.grants.find((candidate) => candidate.id === id);
  const failure = premises.failures?.find((candidate) => candidate.grant === id);
  if (grant === undefined) return <p className="note req-problem">OP はこのグラントのコードを出しませんでした{failure === undefined ? '' : `: ${failure.message}`}</p>;
  return (
    <dl>
      {failure?.stage === 'exchange' ? <p className="note req-problem">OP はコードを出しましたが、トークンエンドポイントは引き換えを断りました（トークンはありません）: {failure.message}</p> : null}
      <div>
        <dt>リクエストで使える値</dt>
        <dd>
          code <code className="mono">{grant.code}</code>、code_verifier <code className="mono">{grant.codeVerifier}</code>
          {typeof grant.tokens?.refresh_token === 'string' ? (
            <>
              、refresh_token <code className="mono">{grant.tokens.refresh_token}</code>
            </>
          ) : grant.tokens !== undefined ? (
            '、リフレッシュトークンは発行されていません'
          ) : null}
          {typeof grant.tokens?.access_token === 'string' ? (
            <details className="store-token">
              <summary>access_token（JWT）</summary>
              <code className="mono">{grant.tokens.access_token}</code>
            </details>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

/**
 * What the OP of the map holds before any request: the clients and the
 * users of its configuration (with the secrets and the passwords a request
 * is written with), and grant by grant, the requests that made the rest,
 * each with the records it wrote, and the values they left to use. The
 * authorization request of each grant (its scope, its prompt, PKCE…) and
 * whether its code is exchanged can be changed, and the premises made again
 * from them by the OP of the map in the page: every request run then runs
 * on those, in every flow view of the page, until the reader goes back to
 * those of the build.
 */
export function PremisesPanel({ premises }: { premises: CurrentPremises }) {
  const ready = premises.state.kind === 'ready' ? premises.state.premises : undefined;
  const plan = premises.made?.plan ?? PREMISES;
  const [drafts, setDrafts] = useState<{ version: number; draft: PlanDraft }>(() => ({ version: premises.version, draft: draftsOf(plan) }));
  // The drafts follow the premises in use when they change (made, or gone back to the build's): what was written before is of the premises before.
  const planDraft = drafts.version === premises.version ? drafts.draft : draftsOf(plan);
  const { clients, grants } = planDraft;
  const [making, setMaking] = useState<{ status: 'idle' } | { status: 'making' } | { status: 'failed'; message: string }>({ status: 'idle' });
  const next = planOf(plan, planDraft);
  const changed = JSON.stringify(next) !== JSON.stringify(plan);
  const edit = (id: string, change: (grant: GrantDraft) => GrantDraft) => setDrafts({ version: premises.version, draft: { clients, grants: grants.map((grant) => (grant.id === id ? change(grant) : grant)) } });
  const editClient = (clientId: string, change: (client: ClientDraft) => ClientDraft) => setDrafts({ version: premises.version, draft: { clients: clients.map((client) => (client.clientId === clientId ? change(client) : client)), grants } });
  const make = () => {
    setMaking({ status: 'making' });
    prepareInSandbox(next).then(
      (made) => {
        setMadePremises({ plan: next, premises: made });
        setMaking({ status: 'idle' });
      },
      (error: unknown) => setMaking({ status: 'failed', message: error instanceof Error ? error.message : String(error) }),
    );
  };
  return (
    <details className="req-premises">
      <summary>地図の OP が持っているもの（リクエストで使える値と、それを作ったリクエスト。認可リクエストを書き換えて作り直せる）</summary>
      <p className="note">
        発行者 <code className="mono">{plan.issuer}</code>、時計は <code className="mono">{new Date(plan.now * 1000).toISOString()}</code> で止まっています。どのリクエストも、この状態の新しい OP で動きます。
        {premises.made !== undefined ? ' いまの前提は、このページで書き換えたグラントから作り直したものです。' : ' いまの前提は、地図のビルドが作ったものです。'}
      </p>
      <fieldset className="store-edit" disabled={making.status === 'making'}>
      <h6 className="store-subtitle">OP の設定で登録したもの（クライアントの認証方式と grant_types は書き換えられる）</h6>
      <dl>
        {plan.clients.map((client) => {
          const edited = clients.find((candidate) => candidate.clientId === client.clientId);
          return (
            <div key={client.clientId}>
              <dt>
                クライアント <code className="mono">{client.clientId}</code>
              </dt>
              <dd>
                {client.clientSecret !== undefined ? (
                  <>
                    シークレット <code className="mono">{client.clientSecret}</code>
                  </>
                ) : null}
                {client.redirectUris.length > 0 ? (
                  <>
                    、redirect_uri <code className="mono">{client.redirectUris.join(' ')}</code>
                  </>
                ) : null}
                <span className="store-client">
                  <label>
                    認証
                    <select aria-label={`クライアント ${client.clientId} の認証方式`} value={edited?.authMethod ?? client.authMethod} onChange={(event) => editClient(client.clientId, (draft) => ({ ...draft, authMethod: event.target.value as PremiseClient['authMethod'] }))}>
                      {AUTH_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {method}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    grant_types
                    <input className="mono" aria-label={`クライアント ${client.clientId} の grant_types`} value={edited?.grantTypes ?? client.grantTypes.join(' ')} spellCheck={false} autoComplete="off" onChange={(event) => editClient(client.clientId, (draft) => ({ ...draft, grantTypes: event.target.value }))} />
                  </label>
                </span>
              </dd>
            </div>
          );
        })}
        <div>
          <dt>ユーザー</dt>
          <dd>
            {plan.users.map((user) => (
              <span key={user.username}>
                <code className="mono">{user.username}</code> / <code className="mono">{user.password}</code>{' '}
              </span>
            ))}
          </dd>
        </div>
      </dl>
      {ready === undefined ? (
        <p className="note">{premises.state.kind === 'failed' ? `リクエストで作った前提を読み込めませんでした: ${premises.state.message}` : premises.state.kind === 'loading' ? 'リクエストで作った前提を読み込んでいます…' : 'このビルドは、リクエストで前提を作っていません。'}</p>
      ) : null}
      {grants.map((draft) => (
        <div key={draft.id} className="store-grant">
          <h6 className="store-subtitle">
            グラント <code className="mono">{draft.id}</code>
          </h6>
          <Rows
            label={`グラント ${draft.id} の認可リクエストのクエリ（GET /authorize）`}
            rows={draft.rows}
            onChange={(index, name, value) => edit(draft.id, (grant) => ({ ...grant, rows: grant.rows.map((row, at) => (at === index ? { name, value } : row)) }))}
            onAdd={() => edit(draft.id, (grant) => ({ ...grant, rows: [...grant.rows, { name: '', value: '' }] }))}
            onRemove={(index) => edit(draft.id, (grant) => ({ ...grant, rows: grant.rows.filter((_, at) => at !== index) }))}
          />
          <label className="store-check">
            <input type="checkbox" aria-label={`グラント ${draft.id} のコードをトークンエンドポイントで引き換える`} checked={draft.exchange} onChange={(event) => edit(draft.id, (grant) => ({ ...grant, exchange: event.target.checked }))} /> 受け取ったコードをトークンエンドポイントで引き換える（使用済みのコードと、発行したトークンが残る）
          </label>
          {ready !== undefined ? (
            <>
              <p className="note">このグラントを作ったリクエスト{ready.steps.some((step) => step.grant === draft.id) ? '' : '（ありません）'}</p>
              <ol className="store-steps">
                {ready.steps.map((step, index) => (step.grant === draft.id ? <StepItem key={index} index={index} step={step} /> : null))}
              </ol>
              <GrantValues premises={ready} id={draft.id} />
            </>
          ) : null}
        </div>
      ))}
      </fieldset>
      <div className="req-actions store-actions">
        <button type="button" className="flow-play" disabled={!changed || making.status === 'making'} onClick={make}>
          {making.status === 'making' ? '前提を作り直しています…' : '書き換えたグラントで前提を作り直す'}
        </button>
        {premises.made !== undefined ? (
          <button type="button" className="link small" disabled={making.status === 'making'} onClick={() => setMadePremises(undefined)}>
            地図のビルドの前提に戻す
          </button>
        ) : null}
        {changed && making.status !== 'making' ? (
          <button type="button" className="link small" onClick={() => setDrafts({ version: premises.version, draft: draftsOf(plan) })}>
            書き換えを取り消す
          </button>
        ) : null}
      </div>
      <div aria-live="polite">
        {making.status === 'making' ? <p className="note">地図の OP で、グラントごとに認可リクエスト、ログイン、同意（と引き換え）を動かしています（最初は OP を読み込みます）。</p> : null}
        {making.status === 'failed' ? <p className="note req-problem">前提を作り直せませんでした: {making.message}</p> : null}
        {premises.made !== undefined && ready !== undefined && (ready.failures?.length ?? 0) > 0 ? <p className="note req-problem">OP がコードを出さなかったか、引き換えを断ったグラントがあります（各グラントの下に理由）。そのグラントに無い値を使うリクエストは、OP に無い値を送ります。</p> : null}
      </div>
    </details>
  );
}
