---
'@maronn-openid-connect/google-login': patch
---

関数の JSDoc と関数の中のコメント、`GoogleAccountResolver` と `GoogleLoginNonceStore` のメンバーの JSDoc を、振る舞いから書く日本語に書き直す。`login-redirect.ts` の冒頭の説明は、生成コードが `handleGoogleLoginRedirect()` を呼んでいることと、`google-auth-library` が検証する項目に合わせて直した。挙動は変わらない
