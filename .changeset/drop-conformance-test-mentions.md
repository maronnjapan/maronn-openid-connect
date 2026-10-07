---
---

CLI が `conformance.test.ts` を生成しなくなったことに合わせて、`@maronn-openid-connect/core` の `token-request.ts` の JSDoc と `@maronn-openid-connect/google-login` の README から、このファイルへの言及を消す。
core はコメントだけの変更で、`removeComments` により dist には出力されないため、出荷物は変わらない。
google-login は README だけの変更なので、このパッケージ単独のリリースはしない（次のリリースに含まれる）。
