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
 * ログアウト要求を「即時ログアウト」と「確認画面」に分岐する。
 *
 * 即時ログアウトは、ヒントが有効で、現在のブラウザセッションが存在し、ヒントの
 * `sub` がセッションの subject と一致する場合のみ（§2 の SHOULD 解釈。RP の
 * ログアウト操作は End-User 自身の操作であり、有効なヒントは RP がその End-User に
 * トークンを発行された当人であることを示す）。それ以外はすべて確認画面に落とす。
 * 落とした理由は返さない（失敗理由の差はセッション状態のオラクルになるため、
 * 呼び出し側も画面に出さない前提）。
 *
 * @param options.verifiedHint core `validateIdTokenHint` の戻り値（検証失敗時は null を渡す）
 * @param options.expectedAudience 検証に使った期待 aud（`client_id` パラメータ、
 *   または `extractIdTokenHintAudience` の結果。特定不能は null）
 * @param options.clientIdParam リクエストの `client_id` パラメータ。指定時は
 *   expectedAudience と一致しなければヒント全体を無効にする（§2 MUST）
 * @param options.sessionSubject 現在のブラウザセッションの subject（セッションなしは null）
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
