---
'@maronn-openid-connect/core': patch
---

JSDoc の無かった関数（`hasAuthScheme` など export しない関数）と、resolver や store のインターフェースのメンバー（`ClientResolver.findClient`、`AuthTransactionStore.get` など）に、振る舞いを書いた JSDoc を足す。挙動は変わらない
