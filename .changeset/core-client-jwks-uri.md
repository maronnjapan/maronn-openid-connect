---
'@maronn-openid-connect/core': minor
---

クライアントの `jwks_uri`（RFC 7591 §2）から鍵を取得する部品と、`request_object_signing_alg`（OpenID Connect Dynamic Client Registration 1.0 §2）の検査を追加し、Request Object の署名検証で鍵と alg を 1 対 1 に固定する（RFC 8725 §3.1）

- `validateClientJwksUri()`、`parseClientJwkSet()`、`resolveClientJwksTtlSeconds()`、`fetchClientJwkSet()`、`createClientJwksUriCache()`、`withClientJwksUriKeys()` と `ClientJwksUriError`、`DEFAULT_CLIENT_JWKS_URI_OPTIONS` を追加する。宛先の検査（https 必須、フラグメントと userinfo の拒否、`localhost` とループバック・私設・リンクローカルの IP リテラルの拒否）、タイムアウト（既定 3 秒）、本文の上限（既定 64 KiB）、リダイレクト不追従、鍵の数の上限（既定 32）、秘密鍵と対称鍵を含む JWK Set の拒否、`Cache-Control: max-age` を下限 30 秒・上限 300 秒に丸めた期限、見慣れない kid での取り直し（OIDC Core 1.0 §10.1.1。既定で 30 秒に 1 回まで）を持つ。既定値はどれも各関数の引数で 1 項目ずつ上書きでき、`fetch` も注入できる
- `ClientKeyResolver.findClientKeys()` に任意の第 3 引数 `hint`（`ClientKeyLookupHint`。JOSE ヘッダーの `kid`）を足す。2 引数の実装はそのまま型に合う
- `parseRequestObject()` に `requiredSigningAlg` と `loadJwks` を、`resolveRequestObjectParams()` に `requestObjectSigningAlg` と `loadJwks` を足す。登録した alg と違う Request Object は、`alg: "none"` も含めてほかのどの検査よりも先に `invalid_request_object` で拒否する（OIDC Core 1.0 §6.3.2）。`loadJwks` は JOSE ヘッダーの検査を通った後でだけ呼び、`ClientJwksUriError` は理由を含まない固定文言（`the client jwks_uri could not be retrieved`）の `invalid_request_object` になる
- `SUPPORTED_REQUEST_OBJECT_SIGNING_ALGS`（RS256、RS384、RS512、ES256、ES384、ES512）、`resolveJwkSigningAlg()`、`importJwkForJwsVerification()` を追加する。`DEFAULT_REQUEST_OBJECT_SIGNING_ALGS` は `['RS256']` のまま
- 挙動の変化: Request Object の検証は、使える alg（RSA 鍵は `alg`、無ければ RS256。EC 鍵は `crv` から決まる alg）がヘッダーの `alg` と同じ鍵だけを使い、`use` が `sig` 以外の鍵と 2048 ビット未満の RSA 鍵（RFC 7518 §3.3）を使わない。これにより、`alg` の無い静的な RSA 鍵が RS256 の検証に通るようになり（これまでは import に失敗していた）、2048 ビット未満の RSA 鍵と `use: "enc"` の鍵は拒否される。kid は一致するがヘッダーの alg で使える鍵が無いときの `error_description` は `no signing JWK matched the request object header (alg)` になる
