---
"@maronn-openid-connect/cli": patch
---

`--enable device-authorization-grant` で生成した OP が、デバイスコードグラントの ID Token をクライアント登録の `id_token_signed_response_alg` に従って署名するよう修正しました（OIDC Dynamic Client Registration 1.0 §4.2）。

## 何が起きていたか

`routes/token.ts` の `grant_type=urn:ietf:params:oauth:grant-type:device_code` 分岐は、ID Token の署名鍵として登録鍵セットから alg を選ばず、汎用の **ACTIVE** な ID Token 鍵（`idTokenPrivateKey`）をそのまま使っていました。

同じ生成 OP でも authorization_code / refresh_token グラントは登録鍵セットから `selectSigningKeyByAlg()` でクライアントの登録 alg に合う鍵を選ぶため、`idTokenSignedResponseAlg: 'ES256'` を登録したクライアントに対して、

- authorization_code グラント → ES256 で署名された ID Token
- device_code グラント → ACTIVE 鍵（既定 RS256）で署名された ID Token

という不整合が生じていました。クライアントは登録 alg で検証するため、デバイスフローで受け取った ID Token を拒否します。あわせて `at_hash` も誤ったハッシュ関数（alg 由来）で計算されていました（OIDC Core 1.0 §3.1.3.6）。

## 修正内容

デバイスコードグラント分岐に、標準グラントと同じ鍵選択を入れました。

- 登録済み ID Token 鍵セットがある場合はクライアントの `idTokenSignedResponseAlg`（未指定は OIDC 既定の `RS256`）に合う鍵を選ぶ
- 合う鍵が無い場合はサーバー設定エラーとして `server_error` (500) を返す（`Cache-Control: no-store` 付き）
- 鍵セットが空の場合は従来どおり単一鍵コンテキストへフォールバックする

`conformance.test.ts` には、RS256 を ACTIVE にしたまま RS256 + ES256 の鍵セットを登録した OP に対してデバイスフローを実行し、`id_token_signed_response_alg: ES256` のクライアントが ES256 署名の ID Token を受け取ることを固定する契約テストを追加しています。

## 移行上の注意

- `id_token_signed_response_alg` を登録していないクライアント（＝既定 RS256）だけを使っている場合、生成される ID Token に変化はありません
- 生成コードを再生成すると `routes/token.ts` と `conformance.test.ts` が更新されます
