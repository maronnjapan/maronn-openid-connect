---
---

PAR のクライアント認証を token endpoint と同一規則へ揃え、CIBA 償還時に grant 登録を検証する修正（`packages/experimental` のみ）。
experimental の publish は RELEASE.md の「experimental の自動 publish」どおり、main への push 後に CI が patch の changeset を自動生成して行うため、この PR では bump を書かない。
