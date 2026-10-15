---
'@maronn-openid-connect/google-login': patch
---

production 依存の `google-auth-library` を `^11.1.0` から `^11.2.0` へ上げる（Dependabot #130）。

11.2.0 の変更は Bun 向けの CLI フラグ追加だけで、ID トークン検証の API と挙動は変わらない。利用者がインストールする依存の range が変わるため、RELEASE.md の規約どおり google-login を patch でリリースする。
