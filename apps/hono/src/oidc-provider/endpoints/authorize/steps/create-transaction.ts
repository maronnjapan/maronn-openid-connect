import {
  type AuthTransaction,
  type ValidatedAuthorizationRequest,
  createAuthTransaction,
  generateRandomString,
} from '@maronn-openid-connect/core';
import type { AuthorizationTransaction } from '../outcome.js';
import type { AuthorizationResponseMode } from '../response-mode.js';
import { confirmationRecordOf } from '../../../token-binding.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'create-transaction',
  endpoint: 'authorize',
  kind: 'persist',
  label: '認可トランザクションを作って保存する',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'createAuthorizationTransaction',
  consumes: ['validatedRequest', 'responseMode', 'codeConfirmation'],
  optional: ['responseMode', 'codeConfirmation'],
  produces: ['transactionId', 'transaction', 'transactionTtlSeconds'],
  removable: false,
});

/**
 * トランザクションを作って保存し、ID と有効期間を返す。
 *
 * トランザクションは、検証済みのリクエストと新しい CSRF トークンから作り、ログインと同意のステップのために `auth_txn:<トランザクション ID>` のキーで 10 分間保存する。
 * CSRF トークンは、ログインフォームと同意画面のフォームに埋め込む。
 * トランザクション ID は、`HttpOnly` のトランザクションの Cookie（`cookies.ts` の `buildTransactionCookie()`）でしか OP の外へ出さない。
 *
 * 機能のレスポンスモード（JARM など）があれば、その名前をトランザクションの `responseMode` に記録して保存する。
 * 同意のステップはストアから読み戻したトランザクションしか使わないので、この記録から同じモードを復元して応答する（`response-mode.ts` の `restoreResponseMode()`）。
 * そのため、ストアは、型に定義されていないフィールドも捨てずに保存する必要がある。
 *
 * 機能（dpop）が認可リクエストを鍵に束縛するとき（`codeConfirmation`。`dpop_jkt`、RFC 9449 §10）は、その確認を `cnf` としてトランザクションに入れる。
 * このトランザクションから発行する認可コードは、同じ `cnf` を引き継ぐ。
 * `codeConfirmation` がなければ、`cnf` は入れない。
 *
 * @spec OIDC Core 1.0 §3.1.2.3
 * @spec RFC 9449 §10
 */
export async function createAuthorizationTransaction(
  c: any,
  validatedRequest: ValidatedAuthorizationRequest,
  responseMode: AuthorizationResponseMode | undefined,
  codeConfirmation?: Readonly<Record<string, string>>,
): Promise<AuthorizationTransaction> {
  const transactionStore = c.get('transactionStore');
  const csrfToken = await generateRandomString(32);
  const transaction: AuthTransaction = {
    ...createAuthTransaction(validatedRequest, csrfToken),
    ...confirmationRecordOf({ cnf: codeConfirmation }),
  };
  const transactionId = await generateRandomString(32);

  const transactionTtlSeconds = 10 * 60; // 有効期間は 10 分。
  await transactionStore.put(
    'auth_txn:' + transactionId,
    responseMode ? { ...transaction, responseMode: responseMode.name } : transaction,
    transactionTtlSeconds,
  );
  return { transactionId, transaction, transactionTtlSeconds };
}
