/**
 * クライアントが登録した公開鍵を、用途ごとに引く口。
 *
 * クライアントの公開鍵を使う処理（private_key_jwt のクライアント認証、署名付き
 * Request Object の検証、DPoP proof の検証など）は、鍵の保存先を知らずに
 * {@link ClientKeyResolver} から自分の用途の鍵だけを受け取る。鍵の保存と運用
 * （登録、入れ替え、削除）は resolver の実装と利用者が受け持つ。
 */
import type { ClientInfo, ClientResolver } from './authorization-request.js';
import type { JwkSet } from './jwks.js';

/**
 * クライアントの公開鍵の用途。鍵を使う処理の名前で表す。
 *
 * - `private_key_jwt`: クライアント認証のアサーション（OIDC Core 1.0 §9 / RFC 7523 §3）
 * - `request_object`: 署名付き Request Object（OIDC Core 1.0 §6.3.2 / RFC 9101 §6.2）
 * - `dpop`: DPoP proof（RFC 9449）。DPoP の proof は検証に使う鍵を自分の `jwk` ヘッダーに
 *   持つので、登録した鍵の proof だけを受け付ける OP が使う
 *
 * 文字列なので、ほかの用途も足せる。
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

/**
 * クライアント登録のメタデータ `jwks`（RFC 7591 §2 / {@link ClientInfo.jwks}）が受け持つ用途。
 * `jwks` は用途を分けない 1 組の鍵で、クライアント認証の JWT と Request Object の署名の
 * 検証に使う。
 */
export const JWKS_CLIENT_KEY_PURPOSES: readonly ClientKeyPurpose[] = ['private_key_jwt', 'request_object'];

/**
 * クライアントの登録メタデータ `jwks` を鍵の保存先にする {@link ClientKeyResolver}。
 *
 * `purposes` の用途（既定は {@link JWKS_CLIENT_KEY_PURPOSES}）には、clientResolver が返す
 * クライアントの `jwks` を、ほかの用途には空の JWK Set を返す。呼ばれるたびに
 * clientResolver でクライアントを引くので、登録の変更は次の呼び出しから効く。
 */
export function createClientJwksKeyResolver(
  clientResolver: ClientResolver,
  purposes: readonly ClientKeyPurpose[] = JWKS_CLIENT_KEY_PURPOSES,
): ClientKeyResolver {
  return {
    async findClientKeys(clientId, purpose) {
      if (!purposes.includes(purpose)) return { keys: [] };
      const client = await clientResolver.findClient(clientId);
      return { keys: [...(client?.jwks?.keys ?? [])] };
    },
  };
}
