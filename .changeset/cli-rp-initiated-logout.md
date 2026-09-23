---
"@maronn-openid-connect/cli": minor
"@maronn-openid-connect/experimental": patch
---

`--enable rp-initiated-logout` で OpenID Connect RP-Initiated Logout 1.0 の end_session_endpoint を生成できるようにする。生成 OP に `GET|POST /logout` と確認画面の承認先 `POST /logout/approve` が追加され、discovery が `end_session_endpoint` を公表する。有効な `id_token_hint` が現在のセッションの End-User を指す場合は即時ログアウトし、それ以外は確認画面を挟む（RP-Initiated Logout 1.0 §2）。リダイレクトは `rpInitiatedLogoutConfig.postLogoutRedirectUris` に登録した URI との完全一致時のみ行い、`state` をそのまま返す（§3）。experimental には subpath export `@maronn-openid-connect/experimental/rp-initiated-logout`（end_session リクエストの正規化・ヒント audience 抽出・ログアウト分岐判定・リダイレクト解決の純関数群）が加わる。未指定時の生成コードは変更されない。
