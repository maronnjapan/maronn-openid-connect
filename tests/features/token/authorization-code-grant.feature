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

  @id:token-authorization-code-without-openid @spec:OIDC-Core-3.1.2.2 @spec:RFC6749-4.1.4 @hono @nextjs
  Scenario: Exchange a code without the openid scope for an access token without an ID Token
    ja: openid スコープのない認可コードを、ID トークンのないアクセストークンと交換する
    Given the client "client-1" has the authorization code "code-oauth":
      | scope        | code_verifier                                  |
      | reports.read | verifier-0123456789-abcdefghijklmnopqrstuvwxyz |
    When the client "client-1" redeems the authorization code "code-oauth"
    Then the HTTP status is 200
    And the body has token_type "Bearer"
    And the body has scope "reports.read"
    And the body has an access_token
    And the body has no id_token

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
