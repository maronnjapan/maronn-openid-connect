---
'@maronn-openid-connect/core': minor
'@maronn-openid-connect/experimental': patch
'@maronn-openid-connect/google-login': patch
---

claims パラメータの `id_token` メンバー（OIDC Core 1.0 §5.5）が要求したクレームを、ID Token に入れるための関数を追加する

- `selectRequestedIdTokenClaims()` は、`claims.id_token` が個別に要求した End-User の標準クレームを選ぶ。End-User が持たないクレームと、`value` / `values` に一致しないクレームは選ばない（§5.5.1）。`sub` と ID Token 自体のクレーム（`acr`、`auth_time` など）も選ばない
- `hasRequestedIdTokenClaims()` は、`claims.id_token` が End-User の標準クレームを要求しているかを返す。false なら、ID Token のために End-User のクレームを読まなくてよい
- `buildIdTokenPayload()` の入力に `requestedClaims` を追加した。scope のクレーム（`userClaims`）に加えて ID Token に入れる。必須クレームより先に入れるので、要求で必須クレームを上書きすることはできない

experimental と google-login は、core の minor リリースに合わせた同時リリースのみで、機能変更はない。
