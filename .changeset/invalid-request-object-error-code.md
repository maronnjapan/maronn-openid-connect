---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": patch
---

Request Object の検証失敗を `invalid_request_object`（OIDC Core 1.0 §6.3）で返す

これまで `request` パラメータの Request Object がパース・署名検証に失敗すると、汎用の `invalid_request` に潰して返していた。OIDC Core 1.0 §6.3 が定義するとおり `invalid_request_object` を返すよう変更し、`request_not_supported`（Request Object の使用をやめるべき）と `invalid_request_object`（Request Object の生成処理を直すべき）をクライアントが区別できるようにした。

- `AuthorizationErrorCode` に `InvalidRequestObject`（`invalid_request_object`）と `InvalidRequestUri`（`invalid_request_uri`）を追加した。既存の enum メンバーとシリアライズ値は変えていない
- `resolveRequestObjectParams` が `RequestObjectError` を `invalid_request_object` へ変換するようになった。壊れた Request Object 内の redirect_uri を信用しない非リダイレクト挙動（OP 上でのエラー表示、state 非 echo）は従来どおり
- CLI 生成の `conformance.test.ts` に、壊れた Request Object が非リダイレクトの `invalid_request_object` エラーページになる契約テストを追加した

`invalid_request` の受信を前提にしていたクライアントは、Request Object 起因の失敗で `invalid_request_object` を受け取るようになる。
