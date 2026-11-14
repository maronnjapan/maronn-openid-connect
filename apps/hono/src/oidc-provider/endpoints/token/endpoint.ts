import { defineEndpoint } from '../step.js';

/**
 * クライアントを認証し、提示されたグラント（認可コード、リフレッシュトークン、有効にした機能が扱うグラント）を検証して、トークンレスポンスで応答する。
 * レスポンスには、アクセストークンと、`openid` スコープが許可されたときの ID トークンと、発行したときのリフレッシュトークンを含める。
 * 失敗したときは OAuth のエラーレスポンスで応答し、トークンレスポンスにもエラーレスポンスにも `Cache-Control: no-store` を付ける。
 *
 * @spec OIDC Core 1.0 §3.1.3
 */
export const endpoint = defineEndpoint({
  id: 'token',
  order: 70,
  label: 'トークンエンドポイント',
  path: '/token',
  methods: ['POST'],
  layer: 'api',
  group: { id: 'authorization-code', label: '認可コードフロー' },
  spec: 'OIDC Core 1.0 §3.1.3',
  rearrangeable: true,
  steps: [
    'parse-request',
    'authenticate-client',
    'dispatch-client-credentials',
    'dispatch-id-jag-issuance',
    'dispatch-id-jag-redemption',
    'dispatch-token-exchange',
    'dispatch-device-code',
    'dispatch-ciba',
    'validate-grant-type',
    'validate-refresh-token-grant',
    'validate-authorization-code-grant',
    'select-signing-keys',
    'resolve-subject',
    'decide-refresh-token-issuance',
    'resolve-acr-amr',
    'issue-access-token',
    'issue-id-token',
    'persist-access-token',
    'issue-refresh-token',
    'revoke-rotated-refresh-token',
    'build-token-response',
    'respond',
    'respond-error',
  ],
  errorStep: 'respond-error',
  // The grant is validated by the step of its grant_type: the chain goes from
  // validate-grant-type through the step of each grant it forks to. A grant a
  // feature answers itself (a dispatch step of that feature) goes straight to
  // respond.
  edges: {
    chain: true,
    forks: [
      { at: 'validate-grant-type', branches: [
        { step: 'validate-authorization-code-grant', label: 'authorization_code' },
        { step: 'validate-refresh-token-grant', label: 'refresh_token' },
      ] },
    ],
    fromKind: [
      { kind: 'dispatch', to: 'respond', label: '応答済み' },
    ],
  },
  journeys: [
    { from: 'token', to: 'userinfo', label: 'access_token', kind: 'flow', order: 100 },
  ],
});
