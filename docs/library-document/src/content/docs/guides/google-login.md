---
title: Google ログイン（拡張）
description: CLI の --enable google-login で Sign in with Google を OP のログイン手段に足す。
---

`--enable google-login` は、生成される OP のログイン画面に「Google でログイン」（Sign in with Google、Google Identity Services の redirect mode）を追加する**拡張機能**です。OAuth / OIDC の仕様ではなく**ログイン手段**を足すものなので、Optional / Experimental とは別カテゴリで、既定では無効です。実装は別 package の `@maronn-openid-connect/google-login` にあり、有効にしたときだけ生成コードから import されます。

Google が `login_uri` へ POST する ID トークンの検証は Google 公式の [`google-auth-library`](https://github.com/googleapis/google-auth-library-nodejs) に委ねます（公開鍵の取得・ローテーション追随、署名・`aud`・`iss`・`exp` の検証）。このため **Node.js 22 以上限定**で、Cloudflare Workers などのエッジランタイムでは動きません。

参照する Google のドキュメント:

- [Google ログインからの移行 — redirect mode](https://developers.google.com/identity/gsi/web/guides/migration?hl=ja#redirect-mode_1)
- [サーバーサイドで Google ID トークンを検証する](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token?hl=ja)

## 生成する

```bash
maronn-oidc generate express --enable google-login
pnpm add express @maronn-openid-connect/core @maronn-openid-connect/google-login
```

`hono` / `fastify` / `nextjs` でも同じです。他の機能と組み合わせられます（例: `--enable google-login --enable transaction-binding`）。

有効にしても、`config.googleLogin` を渡すまではボタンは表示されず、`POST /login/google` は 404 を返します。先に生成だけしておき、Google Cloud コンソールの準備ができてから設定を渡す、という順でも動きます。

## Google Cloud コンソール側の設定

1. OAuth 2.0 クライアント ID（種類: ウェブ アプリケーション）を作成する
2. **承認済みの JavaScript 生成元**に、ログイン画面を配信するオリジン（例: `https://op.example.com`。ローカルなら `http://localhost:3010`）を登録する
3. **承認済みのリダイレクト URI**に `<issuer>/login/google`（例: `https://op.example.com/login/google`）を登録する

生成コードは `login_uri` を `new URL('/login/google', config.issuer)` で組み立て、Google はこの値と登録済み URI の完全一致を要求します。`issuer` を変えたら Google 側の登録も合わせてください。Google は `http://127.0.0.1` を JavaScript 生成元として受け付けないので、ローカル検証では `localhost` で起動します。

## 設定

`ProviderConfig` に `googleLogin` を渡します。

```typescript
applyOidc(app, {
  config: {
    issuer: 'https://op.example.com',
    googleLogin: {
      clientId: process.env.GOOGLE_CLIENT_ID!,   // Google Cloud コンソールの OAuth クライアント ID
      hostedDomain: 'example.com',               // 任意: この Google Workspace ドメインの `hd` だけ受理
      requireVerifiedEmail: true,                // 任意: email_verified が true の ID トークンだけ受理
    },
  },
  // ...
});
```

生成される Next.js の `_oidc-provider/runtime.ts` と本リポジトリの samples は、`GOOGLE_CLIENT_ID` と `GOOGLE_HOSTED_DOMAIN` からこれを読みます。

## 生成されるもの

| 生成物 | 内容 |
|---|---|
| `config.ts` | `GoogleLoginConfig` と `ProviderConfig.googleLogin` |
| `views.ts` | `LoginPageParams.googleSignInHtml`。既定のログイン画面はパスワードフォームの下に、`buildGoogleSignInMarkup()` が生成した GIS のボタン HTML（`data-ux_mode="redirect"` / `data-login_uri` / `data-nonce`）をそのまま埋め込む |
| `routes/login.ts` | GET `/login` で認証トランザクションに束縛した nonce を発行してボタンを描画。`POST /login/google` で ID トークンを受け取り、パスワードログインと同じ手順でセッションを確立して `/consent` へ進む |
| `store.ts` | nonce → `transaction_id` を記録する `googleLoginNonceStore`（インメモリ / `JsonStoreBackend` 両対応）と、Google ユーザーを登録する `userStore.linkGoogleAccount()` |
| `app.ts` | `googleIdTokenVerifier` と `googleAccountResolver` を差し替えるオプション |
| `conformance.test.ts` | ボタン描画・nonce・CSRF・検証失敗・hosted domain・JIT 登録からトークン発行と UserInfo までを固定する契約テスト |
| Next.js | `login/page.tsx` でのボタン描画、`login/google/route.ts`（Node.js ランタイム）、`runtime.ts` の環境変数読み取り |

Hono のメソッドガードと Fastify アダプタには `POST /login/google` が登録され、それ以外のメソッドは 405 になります。

## ログインの流れ

```
RP ──(認可リクエスト)──> /authorize             core: createAuthTransaction
                          └─> GET /login?transaction_id=…
                                issueGoogleLoginNonce   nonce → transaction_id をストアに保存
                                buildGoogleSignInMarkup data-nonce にその nonce を載せる
ユーザーが Google でアカウントを選択（GIS が g_csrf_token Cookie を設定）
Google ──(POST credential, g_csrf_token)──> /login/google
                                1. g_csrf_token の Cookie と本文を突き合わせる（Double Submit Cookie）
                                2. google-auth-library で ID トークンを検証（署名 → aud → iss → exp）
                                3. ID トークンの nonce で transaction_id を復元し、nonce を削除（単回使用）
                                4. Google アカウント → OP の subject（既定は JIT 登録）
                                5. パスワードログインと同じセッション確立 → /consent
```

Google の POST には `credential` と `g_csrf_token` しか入らず、`login_uri` にクエリを足せないため、認証トランザクションは nonce 経由で引き当てます。nonce は CSPRNG 由来（32 バイト）で、トランザクションと同じ期限を持ち、1 回使ったら削除されます。検証前に失敗した POST（Cookie 不一致など）では nonce は残るので、同じログイン画面からやり直せます。

失敗は `GoogleLoginError` の `httpStatusCode` でエラーページを返します（CSRF・nonce 不正・`credential` 欠落は 400、ID トークン検証失敗は 401、`hd` / `email_verified` 不一致は 403、Google の公開鍵を取得できない場合は 503）。nonce を検証するまで誰のトランザクションか分からないため、失敗をクライアントへリダイレクトすることはありません。

## ユーザーの扱い

既定では Google アカウントをその場で登録します（JIT provisioning）。

- subject は `google:<Google の sub>`。`email` は変わりうるので識別子にしません（Google のドキュメントどおり）
- `name` / `given_name` / `family_name` / `picture` / `locale` / `email` / `email_verified` を ID トークンからそのままクレームに写し、UserInfo と ID Token で返します
- パスワードは持たないので、ユーザー名 + パスワードのフォームからはログインできません

既存のユーザーと紐付けたい場合は `googleAccountResolver` を差し替えます。

```typescript
applyOidc(app, {
  config: { /* ... */ },
  googleAccountResolver: {
    async resolveSubject(account) {
      // account は google-auth-library が検証した ID トークンのペイロード
      const user = await users.findByGoogleSub(account.sub);
      return user?.sub ?? null; // null を返すと 403 account_not_linked
    },
  },
});
```

`googleIdTokenVerifier` を差し替えると、プロキシ経由でしか Google に到達できない環境（`createGoogleIdTokenVerifier({ clientOptions: { transporterOptions } })`）や、契約テストのように Google を使わない検証に対応できます。

## 契約テストの扱い

生成される `conformance.test.ts` は本物の Google を呼びません。`fake:` 接頭辞付きの credential を受け付ける偽の `GoogleIdTokenVerifier` を `googleIdTokenVerifier` に注入し、CSRF・nonce・JIT 登録・トークン発行まで、生成コード側の責務だけを固定します。`google-auth-library` に委ねている署名・`aud`・`iss`・`exp` の検証は `@maronn-openid-connect/google-login` 自身のテストがローカルの鍵配信サーバーを使って確認しています。

## 注意点

- **Node.js 22 以上限定。** `samples/hono-cloudflare`（Cloudflare Workers）では有効にしていません
- **`transaction-binding` との併用。** 束縛 Cookie は `SameSite=Lax` なので、Google からのクロスサイト POST には付きません。生成コードは `/login/google` では束縛検証を行わず、nonce の単回使用を束縛とみなします
- **`login_uri` はログイン画面と同一サイトに置く。** GIS が `g_csrf_token` Cookie をログイン画面のドメインに設定するため、別サイトでは Double Submit Cookie の検証に失敗します
- 実際の Google アカウントで通す E2E は本リポジトリの CI には含まれません。`samples/express-flyio` / `samples/fastify-flyio` / `samples/nextjs-vercel` を `GOOGLE_CLIENT_ID` 付きで起動し、ブラウザで確認してください
