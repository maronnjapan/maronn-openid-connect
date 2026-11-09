---
"@maronn-openid-connect/core": minor
"@maronn-openid-connect/cli": minor
"@maronn-openid-connect/experimental": patch
"@maronn-openid-connect/google-login": patch
---

クライアントシークレットをハッシュで登録できるようにし、クライアントごとに要求できる scope を制限できるようにする

クライアントの登録内容に、任意の項目を 2 つ追加する。
どちらも登録しなければ、これまでと同じ挙動になる。

- **core: `TokenClientInfo.clientSecretHash` を追加した**。`hashClientSecret(clientSecret)` の戻り値（`sha256:` に続けて、SHA-256 ダイジェストを base64url で表したもの）を登録すると、`verifyClientSecret()` は提示された client_secret のハッシュを登録値と定数時間で比較する（RFC 6819 §5.1.4.1.3）。`clientSecret` と両方を登録した場合は `clientSecretHash` だけを照合に使う。部品関数として `hashClientSecret()` と `verifyClientSecretHash()` を公開した
- **core: `ClientInfo.allowedScopes` と `validateClientScope()` を追加した**。`validateClientScope(scope, allowedScopes, redirectUri, state)` は、登録された一覧に無い scope を `invalid_scope` で拒否する（RFC 7591 §2 のクライアントメタデータ `scope`）。`allowedScopes` が `undefined` のクライアントは制限しない
- **cli: 生成される認可エンドポイントが `validateClientScope()` を呼ぶ**。`applyOfflineAccessPolicy()` の後に置いているため、許可条件を満たさず無視された `offline_access` は `invalid_scope` にならない。`config.ts` の `RegisteredClient` の説明に 2 つの項目を追記し、契約テストに `clientSecretHash` と `allowedScopes` のケースを追加した

クライアント認証を行う生成コードと experimental のエンドポイントはすべて `verifyClientSecret()` を呼んでいるため、`clientSecretHash` で登録したクライアントはどのエンドポイントでも認証できる。
`allowedScopes` を検査するのは認可エンドポイントだけで、device authorization grant と CIBA のリクエストエンドポイントは検査しない。

experimental と google-login は core の minor リリースに合わせた同時リリースのみで、機能変更はない。
