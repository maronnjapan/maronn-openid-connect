/**
 * OAuth 2.0 Device Authorization Grant — RFC 8628 §6.1
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * user_code の生成と正規化。
 */
import {
  USER_CODE_CHARSET,
  USER_CODE_GROUP_SIZE,
  USER_CODE_LENGTH,
  type DeviceAuthorizationStore,
} from './store.js';

/**
 * user_code を 1 つ生成する（表示形式 `XXXX-XXXX`）。
 *
 * RFC 8628 §6.1 推奨の base-20 文字種から {@link USER_CODE_LENGTH} 文字を
 * CSPRNG で選ぶ。20 は 256 の約数ではないため、単純な剰余では文字ごとの出現確率が
 * 偏る（modulo bias）。偏りは 20^8 のエントロピー主張を弱めるので、剰余の周期に
 * 収まらないバイトは破棄して引き直す（rejection sampling）。
 *
 * 文字種と長さは設定値にしていない。エントロピー保証を利用者の設定ミスで壊さない
 * ためで、変更したい場合は定数を fork する想定（昇格時に設定化を再検討）。
 */
export function generateUserCode(): string {
  const charset = USER_CODE_CHARSET;
  // 256 を charset.length で割った剰余の周期に収まらない値の下限。
  const limit = 256 - (256 % charset.length);
  let code = '';
  const buffer = new Uint8Array(1);
  while (code.length < USER_CODE_LENGTH) {
    crypto.getRandomValues(buffer);
    const byte = buffer[0] as number;
    if (byte >= limit) continue;
    code += charset[byte % charset.length];
  }
  return formatUserCode(code);
}

/**
 * 正規化済みの user_code を表示形式（`XXXX-XXXX`）へ整形する。
 *
 * RFC 8628 §6.1: 書き写しやすさのため区切り文字を入れてよい。区切りは照合前に
 * {@link normalizeUserCode} が除去する。
 */
export function formatUserCode(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += USER_CODE_GROUP_SIZE) {
    groups.push(normalized.slice(i, i + USER_CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * ユーザー入力の user_code を照合キーへ正規化する。
 *
 * RFC 8628 §6.1: 大文字小文字の別・区切り文字の有無をユーザーに強制しない。
 * 小文字を大文字化し、空白（全角スペースを含む）とハイフン類を除去する。
 * 文字種の妥当性検証はここでは行わない（照合が失敗すれば同一文言のエラーになる。
 * 実在しないコードと不正な形式のコードを区別しないための設計）。
 */
export function normalizeUserCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s　-]/g, '');
}

/**
 * 既存の pending レコードと衝突しない user_code を生成する。
 *
 * 衝突したまま保存すると `findByUserCode` が別レコードを返し、あるユーザーの承認が
 * 別デバイスへ渡り得る。衝突確率は 1/20^8 程度なので、上限回数まで引き直せば実際上
 * 必ず成功する。上限に達した場合は握りつぶさず throw し、生成コード側で 500 にする。
 *
 * @throws {Error} 規定回数連続で衝突した場合
 */
export async function generateUniqueUserCode(
  store: DeviceAuthorizationStore,
  maxAttempts = 5,
): Promise<{ userCode: string; userCodeDisplay: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const userCodeDisplay = generateUserCode();
    const userCode = normalizeUserCode(userCodeDisplay);
    const existing = await store.findByUserCode(userCode);
    if (existing === null) {
      return { userCode, userCodeDisplay };
    }
  }
  // 生成された値そのものはログにも例外にも残さない（RFC 8628 §5.1）。
  throw new Error(
    `Failed to generate a unique user_code after ${maxAttempts} attempts`,
  );
}
