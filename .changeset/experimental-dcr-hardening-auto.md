---
---

dynamic-client-registration の検証メッセージと client_name フィルタの修正（`packages/experimental` 側）。
experimental の publish は RELEASE.md の「experimental の自動 publish」どおり、main への push 後に CI が patch の changeset を自動生成して行うため、この PR では bump を書かない。
