---
---

この PR は `packages/experimental/src/token-exchange/` に delegation（RFC 8693 §4.1 の `act` claim）を実装しています。`resolveActorToken` / `composeActClaim` の追加、`parseTokenExchangeParams` の `actor_token` 対応、`TokenExchangeGrant.actor` と `ExchangedAccessTokenInfo` の追加が含まれます。

`@maronn-openid-connect/experimental` の bump をここで手書きしないのは方針どおりです（`CLAUDE.md` / `RELEASE.md`「experimental の自動 publish」）。experimental の changeset は main への push で `.github/scripts/ensure-experimental-changeset.mjs` が patch 固定で自動生成するため、この変更もそこで publish されます。

生成 OP 側の挙動変更（`act` claim の記録と契約テスト）は `@maronn-openid-connect/cli` の変更として `.changeset/token-exchange-delegation-cli.md` に記載しています。
