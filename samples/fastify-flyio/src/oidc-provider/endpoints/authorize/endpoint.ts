import { defineEndpoint } from '../step.js';

/**
 * 認可リクエストを検証し、トランザクションとして保存してから、画面が要るかどうかで応答を分ける。
 * 画面が要らないとき（`prompt=none` でセッションと同意がそろっているとき、または有効なセッションのエンドユーザーが要求されたスコープにすでに同意しているとき）は、すぐに認可レスポンスでクライアントに応答する。
 * 画面が要るときは、トランザクションの Cookie を付けて、ログイン画面か同意画面へリダイレクトする。
 * エラーになったときは、`redirect_uri` を確かめた後ならエラーの認可レスポンスでクライアントに応答し、確かめる前なら OP のエラー画面（`Accept` ヘッダーで JSON を求める呼び出し元には 400 の JSON）で応答する。
 * `POST` の `Content-Type` の誤り、パラメータの重複、`client_id` の欠落には、400 の JSON で応答する。
 *
 * @spec OIDC Core 1.0 §3.1.2
 */
export const endpoint = defineEndpoint({
  id: 'authorize',
  order: 30,
  label: '認可エンドポイント',
  path: '/authorize',
  methods: ['GET', 'POST'],
  layer: 'browser',
  group: { id: 'authorization-code', label: '認可コードフロー' },
  spec: 'OIDC Core 1.0 §3.1.2',
  rearrangeable: true,
  // Defined before the first step: the issuer of the provider. The response
  // mode is declared there too (undefined unless a step of a feature, such as
  // JARM's, form_post's or the Implicit Flow's fragment, which the Hybrid
  // Flow shares, sets it), so the error step can read it whichever step
  // failed.
  initial: ['issuer'],
  steps: [
    'parse-request',
    'resolve-client',
    'fetch-request-uri',
    'resolve-request-object',
    'resolve-redirect-uri',
    'resolve-form-post-response-mode',
    'resolve-fragment-response-mode',
    'validate-request',
    'validate-implicit-request',
    'validate-hybrid-request',
    'create-transaction',
    'validate-prompt-combination',
    'verify-id-token-hint',
    'authenticate-silently',
    'reuse-session',
    'issue-authorization-code',
    'continue-to-login',
    'respond-error',
  ],
  errorStep: 'respond-error',
  edges: {
    chain: true,
    off: ['issue-authorization-code'],
    extra: [
      { from: 'authenticate-silently', to: 'issue-authorization-code', label: 'セッションと同意あり', kind: 'branch' },
      { from: 'reuse-session', to: 'issue-authorization-code', label: 'セッションと過去の同意あり', kind: 'branch' },
      { from: 'reuse-session', to: 'continue-to-login', label: '同意画面へ', kind: 'branch' },
    ],
  },
  journeys: [
    { from: 'authorize', to: 'login', label: 'ログインが必要', kind: 'flow', order: 30 },
    { from: 'authorize', to: 'consent', label: 'SSO: 同意が必要', kind: 'flow', order: 40 },
    { from: 'authorize', to: 'token', label: 'code（prompt=none / SSO）', kind: 'flow', order: 50 },
  ],
});
