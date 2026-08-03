---
'@maronn-oidc/experimental': patch
---

`@maronn-oidc/core` の minor リリース（アクセストークンへの `jti` 付与）に合わせた同時リリース。

`packages/experimental/src` 自体に変更は無い。experimental は core を広い peer range で参照して
いるため、core が minor で進むと「公開済みの古い experimental が、まだ組み合わせて検証していない
新しい core を受け入れる」状態になる。RELEASE.md「core の minor / major では experimental も
一緒にリリースする」に従い、最新 core と組み合わせて検証済みの experimental を同時に publish する。

token-exchange が発行する交換後アクセストークンにも core 由来の `jti` が入り、同じ subject_token
から同一秒に 2 回交換しても別トークンになる（生成 OP 側の contract テストで固定済み）。
