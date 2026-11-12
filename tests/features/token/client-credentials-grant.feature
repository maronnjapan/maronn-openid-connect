@endpoint:token
Feature: The client_credentials grant at the token endpoint
  ja: トークンエンドポイントの client_credentials グラント

  Background:
    Given a registered confidential client:
      | client_id | client_secret          | redirect_uri                         | grant_types        | scope                      |
      | service-1 | service-1-secret-value | https://service.example.com/callback | client_credentials | reports.read reports.write |
    And a registered confidential client:
      | client_id | client_secret         | redirect_uri                    |
      | client-1  | client-1-secret-value | https://rp.example.com/callback |

  @id:token-client-credentials-success @spec:RFC6749-4.4.3 @spec:RFC6749-5.1 @hono @nextjs
  Scenario: Issue an access token for the client itself without a refresh token or an ID Token
    ja: クライアント自身のアクセストークンを、リフレッシュトークンと ID トークンなしで発行する
    When the client "service-1" requests the token endpoint with grant_type "client_credentials":
      | scope        |
      | reports.read |
    Then the HTTP status is 200
    And the "Cache-Control" header is "no-store"
    And the "Pragma" header is "no-cache"
    And the body has token_type "Bearer"
    And the body has expires_in 3600
    And the body has scope "reports.read"
    And the body has an access_token
    And the body has no refresh_token
    And the body has no id_token

  @id:token-client-credentials-default-scope @spec:RFC6749-3.3 @spec:RFC7591-2 @hono @nextjs
  Scenario: Issue every scope the client registered when the request names none
    ja: リクエストがスコープを指定しないとき、クライアントが登録したスコープをすべて発行する
    When the client "service-1" requests the token endpoint with grant_type "client_credentials"
    Then the HTTP status is 200
    And the body has scope "reports.read reports.write"

  @id:token-client-credentials-unregistered-scope @spec:RFC7591-2 @spec:RFC6749-5.2 @authorization @hono @nextjs
  Scenario: Reject a scope the client did not register with invalid_scope
    ja: クライアントが登録していないスコープを invalid_scope で拒否する
    When the client "service-1" requests the token endpoint with grant_type "client_credentials":
      | scope              |
      | reports.read admin |
    Then the HTTP status is 400
    And the error code is "invalid_scope"
    And the error description is "Client is not registered for scope: admin"

  @id:token-client-credentials-openid-scope @spec:OIDC-Core-3.1.2.1 @spec:RFC6749-5.2 @security @hono @nextjs
  Scenario: Reject the openid scope, which stands for an End-User, with invalid_scope
    ja: エンドユーザーを表す openid スコープを invalid_scope で拒否する
    When the client "service-1" requests the token endpoint with grant_type "client_credentials":
      | scope  |
      | openid |
    Then the HTTP status is 400
    And the error code is "invalid_scope"
    And the error description is "Scope is not available for the client_credentials grant: openid"

  @id:token-client-credentials-unregistered-grant @spec:RFC6749-5.2 @spec:RFC7591-2 @authorization @hono @nextjs
  Scenario: Reject a client that did not register the grant with unauthorized_client
    ja: グラントを登録していないクライアントを unauthorized_client で拒否する
    When the client "client-1" requests the token endpoint with grant_type "client_credentials"
    Then the HTTP status is 400
    And the "Cache-Control" header is "no-store"
    And the error code is "unauthorized_client"
    And the error description is "Client is not authorized to use grant_type: client_credentials"

  @id:token-client-credentials-invalid-client @spec:RFC6749-5.2 @spec:RFC6750-3 @auth @hono @nextjs
  Scenario: Reject invalid client credentials before answering the grant with invalid_client
    ja: グラントに応答する前に、無効なクライアント認証情報を invalid_client で拒否する
    Given the client "service-1" presents invalid credentials
    When the client "service-1" requests the token endpoint with grant_type "client_credentials"
    Then the HTTP status is 401
    And the error code is "invalid_client"
    And the "WWW-Authenticate" header starts with "Basic"

  @id:token-client-credentials-audience-not-allowed @spec:RFC8707-2 @authorization @hono @nextjs
  Scenario: Reject an audience the provider does not allow with invalid_target
    ja: OP が許可していないオーディエンスを invalid_target で拒否する
    When the client "service-1" requests the token endpoint with grant_type "client_credentials":
      | audience                |
      | https://api.example.com |
    Then the HTTP status is 400
    And the error code is "invalid_target"
    And the error description is "Requested audience is not allowed: https://api.example.com"
