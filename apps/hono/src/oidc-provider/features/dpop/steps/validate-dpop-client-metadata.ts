import { step } from '../../../endpoints/step.js';

export const meta = step({
  id: 'validate-dpop-client-metadata',
  endpoint: 'register',
  feature: 'dpop',
  kind: 'validate',
  label: 'dpop_bound_access_tokens を検証して登録する',
  spec: 'RFC 9449 §5.2 / RFC 7591 §2',
  function: 'registerDpopClientMetadata',
  consumes: ['metadata', 'client'],
  produces: ['dpopClient', 'dpopRejection'],
  removable: false,
  after: ['validate-metadata'],
  before: ['store-client'],
});

/** What registerDpopClientMetadata() decided. */
export interface DpopClientRegistration<Client> {
  /** The client to register, with dpop_bound_access_tokens among its registered metadata. */
  dpopClient?: Client;
  /** The error response to answer with when dpop_bound_access_tokens is not a boolean. */
  dpopRejection?: Response;
}

/**
 * 登録するクライアントのメタデータに `dpop_bound_access_tokens` を入れて返す。
 *
 * `dpop_bound_access_tokens` は、クライアントが常に DPoP を使うかを示す真偽値のクライアントメタデータで、省略したときは `false` である（RFC 9449 §5.2）。
 * リクエストのメタデータ（`metadata`。ソフトウェアステートメントを適用したもの）の値を検証し、省略していれば `false` にして、`client.metadata` に `dpop_bound_access_tokens` の名前で入れたクライアントを `dpopClient` に入れて返す。
 * 登録エンドポイントは、このクライアントを保存し、201 のレスポンスで登録したメタデータとして返す（RFC 7591 §3.2.1）。
 * 保存したクライアントは `registrationMetadata` にこの値を持つので、トークンエンドポイントの `dpopBoundAccessTokensOf()` が読む。
 *
 * 前のステップ（メタデータの検証）が `dpop_bound_access_tokens` を登録していれば、リクエストの値の代わりにその値を検証する。
 * 動的クライアント登録の設定の `customClientMetadata` にこの名前の検証関数を置いたときで、その関数が既定値を決めたり、値を求めたりできる。
 * `client` も `metadata` も書き換えない。
 *
 * 真偽値でない値（文字列の `"true"`、`null` など）は登録せず、動的クライアント登録のエラーと同じ形（RFC 7591 §3.2.2）の 400 の `invalid_client_metadata`（キャッシュを禁止した JSON）を `dpopRejection` に入れて返す。
 * 動的クライアント登録の機能のエラーの型を使わないのは、DPoP の機能がその機能なしでも生成されるためである（そのときもこのファイルは生成されるが、登録エンドポイントがないので、どこからも呼ばれない）。
 * レスポンスはコンテキストで組み立てるので、CORS のミドルウェアが付けたヘッダーも残る。
 *
 * @spec RFC 9449 §5.2
 * @spec RFC 7591 §2
 * @spec RFC 7591 §3.2.2
 */
export function registerDpopClientMetadata<Client extends { readonly metadata: Readonly<Record<string, unknown>> }>(
  c: any,
  metadata: Readonly<Record<string, unknown>>,
  client: Client,
): DpopClientRegistration<Client> {
  const value = 'dpop_bound_access_tokens' in client.metadata
    ? client.metadata['dpop_bound_access_tokens']
    : metadata['dpop_bound_access_tokens'];
  if (value !== undefined && typeof value !== 'boolean') {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return {
      dpopRejection: c.json(
        { error: 'invalid_client_metadata', error_description: 'dpop_bound_access_tokens must be a boolean' },
        400,
      ),
    };
  }
  return { dpopClient: { ...client, metadata: { ...client.metadata, dpop_bound_access_tokens: value ?? false } } };
}
