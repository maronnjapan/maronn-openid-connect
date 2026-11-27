/**
 * トークンの、DPoP の鍵への束縛（RFC 9449 §5 / §6）。
 *
 * OP は、DPoP proof の鍵の JWK Thumbprint（`jkt`）を、発行するアクセストークンの `cnf` に入れ（RFC 9449 §6.1）、
 * 保存するアクセストークンのレコードにも同じ `cnf` を残す（イントロスペクションが返す。RFC 9449 §6.2）。
 */

/**
 * DPoP で束縛したトークンの確認（`cnf`）のメンバー（RFC 7800 §3.1、RFC 9449 §6.1）。
 *
 * 型の別名にしてあるので、確認の値を `Record<string, string>` として扱う呼び出し側にもそのまま渡せる。
 */
export type DpopConfirmation = {
  /** DPoP proof の鍵の JWK Thumbprint（SHA-256、base64url） */
  jkt: string;
};

/**
 * DPoP の鍵の JWK Thumbprint から、トークンの `cnf` の値を返す。
 *
 * @spec RFC 9449 §6.1
 * @spec RFC 7800 §3.1
 */
export function buildDpopConfirmation(jkt: string): DpopConfirmation {
  return { jkt };
}
