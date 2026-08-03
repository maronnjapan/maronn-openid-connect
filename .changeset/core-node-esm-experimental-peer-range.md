---
"@maronn-oidc/experimental": patch
"@maronn-oidc/core": patch
---

公開済みパッケージが利用者の環境で読み込めなかった 2 件を修正した。

### `@maronn-oidc/core`: Node の ESM ローダで解決できる形で publish する

`packages/core` は `"type": "module"` だが、`src` の相対 import に拡張子が無く、
`tsconfig.json` の `moduleResolution` が `bundler` だったため、`dist` にも拡張子なしの
specifier がそのまま emit されていた。Node の ESM ローダは拡張子の補完を行わないので、
公開済みの `@maronn-oidc/core@0.0.1` は `import '@maronn-oidc/core'` した時点で
`ERR_MODULE_NOT_FOUND: Cannot find module '.../dist/authorization-request'` になり、
**バンドラを通さない Node 環境では一切読み込めない状態だった**。

`samples/*` はすべて esbuild でバンドルしてから起動しており、esbuild は拡張子を補完するため
リポジトリ内の CI・E2E・conformance では発覚しなかった。

- `packages/core/src` の相対 import / `export ... from` / 型の `import('./x')` すべてに
  `.js` 拡張子を付けた
- `packages/core` と `packages/experimental` の `tsconfig.json` を
  `module` / `moduleResolution` ともに `NodeNext` へ変更し、拡張子の付け忘れを
  コンパイル時に落とすようにした（`bundler` に戻すと同じ状態を再び publish できてしまう）

実行時の挙動と公開 API に変更はない。

### `@maronn-oidc/experimental`: core の peer range の下限を `>=0.1.0` へ上げる

`@maronn-oidc/experimental` は core のステップ関数
（`extractClientCredentials` / `resolveAuthenticatedTokenClient` /
`validateClientAuthMethod` / `verifyClientSecret`）を import しているが、これらを export する
core はまだ publish されていなかった。それにもかかわらず peer range の下限が `>=0.0.1` の
ままだったため、`@maronn-oidc/experimental@0.0.1` と `@maronn-oidc/core@0.0.1` の組み合わせが
インストールできてしまい、バンドル時に esbuild が次のエラーで落ちていた。

```
✘ [ERROR] No matching export in "node_modules/@maronn-oidc/core/dist/index.js"
  for import "extractClientCredentials"
```

下限を `>=0.1.0 <1.0.0` へ上げ、これらを export する core 以降とだけ組み合わせられるようにした。
古い core を使っている場合はインストール時に `unmet peer` として検出できる。

あわせて、この下限の管理を手運用から CI へ移した。`pnpm run test:release-contract`
（`.github/scripts/verify-release-contract.mjs`）に、**experimental の peer range の下限が
「次に publish される core のバージョン」以上であること**を検査する
`assertExperimentalCorePeerRangeCoversNextCore` を追加した。experimental はモノレポ内の core
だけを相手にビルド・テストされるため、それより古い core を下限に据えることは「試していない
組み合わせ」を許可宣言することに等しい。RELEASE.md「peer range は『下限』を宣言する」に
書かれていた手順を機械化したもので、下限の上げ忘れは CI で止まる。

### 利用者への影響

`@maronn-oidc/core@0.0.1` および `@maronn-oidc/experimental@0.0.1` は上記のとおり
組み合わせて利用できない。本リリース以降のバージョンへ更新すること。
