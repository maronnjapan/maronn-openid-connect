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
 * ユーザーコードを作り、表示形式（`XXXX-XXXX`）で返す。
 *
 * RFC 8628 §6.1 が勧める 20 文字の文字種（{@link USER_CODE_CHARSET}）から、暗号論的に安全な乱数で {@link USER_CODE_LENGTH} 文字を選ぶ。
 * 20 は 256 の約数ではないので、乱数のバイトを 20 で割った余りをそのまま使うと、文字ごとの出現確率が偏る。
 * 偏りがあると 20^8 通りというエントロピーの主張が弱まるので、余りの周期に収まらないバイト（240 以上）は捨てて引き直す（棄却サンプリング）。
 *
 * 文字種と長さは設定できるようにしていない。
 * 利用者の設定の誤りでエントロピーの保証を壊さないためで、変えたいときは定数を書き換えたフォークを作ることを想定している（試験実装から正式な機能に移すときに、設定にするかを見直す）。
 *
 * @spec RFC 8628 §6.1
 */
export function generateUserCode(): string {
  const charset = USER_CODE_CHARSET;
  // 256 を `charset.length` で割った余りの周期に収まらない値の下限（20 文字なら 240）。
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
 * ユーザーコードを 4 文字ごとに `-` で区切って返す。
 *
 * 正規化したユーザーコード（{@link normalizeUserCode} の出力）を受け取り、{@link USER_CODE_GROUP_SIZE} 文字ごとに区切った表示形式（`XXXX-XXXX`）を返す。
 * 書き写しやすくするために、区切り文字を入れてよい（RFC 8628 §6.1）。
 * 区切り文字は、照合の前に {@link normalizeUserCode} が取り除く。
 *
 * @spec RFC 8628 §6.1
 */
export function formatUserCode(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += USER_CODE_GROUP_SIZE) {
    groups.push(normalized.slice(i, i + USER_CODE_GROUP_SIZE));
  }
  return groups.join('-');
}

/**
 * 入力されたユーザーコードを、照合に使うキーにして返す。
 *
 * 小文字を大文字にし、空白（全角の空白を含む）と ASCII のハイフン（`-`）を取り除く。
 * 大文字と小文字の違いや区切り文字の有無を、ユーザーに守らせないためである（RFC 8628 §6.1）。
 *
 * 文字種が正しいかは、ここでは確かめない。
 * 形式が正しくないコードは照合に失敗し、実在しないコードと同じ文言のエラーになる。
 * 実在しないコードと形式が正しくないコードを区別させないための設計である。
 *
 * @spec RFC 8628 §6.1
 */
export function normalizeUserCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s　-]/g, '');
}

/**
 * 既存のレコードと重ならないユーザーコードを作って返す。
 *
 * 戻り値は、照合に使う正規化した値（`userCode`）と、表示形式の値（`userCodeDisplay`）である。
 * {@link generateUserCode} で作ったコードを正規化して `findByUserCode` で探し、レコードがなければその値を返し、あれば作り直す。
 * 重なったまま保存すると、`findByUserCode` が別のレコードを返し、あるユーザーの承認が別のデバイスに渡るおそれがある。
 *
 * 重なる確率は 1/20^8 程度なので、上限の回数（`maxAttempts`、既定は 5）まで作り直せば、実際上は必ず成功する。
 * 上限に達したら、エラーを無視せずに投げ、生成されたコードが 500 で応答する。
 *
 * @throws {Error} `maxAttempts` 回続けて既存のレコードと重なったとき。
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
  // 作ったコードの値は、ログにも例外のメッセージにも含めない（RFC 8628 §5.1）。
  throw new Error(
    `Failed to generate a unique user_code after ${maxAttempts} attempts`,
  );
}
