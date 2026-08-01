---
"@maronn-oidc/experimental": patch
"@maronn-oidc/core": patch
"@maronn-oidc/cli": patch
---

`@maronn-oidc/experimental` の `@maronn-oidc/core` 参照を `dependencies` から `peerDependencies`（`>=0.0.1 <1.0.0`）へ移した。experimental は core の `AuthorizationError` / `TokenError` を `instanceof` で判定し、resolver / store を CLI 生成コードと受け渡しするため、アプリ内の core インスタンスが 1 つである必要がある。`dependencies` のままだと利用者の core とバージョンがずれたときに core が二重インストールされ、`instanceof` 判定が静かに false になって、本来 `invalid_request` を返す場面が 500 になり得た。バージョン番号の一致は要求しない（experimental は core より速く publish される想定）。

あわせて次を修正した。

- `packages/experimental` の publish 対象に LICENSE が含まれていなかったため追加
- 3パッケージの `exports` を TypeScript の推奨どおり `types` 条件を先頭へ移動
- `packages/experimental` の `main` / `types` がビルドされない `dist/index.js` を指していたため削除（公開は `./par` の subpath export のみ）
- core の minor / major リリース時に experimental も同時にリリースすることを CI で強制する `pnpm run test:release-contract` を追加
