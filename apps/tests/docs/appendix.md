# 付録 機能ファイルと訳の表

[全体像](README.md) ｜ ← [① テストを読む](01-read.md)

機能ファイルと訳の表の全文である。
どちらも、道具の出力を決める中身である。

| 中身 | 決める出力 | 節 |
|---|---|---|
| 機能ファイル | カードの題、`ja`、`path`、ステップ、リクエスト、対象、観点、id | [①-7](01-read.md#-7-機能ファイルのシナリオ) |
| 訳の表 | ステップと期待結果の `ja`、`tests.json` の `untranslated`、訳の表の lint | [①-8-d](01-read.md#-8-d-訳の表) |

## A 機能ファイル

`tests/features/` の四つのファイルである。
`@http` のシナリオは、OP の開発用のユーザー（`testuser`、パスワード `password`）でログインする。
このユーザーはアプリが持つもので、道具は作らない。

### A-1 token/client-authentication.feature

```gherkin
@endpoint:token
Feature: Client authentication at the token endpoint
  ja: トークンエンドポイントのクライアント認証

  Background:
    Given a registered confidential client:
      | client_id | client_secret         | redirect_uri                    |
      | client-1  | client-1-secret-value | https://rp.example.com/callback |
    And the client "client-1" has the authorization code "code-1"

  @id:token-invalid-client-secret @spec:RFC6749-5.2 @spec:OAuth2.1-2.3 @spec:RFC6750-3 @auth @hono @nextjs
  Scenario: Reject invalid client credentials with invalid_client
    ja: 無効なクライアント認証情報を invalid_client で拒否する
    Given the client "client-1" presents invalid credentials
    When the client "client-1" requests the token endpoint with grant_type "authorization_code":
      | code   | redirect_uri                    |
      | code-1 | https://rp.example.com/callback |
    Then the HTTP status is 401
    And the error code is "invalid_client"
    And the error description is "Client authentication failed"
    And the "WWW-Authenticate" header starts with "Basic"
    And the authorization code "code-1" is not consumed
```

### A-2 token/authorization-code-grant.feature

```gherkin
@endpoint:token
Feature: The authorization_code grant at the token endpoint
  ja: トークンエンドポイントの authorization_code グラント

  Background:
    Given a registered confidential client:
      | client_id | client_secret         | redirect_uri                    |
      | client-1  | client-1-secret-value | https://rp.example.com/callback |
    And the client "client-1" has the authorization code "code-1":
      | scope                 | code_verifier                                  |
      | openid offline_access | verifier-0123456789-abcdefghijklmnopqrstuvwxyz |

  @id:token-authorization-code-success @spec:OIDC-Core-3.1.3.3 @spec:RFC6749-5.1 @hono @nextjs
  Scenario: Exchange the code for an access token, an ID Token and a refresh token
    ja: 認可コードをアクセストークン、ID トークン、リフレッシュトークンと交換する
    When the client "client-1" redeems the authorization code "code-1"
    Then the HTTP status is 200
    And the "Cache-Control" header is "no-store"
    And the "Pragma" header is "no-cache"
    And the body has token_type "Bearer"
    And the body has expires_in 3600
    And the body has scope "openid offline_access"
    And the body has an access_token
    And the body has an id_token
    And the body has a refresh_token

  @id:token-missing-required-parameter @spec:RFC6749-4.1.3 @spec:OIDC-Core-3.1.3.2 @hono @nextjs
  Scenario Outline: Reject a request without <parameter> with <error>
    ja: <parameter> のないリクエストを <error> で拒否する
    When the client "client-1" redeems the authorization code "code-1" without <parameter>
    Then the HTTP status is 400
    And the error code is "<error>"
    And the error description is "<description>"
    And the authorization code "code-1" is not consumed

    Examples:
      | parameter    | error           | description                                                                   |
      | code         | invalid_request | Missing required parameter: code                                              |
      | redirect_uri | invalid_grant   | redirect_uri is required because it was included in the authorization request |

  @id:token-unknown-authorization-code @spec:RFC6749-5.2 @hono @nextjs
  Scenario: Reject an authorization code the provider did not issue with invalid_grant
    ja: 発行していない認可コードを invalid_grant で拒否する
    When the client "client-1" redeems the authorization code "code-unknown"
    Then the HTTP status is 400
    And the error code is "invalid_grant"
    And the error description is "Authorization code not found"

  @id:token-replayed-authorization-code @spec:OAuth2.1-4.1.2 @security @hono @nextjs
  Scenario: Reject a replayed code with invalid_grant and revoke the tokens issued from it
    ja: 再提示された認可コードを invalid_grant で拒否し、そのコードから発行したトークンを失効させる
    Given the client "client-1" has redeemed the authorization code "code-1"
    When the client "client-1" redeems the authorization code "code-1"
    Then the HTTP status is 400
    And the error code is "invalid_grant"
    And the error description is "Authorization code has already been used"
    And the tokens issued from the authorization code "code-1" are revoked
```

### A-3 token/grant-type.feature

```gherkin
@endpoint:token
Feature: The grant types of the token endpoint
  ja: トークンエンドポイントのグラントタイプ

  Background:
    Given a registered confidential client:
      | client_id | client_secret         | redirect_uri                    |
      | client-1  | client-1-secret-value | https://rp.example.com/callback |

  @id:token-unsupported-grant-type @spec:RFC6749-5.2 @hono @nextjs
  Scenario: Reject a grant_type the provider does not offer with unsupported_grant_type
    ja: OP が扱わない grant_type を unsupported_grant_type で拒否する
    When the client "client-1" requests the token endpoint with grant_type "password"
    Then the HTTP status is 400
    And the error code is "unsupported_grant_type"
```

### A-4 scenarios/authorization-code-flow.feature

```gherkin
@scenario:authorization-code-flow
Feature: Authorization code flow
  ja: 認可コードフロー

  @id:auth-code-flow-online-refresh @spec:OIDC-Core-11 @spec:RFC6749-4.1 @http
  Scenario: Return a refresh token bound to the login session without offline_access
    ja: offline_access がなくても、ログインセッションに束縛されたリフレッシュトークンを返す
    Given the user "testuser" can log in with the password "password"
    When the client "e2e-features-client" sends an authorization request with scope "openid profile"
    And the user logs in on the login page
    And the user approves on the consent page
    And the client redeems the authorization code for tokens
    Then the HTTP status is 200
    And the "Cache-Control" header is "no-store"
    And the body has token_type "Bearer"
    And the body has scope "openid profile"
    And the body has a refresh_token
    And the length of refresh_token is 43
```

## B 訳の表

`tests/steps/ja.yaml` の全文である。
値はすべて単一引用符の文字列で、`#` の行はコメントである。

```yaml
# The Japanese of every step expression of tests/steps: the expression as the
# step definition writes it, and a template whose {0}, {1}, ... are the holes of
# the expression in the order they appear in it, each used once.

# common/response.steps.ts
'the HTTP status is {int}': 'HTTP ステータスが {0} である'
'the error code is {string}': 'エラーコードが {0} である'
'the error description is {string}': 'エラーの説明が {0} である'
'the {string} header is {string}': '{0} ヘッダーが {1} である'
'the {string} header starts with {string}': '{0} ヘッダーが {1} で始まる'
'the body has {word} {string}': 'ボディの {0} が {1} である'
'the body has {word} {int}': 'ボディの {0} が {1} である'
'the body has a(n) {word}': 'ボディに {0} がある'
'the length of {word} is {int}': '{0} の長さが {1} である'

# in-process/token.steps.ts
'a registered confidential client:': '登録済みのコンフィデンシャルクライアント:'
'the client {string} has the authorization code {string}': 'クライアント {0} の認可コード {1} が保存されている'
'the client {string} has the authorization code {string}:': 'クライアント {0} の認可コード {1} が次の内容で保存されている:'
'the client {string} presents invalid credentials': 'クライアント {0} が無効な認証情報を提示する'
'the client {string} has redeemed the authorization code {string}': 'クライアント {0} が認可コード {1} を引き換え済みである'
'the client {string} requests the token endpoint with grant_type {string}': 'クライアント {0} がトークンエンドポイントに grant_type {1} でリクエストする'
'the client {string} requests the token endpoint with grant_type {string}:': 'クライアント {0} がトークンエンドポイントに grant_type {1} でリクエストする:'
'the client {string} redeems the authorization code {string}': 'クライアント {0} が認可コード {1} を引き換える'
'the client {string} redeems the authorization code {string} without {word}': 'クライアント {0} が {2} なしで認可コード {1} を引き換える'
'the authorization code {string} is not consumed': '認可コード {0} が使用済みになっていない'
'the tokens issued from the authorization code {string} are revoked': '認可コード {0} から発行したトークンが失効している'

# http/authorization-code-flow.steps.ts
'the user {string} can log in with the password {string}': 'ユーザー {0} がパスワード {1} でログインできる'
'the client {string} sends an authorization request with scope {string}': 'クライアント {0} がスコープ {1} で認可リクエストを送る'
'the user logs in on the login page': 'ユーザーがログイン画面でログインする'
'the user approves on the consent page': 'ユーザーが同意画面で承認する'
'the client redeems the authorization code for tokens': 'クライアントが認可コードをトークンと引き換える'

# テストコードの期待結果の言い回し（packages/test-catalog の words.ts が expect(...) から作る）。
# {code} は確かめる値のコード、{value} は期待する値で、どちらも訳さずにそのまま入る。
'does not fail': '失敗しない'
'fails': '失敗する'
'fails with {string}': '{0} で失敗する'
'fails with {value}': '{0} で失敗する'
'the HTTP status is not {int}': 'HTTP ステータスが {0} ではない'
'the URL ends with {string}': 'URL が {0} で終わる'
'the URL does not end with {string}': 'URL が {0} で終わらない'
'the URL is {value}': 'URL が {0} である'
'the URL is not {value}': 'URL が {0} ではない'
'the URL matches {value}': 'URL が {0} に一致する'
'the URL does not match {value}': 'URL が {0} に一致しない'
'the error code is not {string}': 'エラーコードが {0} ではない'
'the length of {code} is {int}': '{0} の長さが {1} である'
'the length of {code} is not {int}': '{0} の長さが {1} ではない'
'the {string} header is not {string}': '{0} ヘッダーが {1} ではない'
'the {string} header contains {string}': '{0} ヘッダーが {1} を含む'
'the {string} header does not contain {string}': '{0} ヘッダーが {1} を含まない'
'the {string} header matches {string}': '{0} ヘッダーが {1} に一致する'
'the {string} header does not match {string}': '{0} ヘッダーが {1} に一致しない'
'there is a {string} header': '{0} ヘッダーがある'
'there is no {string} header': '{0} ヘッダーが無い'
'{code} is {value}': '{0} が {1} である'
'{code} is not {value}': '{0} が {1} ではない'
'{code} equals {value}': '{0} が {1} と等しい'
'{code} does not equal {value}': '{0} が {1} と等しくない'
'{code} has {value}': '{0} が {1} を持つ'
'{code} does not have {value}': '{0} が {1} を持たない'
'{code} is undefined': '{0} が undefined である'
'{code} is not undefined': '{0} が undefined ではない'
'{code} is null': '{0} が null である'
'{code} is not null': '{0} が null ではない'
'{code} is defined': '{0} が定義されている'
'{code} is not defined': '{0} が定義されていない'
'{code} is truthy': '{0} が真とみなされる値である'
'{code} is not truthy': '{0} が真とみなされる値ではない'
'{code} is falsy': '{0} が偽とみなされる値である'
'{code} is not falsy': '{0} が偽とみなされる値ではない'
'{code} is a {value}': '{0} が {1} のインスタンスである'
'{code} is not a {value}': '{0} が {1} のインスタンスではない'
'{code} contains {value}': '{0} が {1} を含む'
'{code} does not contain {value}': '{0} が {1} を含まない'
'{code} matches {value}': '{0} が {1} に一致する'
'{code} does not match {value}': '{0} が {1} に一致しない'
'{code} has the property {value}': '{0} がプロパティ {1} を持つ'
'{code} does not have the property {value}': '{0} がプロパティ {1} を持たない'
'{code} was called': '{0} が呼ばれた'
'{code} was not called': '{0} が呼ばれていない'
'{code} was called {int} times': '{0} が {1} 回呼ばれた'
'{code} was called with {value}': '{0} が {1} で呼ばれた'
'{code} was not called with {value}': '{0} が {1} で呼ばれていない'
'{code} is greater than {value}': '{0} が {1} より大きい'
'{code} is not greater than {value}': '{0} が {1} より大きくない'
'{code} is at least {value}': '{0} が {1} 以上である'
'{code} is not at least {value}': '{0} が {1} 以上ではない'
'{code} is less than {value}': '{0} が {1} より小さい'
'{code} is not less than {value}': '{0} が {1} より小さくない'
'{code} is at most {value}': '{0} が {1} 以下である'
'{code} is not at most {value}': '{0} が {1} 以下ではない'
'{code} has the text {value}': '{0} のテキストが {1} である'
'{code} does not have the text {value}': '{0} のテキストが {1} ではない'
'{code} is visible': '{0} が表示されている'
'{code} is not visible': '{0} が表示されていない'
'{code} has {int} elements': '{0} の要素が {1} 個ある'
'{code} does not have {int} elements': '{0} の要素が {1} 個ではない'
'{code} has the value {value}': '{0} の値が {1} である'
'{code} does not have the value {value}': '{0} の値が {1} ではない'
'{code} resolves to {value}': '{0} が {1} に解決される'
'{code} does not resolve to {value}': '{0} が {1} に解決されない'
'{code} resolves to a value with {value}': '{0} が {1} を持つ値に解決される'
'{code} resolves to a value without {value}': '{0} が {1} を持たない値に解決される'
'{code} resolves to undefined': '{0} が undefined に解決される'
'{code} does not resolve to undefined': '{0} が undefined に解決されない'
'{code} resolves to null': '{0} が null に解決される'
'{code} does not resolve to null': '{0} が null に解決されない'
'{code} resolves to a value': '{0} が値に解決される'
'{code} does not resolve to a value': '{0} が値に解決されない'
'{code} resolves to a truthy value': '{0} が真とみなされる値に解決される'
'{code} does not resolve to a truthy value': '{0} が真とみなされる値に解決されない'
'{code} resolves to a falsy value': '{0} が偽とみなされる値に解決される'
'{code} does not resolve to a falsy value': '{0} が偽とみなされる値に解決されない'
```

[全体像](README.md) ｜ ← [① テストを読む](01-read.md)
