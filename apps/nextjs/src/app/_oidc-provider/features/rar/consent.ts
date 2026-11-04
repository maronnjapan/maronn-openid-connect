import { describeAuthorizationDetails, type AuthorizationDetailTypeDefinition } from '@maronn-openid-connect/experimental/rar';
import { rarGrantStore, rarTransactionStore } from './store';

/**
 * トランザクションに保持した authorization details の表示行を返す。
 *
 * details の無いトランザクションでは空配列を返す。あれば、`rarTypes` の型定義の
 * `describe` が作るプレーン文字列の行を返し、同意画面が scope の一覧と併記する
 * （RFC 9396 §3.1 の merged set）。行のエスケープは view 層（JSX）に委ねる。
 *
 * 保持した details の type に対応する型定義が無くなっていたら例外を投げる
 * （表示できない要素を黙って落とすと、見ていない権限が承認されてしまう）。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §3.1
 * @throws {RarError} 保持した details の type に対応する型定義が設定から消えているとき
 */
export async function describeTransactionAuthorizationDetails(
  transactionId: string,
  rarTypes: readonly AuthorizationDetailTypeDefinition[] | undefined,
): Promise<readonly string[]> {
  const details = await rarTransactionStore.get(transactionId);
  if (details === undefined) return [];
  return describeAuthorizationDetails(details, rarTypes ?? []);
}

/**
 * 承認されたトランザクションの authorization details を grantId へ付け替える。
 *
 * details の無いトランザクションでは何もしない。あれば grantId をキーに保存し、
 * transactionId 側のエントリを削除する。grantId は authorization_code と
 * refresh_token の両グラントを貫通するので、トークン応答（RFC 9396 §7）と
 * introspection（§9.2）はこのキーで details を引ける。
 *
 * 保存の寿命は `発行時刻 + refreshTokenAbsoluteLifetimeSeconds`。ローテーションは
 * 絶対寿命を初回発行時刻起点で固定するため、有効なリフレッシュトークンが存在する
 * 間にエントリが先に消えることはない。リフレッシュトークンを発行しないグラントでは
 * 寿命まで過剰保持になるが、in-memory の experimental として許容している。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §7
 */
export async function recordGrantedAuthorizationDetails(
  transactionId: string,
  grantId: string,
  refreshTokenAbsoluteLifetimeSeconds: number,
): Promise<void> {
  const details = await rarTransactionStore.get(transactionId);
  if (details === undefined) return;
  await rarGrantStore.set(grantId, details, Date.now() + refreshTokenAbsoluteLifetimeSeconds * 1000);
  await rarTransactionStore.delete(transactionId);
}
