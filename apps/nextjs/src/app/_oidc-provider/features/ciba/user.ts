import { stores } from '../../provider';

/**
 * `login_hint` のユーザーのサブジェクトを返す。
 *
 * バックチャネル認証リクエストの宛先となるエンドユーザーを、`login_hint` から特定する。
 * 既定では、ヒントをユーザーストアのユーザー名として扱い、そのユーザーのクレームの `sub` を `subject` として返す。
 * メールアドレス、電話番号、独自の識別子でユーザーを特定するときは、この関数を書き換える。
 * 一致するユーザーがいなければ `null` を返す。
 *
 * @spec CIBA Core 1.0 §7.1
 */
export async function resolveCibaUser(loginHint: string): Promise<{ subject: string } | null> {
  const claims = await stores.userStore.getClaims(loginHint);
  return claims ? { subject: claims.sub } : null;
}
