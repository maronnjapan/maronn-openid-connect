---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": patch
---

authorization_code グラントの検証結果に `subject` / `authTime` を含め、生成 OP の消費済みコード再取得を削除した

OIDC Core 1.0 §2 は ID Token の `sub` を REQUIRED とし、§3.1.3.3 は authorization_code グラントのトークンレスポンスに ID Token を含めることを求める。これまで core の `ValidatedAuthorizationCodeRequest` は `subject` / `authTime` を運ばず、生成 OP は `consumeAuthorizationCode` の直後に同じ認可コードをストアから読み直して取得していた。この再取得は「消費済み（used=true）レコードを読み直せる」ことへの暗黙の依存であり、ストアを物理削除で実装した利用者は正常なトークン発行まで `invalid_grant` で失敗していた。

## 破壊的変更

- **`AuthorizationCodeInfo` に `subject: string`（必須）と `authTime?: number` を追加した**。独自の `AuthorizationCodeResolver` を実装している場合、`findAuthorizationCode` の戻り値に発行時の `subject`（と、記録していれば `authTime`）を含めること。CLI 生成コードは `createAuthorizationCode` が返す `AuthorizationCodeData`（もともと両フィールドを含む）をそのまま保存しているため、移行作業は不要
- `ValidatedAuthorizationCodeRequest` に `subject: string` / `authTime?: number` を追加した。判別共用体 `ValidatedTokenRequest` の両枝が `subject` を持つため、grant 種別に依らず検証結果から直接取得できる

## 生成コードの変更（cli）

- token ルートから `authCodeStore.get(validatedRequest.code)` による消費済みコードの再取得を削除し、`validatedRequest.subject` / `validatedRequest.authTime` を使うようにした。`used=true` を保持するストア契約の目的は再利用検知 cascade（OAuth 2.1 §4.1.2）だけになり、物理削除するストアでも正常なトークン発行は成立する
- 生成される `conformance.test.ts` に「sub が認証済み End-User と一致する」「auth_time が認可時に記録した値と一致する」「消費済みコードを物理削除するストアでもトークンが発行される」の 3 件を追加した
