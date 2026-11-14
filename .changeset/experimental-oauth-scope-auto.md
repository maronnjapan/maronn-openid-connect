---
---

PAR の `validatePushedAuthorizationParams()` と、デバイス認可の `validateDeviceAuthorizationScope()` / `processDeviceAuthorizationRequest()` に `requireOpenIdScope` オプションを足し、`false` のときに `openid` のないリクエストを受け付ける（`packages/experimental` 側。省略時は従来どおり `openid` を必須にする）。
experimental の publish は RELEASE.md の「experimental の自動 publish」どおり、main への push 後に CI が patch の changeset を自動生成して行うため、この PR では bump を書かない。
