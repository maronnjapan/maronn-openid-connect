---
"@maronn-openid-connect/cli": minor
---

生成物から契約テスト `conformance.test.ts` をなくす

`generate` と `setup` は、選択した機能構成に合わせた契約テスト `conformance.test.ts`（Next.js は `_oidc-provider/conformance.test.ts`）を生成コードと一緒に出力していた。
生成コードのテストは書かない方針に改めたので、今後は出力しない。
生成 OP の挙動は、このリポジトリの E2E テスト（`tests/e2e`）と OpenID Conformance Suite（`tests/conformance`）で確認する。

## 破壊的変更

- **cli: 生成物に `conformance.test.ts` が含まれなくなった**。`--force` で再生成しても、既存の `conformance.test.ts` は削除も更新もされない。残ったファイルは以後の生成コードに追随しないので、手で削除する
