/**
 * OpenID Connect RP-Initiated Logout 1.0 — ログアウトフローの分岐判定。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * §2 MUST: `id_token_hint` が無い、または供給された ID Token が現在の OP
 * セッションのものでない場合、OP はユーザーに確認しなければならない。
 * §7: 有効なヒントのないログアウト要求はセッション終了の DoS 手段になり得る。
 * この関数はその MUST をそのまま分岐にした純関数で、HTTP にもストアにも触れない。
 */

/** `decideLogoutFlow` の判定結果。生成コードのルートはこの型だけを見て分岐する。 */
export interface LogoutDecision {
  /** true: 確認画面を出す（§2 MUST）。false: 即時ログアウト。 */
  requiresConfirmation: boolean;
  /**
   * §3 のリダイレクト権限を持つ検証済みクライアント。ヒントが無効（検証失敗・
   * `client_id` 不一致・aud 特定不能）なら null。確認画面の経路でも、ヒント自体が
   * 有効ならリダイレクト権限は残る（リダイレクトの条件はヒントの供給と登録値の
   * 完全一致であり、確認画面の経由有無ではない）。
   */
  verifiedClientId: string | null;
}

/**
 * 確認画面の要否と、検証済みのクライアントを返す。
 *
 * `id_token_hint`（ヒント）を有効とみなすのは、`verifiedHint` と `expectedAudience` がどちらも `null` でなく、`clientIdParam` が指定されていればそれが `expectedAudience` と一致するときである。
 * ヒントが有効なら、`verifiedClientId` に `expectedAudience` を入れて返し、無効なら `null` を入れて返す。
 *
 * `requiresConfirmation` を false（すぐにログアウトする）にするのは、ヒントが有効で、現在のブラウザのセッションがあり、ヒントの `sub` がセッションのサブジェクトと一致するときだけである。
 * それ以外はすべて true（確認画面を出す）にする。
 *
 * RP-Initiated Logout 1.0 §2 は、ログアウトしてよいかをエンドユーザーに確認することを推奨（SHOULD）しているが、この関数は、上の条件を満たすときは確認を省いてよいと解釈している。
 * RP からのログアウトはエンドユーザー自身の操作であり、有効なヒントは、そのエンドユーザーの ID トークンが実際にその RP に発行されたことを示すためである。
 *
 * 確認画面にした理由は返さない。
 * 理由を画面で区別できると、それがセッションの状態を外から推測する手がかりになるためである。
 * 呼び出し側も、理由を画面に出さない前提である。
 *
 * @param options.verifiedHint core の `validateIdTokenHint()` の戻り値。
 *   検証に失敗したときは `null` を渡す。
 * @param options.expectedAudience ヒントの検証で期待した `aud` の値。
 *   `client_id` パラメータか `extractIdTokenHintAudience()` の結果で、特定できなかったときは `null` を渡す。
 * @param options.clientIdParam リクエストの `client_id` パラメータ。
 *   指定されたときは、`expectedAudience` と一致しなければヒント全体を無効にする（RP-Initiated Logout 1.0 §2 の MUST）。
 * @param options.sessionSubject 現在のブラウザのセッションのサブジェクト。
 *   セッションがなければ `null` を渡す。
 * @spec RP-Initiated Logout 1.0 §2
 */
export function decideLogoutFlow(options: {
  verifiedHint: { sub: string; [key: string]: unknown } | null;
  expectedAudience: string | null;
  clientIdParam: string | undefined;
  sessionSubject: string | null;
}): LogoutDecision {
  const { verifiedHint, expectedAudience, clientIdParam, sessionSubject } = options;

  const hintValid =
    verifiedHint !== null &&
    expectedAudience !== null &&
    (clientIdParam === undefined || clientIdParam === expectedAudience);

  const verifiedClientId = hintValid ? expectedAudience : null;

  const requiresConfirmation = !(
    hintValid &&
    sessionSubject !== null &&
    verifiedHint.sub === sessionSubject
  );

  return { requiresConfirmation, verifiedClientId };
}
