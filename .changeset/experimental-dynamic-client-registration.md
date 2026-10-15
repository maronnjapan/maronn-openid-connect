---
---

`packages/experimental` に dynamic-client-registration（RFC 7591 の検証・登録レコード・initial access token 照合の純関数群と `./dynamic-client-registration` subpath export）を追加する変更。
experimental の publish は RELEASE.md の「experimental の自動 publish」どおり、main への push 後に CI が patch の changeset を自動生成して行うため、この PR では bump を書かない（CLI 側の変更は `.changeset/cli-dynamic-client-registration.md` が minor として記載する）。
