---
"@maronn-openid-connect/cli": minor
"@maronn-openid-connect/experimental": patch
---

`--enable ciba` で OpenID Connect Client-Initiated Backchannel Authentication（CIBA Core 1.0、Poll モード）を生成できるようにする。バックチャネル認証エンドポイント（`POST /backchannel_authentication`）、OP がホストする認証デバイス UI（`GET /ciba` / `POST /ciba/login` / `POST /ciba/approve`）、トークンエンドポイントの `urn:openid:params:grant-type:ciba` grant 分岐、discovery の `backchannel_token_delivery_modes_supported: ["poll"]` と `backchannel_authentication_endpoint` を追加する。experimental には subpath export `@maronn-openid-connect/experimental/ciba`（リクエスト処理・認証デバイス UI のステップ関数・ポーリング状態機械・ストア契約）が加わる。未選択時の生成出力は、conformance.test.ts の default-off 契約テストを除き従来と同一。
