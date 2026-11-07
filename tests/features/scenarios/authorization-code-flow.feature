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
