---
---

TypeScript を 7.0.2 へ更新する（Dependabot #65）。ビルド設定の追随のみで npm 出荷物の中身は変わらないため、リリースは不要と判断した。

TypeScript 7 は `node_modules/@types` を自動では読み込まなくなったため、`packages/cli` / `packages/core` / `packages/experimental` の tsconfig に `"types": ["node"]` を明示する。これがないと `console` / `process` / `CryptoKey` などの Node グローバルが未解決になり build が落ちる（samples と tests の tsconfig は以前からこの指定を持っていたので、書き方をそちらに揃えた形になる）。あわせて `packages/cli` はルートの hoist 頼みだった `@types/node` を自前の devDependencies に明示し、共通ソースディレクトリの推論を許さなくなった TS7 に合わせて `rootDir: "./src"` を明示する。

`samples/nextjs-vercel` だけは typescript を `^5.9.3` に据え置く。Next.js 16 は型チェックに TypeScript の Compiler API を使うが、ネイティブ移植である TS7 はその API を提供しないため、`next build` が「TypeScript 7.0.2 does not provide the compiler API required by Next.js」で落ちる。Next.js が案内する `experimental.useTypeScriptCli` を有効にする回避策もあるが、利用者がそのままコピーするサンプルに experimental フラグを持ち込みたくないので、Next.js が正式に対応するまではサポート済みのバージョンに留める。

出荷物が変わらないことは、更新前後の `dist` を突き合わせて確認している。`.js` は全ファイルがバイト単位で一致し、差分が出たのは 4 本の `.d.ts` だけで、いずれも TS7 が文字列リテラル型を `"RS256"` ではなく `'RS256'` と出力するようになった引用符の違いに限られる（型としては同一）。残りの差分はこの引用符ずれに追随した `.map` のオフセットのみ。
