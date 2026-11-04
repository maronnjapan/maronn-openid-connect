---
---

rar（OAuth 2.0 Rich Authorization Requests、RFC 9396）の `authorization_details` の解析・構造検証・型定義による検証・同意表示行の組み立てと in-memory ストアを `@maronn-openid-connect/experimental/rar` に足す（`packages/experimental` 側）。
experimental の publish は RELEASE.md の「experimental の自動 publish」どおり、main への push 後に CI が patch の changeset を自動生成して行うため、この PR では bump を書かない。
