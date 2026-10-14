---
'@maronn-openid-connect/cli': minor
---

`generate` / `setup` の `--enable` に experimental 機能 `dynamic-client-registration`（OAuth 2.0 Dynamic Client Registration、RFC 7591）を追加する

有効にすると、生成 OP にクライアント登録エンドポイント `POST /register` が加わり、クライアントは実行時に JSON メタデータを送って `client_id` と（confidential なら）`client_secret` の払い出しを受けられる。発行されたクライアントは、設定済みのクライアント解決（静的 Map、または `--db` のクライアント表・キー）の後に引かれる in-memory ストアに入り、そのまま `/authorize` と `/token` で使える。discovery には有効時のみ `registration_endpoint` を広告する。

- 受理するメタデータは `redirect_uris`（必須。静的クライアントと同じ core の検査規則を適用）、`token_endpoint_auth_method`（`client_secret_basic` / `client_secret_post` / `none`）、`grant_types`（`authorization_code` と `refresh_token` のみ）、`response_types`（`["code"]` のみ）、`client_name` の 5 つで、理解しないメタデータは RFC 7591 §2 のとおり黙って無視する
- 既定はオープン登録（RFC 7591 §3.1 SHOULD）。生成される `dynamicClientRegistrationConfig` の `initialAccessToken` を設定すると `Authorization: Bearer` の提示を要求し、照合は定数時間比較で行う。`maxRegisteredClients`（既定 100）超過は `429`、ボディは UTF-8 で `maxRegistrationBodyBytes`（既定 16384）バイトまで。Hono / Express / Fastify では `applyOidc` のオプション `dynamicClientRegistration` からも上書きできる
- 動的登録クライアントは in-memory ストアにだけ入り、プロセス再起動で消える（PAR / Device / CIBA の experimental ストアと同じ割り切り）。登録後の参照・更新・削除（RFC 7592）は実装しない
- 未指定時の生成物は従来とバイト同一で、install コマンドの案内も変わらない
