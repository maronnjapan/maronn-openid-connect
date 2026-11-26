---
'@maronn-openid-connect/cli': patch
---

`generate nextjs` が出力する discovery の Route Handler（`.well-known/openid-configuration/route.ts`）から、`_oidc-provider/scopes.ts` に無い `SUPPORTED_SCOPES` の import を消す。値はどこでも読んでいなかったので、応答は変わらない。TypeScript の `**` はドットで始まるディレクトリに入らないので、`tsconfig.json` の `include` が `src/**/*.ts` だけだと `.well-known` の Route Handler は型検査されず、この誤りは `tsc` のエラーにならないまま残っていた。生成した Next.js のプロジェクトで `.well-known` も型検査する `include` の書き方を、README の「Next.js の生成物」に足した。
