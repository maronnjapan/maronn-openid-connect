---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

Request Object by reference（`request_uri`。OpenID Connect Core 1.0 §6.2）と、クライアント登録メタデータ `request_uris` / `request_object_signing_alg`（OpenID Connect Dynamic Client Registration 1.0 §2）を解釈できるようにする

- `validateRequestUri` を追加する。`request_uri` の値が https の絶対 URL（ループバックホストの http は開発用に許す）で、512 文字以内の表示可能 ASCII で、資格情報を含まないことを検査し、`requireRegistration`（既定 true）のときは `registeredRequestUris` とフラグメントを含めて完全一致することを要する。失敗は `RequestUriError`
- `fetchRequestObjectByReference` を追加する。`request_uri` に GET を送って Request Object（compact JWS の文字列）を取得する（§6.2.3）。フラグメントは送らず、リダイレクトには従わず、200 以外の応答、上限（既定 16384 バイト。`DEFAULT_REQUEST_OBJECT_MAX_BYTES`）を超える内容、空の内容、ネットワークエラー、タイムアウト（既定 5000 ミリ秒。`DEFAULT_REQUEST_URI_FETCH_TIMEOUT_MS`）を `RequestUriError` にする。`fetch` は差し替えられる
- `resolveRequestObjectParams` に `requestUri` オプションを足す。渡すと `request_uri` を上の 2 つで検査・取得し、取得した JWT を by value と同じ規則で検証して有効パラメータに重ねる。検査と取得の失敗は非リダイレクトの `invalid_request_uri`（§3.1.2.6）、`request` と `request_uri` の併用は非リダイレクトの `invalid_request`。渡さない構成ではこれまでどおり `request_uri` を扱わない
- `resolveRequestObjectParams` に `requiredSigningAlg` オプションを足す。クライアントが登録した `request_object_signing_alg` を渡すと、その alg で署名された Request Object だけを受理する（`none` なら署名無しだけ）
- `rejectUnsupportedRequestParams` に `requestUriParameterSupported` オプションを足す。true のとき `request_uri` を `request_uri_not_supported` で拒否しない（既定 false）
- `ClientInfo` に `requestUris`（登録した `request_uris`）と `requestObjectSigningAlg` を足す
- `buildProviderMetadata` に `requireRequestUriRegistration` を足し、discovery の `require_request_uri_registration` を出す

experimental の dynamic-client-registration は、`request_uris`（1 〜 32 件。core の `validateRequestUri` と同じ規則で検査し、登録時には取得しない）と `request_object_signing_alg`（`requestObjectSigningAlgValuesSupported` オプションの alg のみ。既定は RS256）を受理して `DynamicallyRegisteredClient` に持つ。google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
