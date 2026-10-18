---
'@maronn-openid-connect/google-login': patch
---

README の「CLI での利用」と「生成コードへの配線」を、`apps/hono` と `apps/nextjs` から抽出する CLI の生成コードに合わせる

ドキュメントだけの変更で、パッケージの API と挙動は変わらない。

- 生成物の表を、`--enable google-login` が加える `features/google-login/`（Next.js は `_oidc-provider/features/google-login/` と `(google-login)/login/google/route.ts`）のファイルで書き直した。無くなった `routes/login.ts`、`store.ts` の `googleLoginNonceStore`、`userStore.linkGoogleAccount()` の記述を消した
- Google アカウントの subject は `--db` の有無によらずランダムな ID になり、Google の sub は Federated_identity に記録すると直した（`--db` 無しで `google:<sub>` になる、という記述は古い生成コードのもの）
- 配線例の import を、生成コードから無くなった `./store.js` のストアと `defaultProviderConfig` ではなく、アプリ側のモジュールから取るようにした
