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
 * （`resolveRequestObjectParams()` の `options.loadJwks`）と private_key_jwt のクライアントアサーションの
 * 検証（`loadClientAssertionKeys()`）で、DPoP の検証は持たない。
 */
export type ClientKeyPurpose = 'private_key_jwt' | 'request_object' | 'dpop' | (string & {});

/**
 * 鍵を引くときの手がかり。{@link ClientKeyResolver.findClientKeys} の任意の第 3 引数。
 */
export interface ClientKeyLookupHint {
  /**
   * 検証する JWS の JOSE ヘッダーの `kid`。`jwks_uri` を登録したクライアントでは、キャッシュに無い
   * kid が鍵を取り直す合図になる（OIDC Core 1.0 §10.1.1）。値で保存した鍵を返す実装は無視してよい。
   */
  kid?: string;
}

/**
 * クライアントが用途ごとに登録した公開鍵を引く。
 *
 * 鍵の追加や削除がすぐ効くように、実装は呼ばれるたびに保存先を読むこと。
 */
export interface ClientKeyResolver {
  /**
   * クライアントが `purpose` 用に登録した公開鍵を返す。
   *
   * 鍵がないとき（`clientId` のクライアントがないときも含む）は、`keys` が空の JWK Set を返す。
   * `hint`（{@link ClientKeyLookupHint}）は検証する JWS の手がかりで、省略できる（`kid` を使う実装は、`jwks_uri` を取り直す合図にする）。
   */
  findClientKeys(clientId: string, purpose: ClientKeyPurpose, hint?: ClientKeyLookupHint): Promise<JwkSet>;
}

/** 1 つのクライアントの公開鍵。キーが用途、値がその用途の JWK Set。 */
export interface ClientKeysByPurpose {
  private_key_jwt?: JwkSet;
  request_object?: JwkSet;
  dpop?: JwkSet;
  [purpose: string]: JwkSet | undefined;
}

/**
 * `lookup` で鍵を取得するリゾルバを作って返す。
 *
 * `lookup` は、クライアント ID を受け取り、そのクライアントの用途ごとの JWK Set（{@link ClientKeysByPurpose}）を返す関数である。
 * 設定ファイルや環境変数に書いたクライアントの鍵のように、鍵をまとめて持つ保存先に使う。
 *
 * 返す {@link ClientKeyResolver} の `findClientKeys()` は、呼ばれるたびに `lookup` を呼び、指定された用途の鍵の配列を複製して返す。
 * `lookup` が `undefined` を返したとき、またはその用途の鍵がないときは、`keys` が空の JWK Set を返す。
 * そのため、`lookup` が返す値を変えれば、次の呼び出しから新しい鍵が使われる。
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
