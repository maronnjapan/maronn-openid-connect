---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
"@maronn-openid-connect/experimental": patch
"@maronn-openid-connect/google-login": patch
---

後方互換のために残していた実装を削除する

core はステップ関数を導入したとき、既存の呼び出し元を壊さないよう、ステップ関数を順に呼ぶだけの合成関数を「後方互換の合成 API」として残していた。
CLI 生成コードはステップ関数の導入と同時に各ステップを直接呼び出す形へ移っており、合成関数を必要としていたのは導入前からの呼び出し元だけである。
一般展開を予定していないため、合成関数とそのほかの互換用の分岐を削除する。

## 破壊的変更

- **core: 合成関数を削除した**。`validateAuthorizationRequest` / `validateTokenRequest` / `validateAuthorizationCodeGrant` / `validateRefreshTokenGrant` / `authenticateClient` / `checkPromptNone` / `generateTokenResponse` / `handleUserInfoRequest` / `handleIntrospectionRequest` / `handleRevocationRequest` と、それらだけが使っていた型（`ValidateAuthorizationRequestOptions` / `TokenRequestContext` / `PromptNoneOptions` / `TokenResponseOptions` / `TokenResponse` / `GenerateTokenResponseResult` / `UserInfoRequestContext` / `IntrospectionRequestContext` / `RevocationRequestContext`）を削除した。`ClientAuthContext` からは `clientResolver` を外した。代わりに各ステップ関数を CLI 生成コードと同じ順に呼び出す
- **core: `createAuthTransaction()` の第 3 引数はオプションオブジェクト（`{ ttlMs?, bindingHash? }`）だけを受け取る**。TTL を数値で渡すシグネチャを削除した
- **core: `validateTransactionBinding()` は `bindingHash` を持たないトランザクションを `invalid_transaction_binding` で拒否する**。束縛の導入前に発行されたトランザクションを検証せずに通す分岐を削除した
- **cli: 生成コードの `ProviderConfig.authorizationErrorRedirectPath` を削除した**。以前の Next.js 出力が自前のエラー画面へ 303 するために使っていたフックで、現在の生成物はどれも使っていない。非リダイレクトの認可エラーの見せ方は `pages/errors.ts` の `renderAuthorizationErrorPage()` で変える
- **cli: Hono の再生成時に、以前の CLI が出力した `.ts` の画面ファイルを一覧して警告する処理を削除した**
- **experimental: `validatePushedAuthorizationParams()` は core のステップ関数を直接呼び、戻り値は `void` になった**。オプションの型は `PushedAuthorizationValidationOptions`（`allowNonPkceAuthorizationCodeFlow` / `maxClaimsParameterLength`）で、`PushedAuthorizationRequestContext.validationOptions` もこの型になる。PAR は Request Object と併用しないため、`request` パラメータはパースせず `invalid_request` で拒否する

google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
