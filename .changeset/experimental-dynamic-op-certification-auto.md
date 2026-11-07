---
---

dynamic-client-registration と PAR を、private_key_jwt のクライアント認証（OIDC Core 1.0 §9）、`request_uri`（OIDC Core 1.0 §6.2）、ログイン画面と同意画面のクライアントの表示に合わせる（`packages/experimental` 側）。

- **破壊的変更**（dynamic-client-registration）: `validateClientMetadata()` は `token_endpoint_auth_signing_alg`（OIDC Dynamic Client Registration 1.0 §2）を、OP が受け付ける alg（オプション `tokenEndpointAuthSigningAlgValuesSupported`。省略時は core の `SUPPORTED_CLIENT_ASSERTION_SIGNING_ALGS` の RS256、RS384、RS512、ES256、ES384、ES512。`none` は渡しても受け付けない）に照らして検証し、登録して応答に返す。一覧に無い alg は `invalid_client_metadata` で拒否する。一覧は `token_endpoint_auth_method` によらず使うので、client_secret_jwt を許す OP は HS256 などの HMAC の alg も渡す。`jwks` も登録するときは、その alg で使える鍵を要求する
- **破壊的変更**（dynamic-client-registration）: `token_endpoint_auth_method` が `private_key_jwt` の登録は `jwks` か `jwks_uri` を要し、どちらも無い登録は `invalid_client_metadata`（`private_key_jwt requires jwks or jwks_uri`）で拒否する
- dynamic-client-registration: オプション `acceptRequestUris`（既定 `false`）の OP は、`request_uris` を検証して登録する（1 〜 32 件の https の絶対 URL。フラグメントを含んでよい。`allowInsecureRequestUris` で http も許す）。ほかの OP では理解しないメタデータとして無視する（RFC 7591 §2）
- dynamic-client-registration: 検証した `client_name`、`client_uri`、`logo_uri`、`policy_uri`、`tos_uri`、`token_endpoint_auth_signing_alg`、`request_uris` を `ValidatedClientRegistration` に入れ、`buildRegisteredClient()` が `DynamicallyRegisteredClient` の `clientName`、`clientUri`、`logoUri`、`policyUri`、`tosUri`、`tokenEndpointAuthSigningAlg`、`requestUris` に写す
- **破壊的変更**（PAR）: `authenticateParClient()` を消した。`handlePushedAuthorizationRequest()` は資格情報の検証を必須の `verifyClientCredential(client, presented)` で受け取り、投げた core の `TokenError` を `toParError()` で `ParError` にする（`invalid_client` なら 401）。シークレットだけを受け付ける OP は `(client, presented) => verifyClientSecret(client, presented.clientSecret)` を、private_key_jwt も受け付ける OP はクライアントアサーションの検証（core の `decodeClientAssertion()` から `consumeClientAssertionJti()` まで）を渡す。`PushedAuthorizationRequestContext` の `authorizationHeader` は必須の文字列（ヘッダーが無ければ空文字）
- PAR: `resolveParClient()` と `toParError()` を公開する。`resolveParClient()` は資格情報の取り出し、クライアントの解決、方式の照合までを行い、クライアントと提示された資格情報（`presented`）を返す。資格情報は検証しない。`authorizationHeader` は必須の文字列（ヘッダーが無ければ空文字）

experimental の publish は RELEASE.md の「experimental の自動 publish」どおり、main への push 後に CI が patch の changeset を自動生成して行うため、この PR では bump を書かない。
