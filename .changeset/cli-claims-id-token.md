---
'@maronn-openid-connect/cli': patch
---

生成する OP は、claims パラメータの `id_token` メンバー（OIDC Core 1.0 §5.5）が要求したクレームを ID Token に入れる

- 対象は、トークンエンドポイントが認可コードの交換で発行する ID Token（`endpoints/token/steps/issue-id-token.ts`、Next.js は `token/route.ts`）と、`implicit-flow` の認可エンドポイントが返す ID Token である。これまでは `claims.id_token` の `acr` だけを使い、ほかのクレームの要求は無視していた
- 入れるのは End-User の標準クレームのうち、End-User が持ち、`value` / `values` に一致するものだけである。scope のクレームの返し方は変わらない（`response_type=id_token` は ID Token、それ以外は UserInfo エンドポイント）
- OpenID Foundation Conformance Suite の Implicit OP のテストプランで、`oidcc-claims-essential`（`response_type=id_token`）が Warning から Passed になる
