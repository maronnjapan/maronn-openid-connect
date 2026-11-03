---
'@maronn-openid-connect/cli': patch
---

生成される UserInfo エンドポイントが、`Authorization: Bearer` の後ろに空白が 2 つ以上あってもアクセストークンを読む（RFC 6750 §2.1 の `"Bearer" 1*SP b64token`）。これまでは最初の空白より後ろをそのままトークンとしていたため、先頭に空白の残った値で照合し、invalid_token で拒否していた。
