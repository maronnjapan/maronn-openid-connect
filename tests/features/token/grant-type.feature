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
