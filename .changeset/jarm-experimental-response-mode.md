---
"@maronn-openid-connect/experimental": patch
---

JWT Secured Authorization Response Mode (JARM) を `@maronn-openid-connect/experimental/jarm` として追加しました。

- `resolveJarmResponseMode`: 認可リクエストの `response_mode` を `jarm`（`query.jwt` / 省略形 `jwt`）/ `plain`（未指定・`query`・`.jwt` 系以外）/ `unsupported-jwt-mode`（`fragment.jwt` / `form_post.jwt` など）の判別共用体へ分類します
- `createJarmResponseJwt`: 認可レスポンスパラメータを JARM §2.1 のクレーム構造（`iss` / `aud` / `exp` ＋ `code` / `state` または `error` 系）で RS256 署名付き JWT にします。値が `undefined` のパラメータはクレームに含めず、`iss` / `aud` / `exp` はパラメータから上書きできません
- `buildJarmRedirectUrl`: `redirect_uri` に `response` パラメータのみを付けた URL を返します（JARM §2.3.1）
- `assertJarmLifetimeSeconds`: 応答 JWT の寿命を 5〜600 秒（JARM §2.1 の最大 10 分 RECOMMENDED 内）に制限します
- `JarmAuthTransactionFields`: auth transaction に JARM モードを相乗りさせる交差型です

JWS 生成は Web Crypto API による自前実装で、`@maronn-openid-connect/core` の公開 API（`SigningKey` 型）にのみ依存します。他の Experimental 機能とはコードを共有していません。

**Experimental であり、API はマイナーリリースでも破壊的に変更されることがあります。** `fragment.jwt` / `form_post.jwt`、応答 JWT の暗号化（JWE）、クライアント別 `authorization_signed_response_alg` は非対応です。
