---
'@maronn-openid-connect/core': minor
---

`claims` リクエストパラメータ（OIDC Core 1.0 §5.5）で読み出せるクレーム名をアロウリストに限定する。`applyRequestedClaims`（UserInfo）と `applyRequestedIdTokenClaims`（ID Token）は、これまで `claims` のキー名を `UserClaimsResolver.findUserClaims()` が返したオブジェクトのプロパティ名として無検査で読み出していたため、DB の行をそのまま返す resolver 実装では `claims={"userinfo":{"password_hash":null}}` のようなリクエストで内部フィールドが scope と無関係に開示された。両関数は新設の `DEFAULT_REQUESTABLE_CLAIMS`（`sub` ＋ `SCOPE_CLAIMS_MAP` の全クレーム名。export 済み）を既定のアロウリストとして own プロパティだけを読み出し、アロウリスト外の要求は §5.5.1 の MUST NOT のとおりエラーにせず黙って省く。アロウリストは新しい第 4 引数で差し替えられる。既定値のままなら標準クレームの挙動は変わらない。
