---
'@maronn-openid-connect/google-login': patch
---

production 依存の `google-auth-library` の range を `^11.2.0` から `^11.3.3` へ上げる（Dependabot #188）。利用者がインストールする依存の range が変わるため、RELEASE.md の規約に従って publish する。google-login の公開 API と振る舞いは変わらない。
