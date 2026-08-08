---
---

`packages/experimental/src/jarm/response-jwt.ts` の変更は JSDoc のみ（`signingKey` が RS256 鍵でなければならないという前提の明記）で、振る舞いは変わりません。

`@maronn-openid-connect/experimental` の bump をここで手書きしないのは方針どおりです（`CLAUDE.md` / `RELEASE.md`「experimental の自動 publish」）。experimental の changeset は main への push で `.github/scripts/ensure-experimental-changeset.mjs` が patch 固定で自動生成するため、この PR の JSDoc 変更もそこでまとめて publish されます。

実際の挙動修正は `@maronn-openid-connect/cli` 側（JARM 応答 JWT の署名鍵選択）で、`.changeset/jarm-rs256-key-selection.md` に記載しています。
