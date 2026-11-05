import { defineEndpoint } from '../_oidc-provider/endpoint';

/**
 * 認可リクエストを検証し、トランザクションとして保存してから、画面が要るかどうかで応答を分ける。
 * 画面が要らないとき（`prompt=none` でセッションと同意がそろっているとき、または有効なセッションのエンドユーザーが要求されたスコープにすでに同意しているとき）は、すぐに認可レスポンスでクライアントに応答する。
 * 画面が要るときは、トランザクションの Cookie を付けて、ログイン画面か同意画面へリダイレクトする。
 * エラーになったときは、`redirect_uri` を確かめた後ならエラーの認可レスポンスでクライアントに応答し、確かめる前なら OP のエラー画面へリダイレクトする（`Accept` ヘッダーで JSON を求める呼び出し元には 400 の JSON で応答する）。
 * `POST` の `Content-Type` の誤り、パラメータの重複、`client_id` の欠落には 400 の JSON で、署名鍵を読み込めなければ 503 で応答する。
 *
 * ここに並べたステップは、`route.ts` の中のブロックである。
 *
 * @spec OIDC Core 1.0 §3.1.2
 */
export const endpoint = defineEndpoint({
  path: '/authorize',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'parse-request', consumes: [], produces: ['params', 'responseMode', 'issuer'] },
    { id: 'resolve-pushed-request', feature: 'par', consumes: ['params'], produces: ['params'] },
    { id: 'resolve-client', consumes: ['params'], produces: ['client'] },
    { id: 'resolve-request-object', feature: 'request-object', consumes: ['params', 'client'], produces: ['effectiveParams', 'requestObjectClaims'] },
    { id: 'resolve-redirect-uri', consumes: ['effectiveParams', 'params', 'client'], produces: ['requestParams', 'redirectUri', 'state'] },
    { id: 'resolve-jarm-response-mode', feature: 'jarm', consumes: ['requestParams', 'client', 'redirectUri', 'state', 'issuer', 'keys'], produces: ['responseMode'] },
    { id: 'resolve-form-post-response-mode', feature: 'form-post-response-mode', consumes: ['requestParams', 'issuer'], produces: ['responseMode'] },
    { id: 'resolve-fragment-response-mode', feature: 'implicit-flow', consumes: ['requestParams', 'issuer'], produces: ['responseMode'] },
    { id: 'validate-request', consumes: ['params', 'requestParams', 'effectiveParams', 'requestObjectClaims', 'client', 'redirectUri', 'state'], produces: ['validatedRequest'] },
    { id: 'validate-implicit-request', feature: 'implicit-flow', consumes: ['validatedRequest', 'requestParams', 'client', 'responseMode'], produces: [] },
    { id: 'validate-hybrid-request', feature: 'hybrid-flow', consumes: ['validatedRequest', 'requestParams', 'responseMode'], produces: [] },
    { id: 'create-transaction', consumes: ['validatedRequest', 'responseMode'], produces: ['transactionId', 'transaction', 'transactionTtlSeconds'] },
    { id: 'validate-prompt-combination', consumes: ['transaction', 'transactionId', 'responseMode'], produces: ['promptValues'] },
    { id: 'verify-id-token-hint', consumes: ['transaction', 'transactionId', 'issuer', 'keys', 'responseMode'], produces: ['verifiedHintSubject'] },
    { id: 'authenticate-silently', consumes: ['promptValues', 'transaction', 'transactionId', 'verifiedHintSubject', 'responseMode'], produces: [] },
    { id: 'reuse-session', consumes: ['promptValues', 'transaction', 'transactionId', 'transactionTtlSeconds', 'verifiedHintSubject', 'responseMode'], produces: [] },
    { id: 'continue-to-login', consumes: ['transactionId', 'transactionTtlSeconds'], produces: [] },
    { id: 'respond-error', consumes: ['responseMode'], produces: [] },
    // issueAuthorizationResponse(), which authenticate-silently and reuse-session call.
    { id: 'issue-implicit-response', feature: 'implicit-flow', consumes: ['transactionId', 'transaction', 'session', 'responseMode'], produces: [] },
    { id: 'issue-hybrid-response', feature: 'hybrid-flow', consumes: ['transactionId', 'transaction', 'session', 'responseMode'], produces: [] },
    { id: 'issue-authorization-code', consumes: ['transactionId', 'transaction', 'session', 'responseMode'], produces: [] },
  ],
});
