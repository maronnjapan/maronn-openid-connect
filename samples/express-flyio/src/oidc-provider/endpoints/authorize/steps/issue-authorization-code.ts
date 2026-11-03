import {
  type AuthTransaction,
  type SessionInfo,
  completeAuthTransaction,
  createAuthorizationCode,
} from '@maronn-openid-connect/core';
import { type AuthorizationOutcome, buildSuccessResponse } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { responseTypeHandlerOf } from '../response-type.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'issue-authorization-code',
  endpoint: 'authorize',
  kind: 'issue',
  label: '認可コードを発行し、認可レスポンスを組み立てる',
  spec: 'OIDC Core 1.0 §3.1.2.5 / RFC 9207 §2',
  function: 'issueAuthorizationCodeResponse',
  calls: ['consentResolver.recordGrant'],
  consumes: ['transactionId', 'transaction', 'session', 'issuer', 'responseMode'],
  optional: ['responseMode'],
  produces: [],
  removable: false,
  calledFrom: ['authenticate-silently', 'reuse-session'],
});

/**
 * 認可コードを発行し、それを含む認可レスポンスを返す。
 *
 * 画面の要らないリクエスト（`prompt=none`、または以前に同意したエンドユーザーの SSO）から呼ばれる。
 * トランザクションを削除してから認可コードを作り、ストアに保存する。
 * 同意リゾルバに `recordGrant` があれば、エンドユーザー、クライアント、グラント ID の組を記録する。
 *
 * レスポンスタイプに応答する機能（インプリシットフローの `id_token` など）があれば、ここでは認可コードを発行せず、その機能のハンドラの結果を返す。
 *
 * `transaction.scope` は、認可リクエストの検証で `applyOfflineAccessPolicy()` を通した後の値である。
 * `offline_access` を残すかどうか（OIDC Core 1.0 §11 の `prompt=consent` と、クライアント登録の `grant_types` に `refresh_token` があるか）はそこで判定済みなので、ここではスコープを絞り直さない。
 *
 * @spec OIDC Core 1.0 §3.1.2.5
 * @spec OIDC Core 1.0 §3.1.3.1
 * @spec RFC 9207 §2
 */
export async function issueAuthorizationCodeResponse(
  c: any,
  input: {
    transactionId: string;
    transaction: AuthTransaction;
    session: SessionInfo;
    issuer: string;
    responseMode: AuthorizationResponseMode | undefined;
  },
): Promise<AuthorizationOutcome> {
  const { transactionId, transaction, session, issuer, responseMode } = input;

  // 機能が応答するレスポンスタイプ（インプリシットフローの `id_token` や `id_token token` など、OIDC Core 1.0 §3.2）なら、その機能のハンドラの結果を返す。
  // ハンドラは、その機能の `feature.ts` の `authorize.responseTypes` に登録したものである。
  const responseType = responseTypeHandlerOf(transaction.responseType);
  if (responseType) return responseType.respond(c, input);

  const transactionStore = c.get('transactionStore');
  const authCodeStore = c.get('authCodeStore');
  const consentResolver = c.get('consentResolver');
  const config = c.get('config');

  const grantedScope = transaction.scope.split(' ').filter(Boolean);

  // トランザクションを削除し、認可コードに入れる値を取り出す。
  // 削除を認可コードの発行より前に行い、同じトランザクションから二度発行されないようにする。
  const responseParams = await completeAuthTransaction(
    transactionId,
    transaction,
    transactionStore,
  );
  const authCodeData = await createAuthorizationCode({
    authorizationResponse: { ...responseParams, scope: grantedScope },
    subject: session.subject,
    authTime: session.authTime,
    // オンラインのリフレッシュトークンをこのログインセッション（`prompt=none` や SSO で再利用したもの）に結び付けるため、セッション ID を引き継ぐ。
    // セッションが終わると、そのリフレッシュトークンは `invalid_grant` になる。
    sessionId: session.sessionId,
    // 認可コードの有効期間は `ProviderConfig` の `authorizationCodeTtl` で設定でき、既定は 300 秒である（OIDC Core 1.0 §3.1.3.1）。
    ttlSeconds: config.authorizationCodeTtl,
  });
  await authCodeStore.set(authCodeData.code, authCodeData);
  await consentResolver?.recordGrant?.(
    session.subject,
    transaction.clientId,
    authCodeData.grantId,
  );

  return {
    kind: 'authorization_response',
    response: await buildSuccessResponse(
      responseMode, transaction.redirectUri,
      authCodeData.code,
      transaction.state,
      issuer,
    ),
  };
}
