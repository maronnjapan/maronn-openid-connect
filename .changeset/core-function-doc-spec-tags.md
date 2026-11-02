---
'@maronn-openid-connect/core': patch
---

関数の JSDoc を関数カタログ（`maronn-oidc explain`）が読む形に揃える。1 行目からパイプラインの番号（「ステップ 3:」）を外し、仕様だけの行を `@spec` タグに移す。`buildIdTokenAudience` に JSDoc を書く。挙動は変わらない
