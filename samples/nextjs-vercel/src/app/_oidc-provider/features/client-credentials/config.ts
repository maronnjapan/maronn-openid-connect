/**
 * The setting of the client-credentials feature. createProviderConfig() of
 * config.ts takes its default from feature.ts.
 */
declare module '../../config' {
  interface ProviderConfig {
    /**
     * client_credentials グラント（RFC 6749 §4.4）の `audience` パラメータで要求できる
     * リソース（アクセストークンの `aud` に入れる値）の一覧。
     *
     * 既定は空（フェイルセーフ）で、`audience` を指定したリクエストはすべて `invalid_target`
     * （RFC 8707 §2）で拒否する。`audience` を省いたリクエストには、`aud` が issuer の
     * アクセストークンを発行する。このグラントにはエンドユーザーの同意がないので、クライアントが
     * 名乗っただけのリソースを `aud` に入れず、ここに挙げたリソースだけを発行先にする。
     * 下流のリソースサーバーの識別子（例: `https://api.example.com`）を並べる。
     */
    clientCredentialsAllowedAudiences: readonly string[];
  }
}

export {};
