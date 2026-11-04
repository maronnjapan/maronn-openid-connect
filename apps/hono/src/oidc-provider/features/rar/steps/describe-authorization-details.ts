import { describeAuthorizationDetails } from '@maronn-openid-connect/experimental/rar';
import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'describe-authorization-details',
  endpoint: 'consent',
  feature: 'rar',
  kind: 'transform',
  label: '同意画面に出す authorization details の表示行を作る',
  spec: 'RFC 9396 §3.1',
  function: 'describeTransactionAuthorizationDetails',
  calls: ['rarTransactionStore.get'],
  consumes: ['transactionId'],
  produces: ['authorizationDetails'],
  removable: false,
});

/**
 * トランザクションに保持した authorization details の表示行を返す。
 *
 * details の無いトランザクションでは `undefined` を返し、同意画面は従来どおりに
 * なる。あれば、`config.rarTypes` の型定義の `describe` が作るプレーン文字列の行を
 * 返し、同意画面が scope の一覧と併記する（RFC 9396 §3.1 の merged set）。
 * 行のエスケープは view 層（JSX）に委ねる。
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
  c: any,
  transactionId: string,
): Promise<readonly string[] | undefined> {
  const rarTransactionStore = c.get('rarTransactionStore');
  const details = await rarTransactionStore.get(transactionId);
  if (details === undefined) return undefined;
  const config = c.get('config');
  return describeAuthorizationDetails(details, config.rarTypes ?? []);
}
