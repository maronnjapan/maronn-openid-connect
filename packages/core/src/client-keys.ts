/**
 * クライアントが登録した公開鍵を、用途ごとに引く口。
 *
 * クライアントの公開鍵を使う処理（private_key_jwt のクライアント認証、署名付き
 * Request Object の検証、DPoP proof の検証など）は、鍵の保存先を知らずに
 * {@link ClientKeyResolver} から自分の用途の鍵だけを受け取る。鍵の保存と運用
 * （登録、入れ替え、削除）は resolver の実装と利用者が受け持つ。
 */
import type { JwkSet } from './jwks.js';

/**
 * クライアントの公開鍵の用途。鍵を使う処理の名前で表す。
 *
 * - `private_key_jwt`: クライアント認証のアサーション（OIDC Core 1.0 §9 / RFC 7523 §3）
 * - `request_object`: 署名付き Request Object（OIDC Core 1.0 §6.3.2 / RFC 9101 §6.2）
 * - `dpop`: DPoP proof（RFC 9449）。DPoP の proof は検証に使う鍵を自分の `jwk` ヘッダーに
 *   持つので、登録した鍵の proof だけを受け付ける OP が使う
 *
 * 文字列なので、ほかの用途も足せる。core で鍵を受け取る処理は署名付き Request Object の検証
 * （`resolveRequestObjectParams()` の `options.jwks`）だけで、private_key_jwt と DPoP の検証は持たない。
 */
export type ClientKeyPurpose = 'private_key_jwt' | 'request_object' | 'dpop' | (string & {});

/**
 * クライアントが用途ごとに登録した公開鍵を引く。
 *
 * 鍵の追加や削除がすぐ効くように、実装は呼ばれるたびに保存先を読むこと。
 */
export interface ClientKeyResolver {
  /**
   * client_id のクライアントが purpose の用途に登録した公開鍵を返す。
   * 鍵が無い（クライアントが無い場合も含む）ときは、`keys` が空の JWK Set を返す。
   */
  findClientKeys(clientId: string, purpose: ClientKeyPurpose): Promise<JwkSet>;
}

/** 1 つのクライアントの公開鍵。キーが用途、値がその用途の JWK Set。 */
export interface ClientKeysByPurpose {
  private_key_jwt?: JwkSet;
  request_object?: JwkSet;
  dpop?: JwkSet;
  [purpose: string]: JwkSet | undefined;
}

/**
 * クライアントごとの「用途 → JWK Set」を返す lookup から {@link ClientKeyResolver} を作る。
 * 設定ファイルや環境変数に書いたクライアントの鍵のように、鍵をまとめて持つ保存先に使う。
 *
 * 呼ばれるたびに lookup を呼ぶので、lookup が返す値を変えれば次の呼び出しから効く。
 */
export function createClientKeyResolver(
  lookup: (clientId: string) => ClientKeysByPurpose | undefined | Promise<ClientKeysByPurpose | undefined>,
): ClientKeyResolver {
  return {
    async findClientKeys(clientId, purpose) {
      const keys = await lookup(clientId);
      return { keys: [...(keys?.[purpose]?.keys ?? [])] };
    },
  };
}
