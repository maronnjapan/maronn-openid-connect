---
'@maronn-openid-connect/core': patch
---

関数の JSDoc と関数の中のコメント、resolver と store のインターフェースのメンバーの JSDoc を、振る舞いから書く日本語に書き直す。1 段落目は関数が何を返し、何を書き込み、いつ失敗するかを 1 文で書き、条件と理由は 2 段落目以降に、仕様の参照は `@spec` に置く。元の説明がコードと食い違っていた箇所（`validateIdTokenHint` の鍵の選び方、`parseRequestObject` が試す鍵、`applyRequestedIdTokenClaims` が渡されたペイロードをそのまま返す場合など）はコードに合わせた。挙動は変わらない
