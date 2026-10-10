---
title: Google ログイン（拡張）
description: CLI の --enable google-login で Sign in with Google を OP のログイン手段に足す。
---

`--enable google-login` は、生成される OP のログイン画面に「Google でログイン」（Sign in with Google、Google Identity Services の redirect mode）を追加する**拡張機能**です。OAuth / OIDC の仕様ではなく**ログイン手段**を足すものなので、Experimental とは別カテゴリで、既定では無効です。実装は別 package の `@maronn-openid-connect/google-login` にあり、有効にしたときだけ生成コードから import されます。

Google が `login_uri` へ POST する ID トークンの検証は Google 公式の [`google-auth-library`](https://github.com/googleapis/google-auth-library-nodejs) に委ねます（公開鍵の取得・ローテーション追随、署名・`aud`・`iss`・`exp` の検証）。このため **Node.js 22 以上限定**で、Cloudflare Workers などのエッジランタイムでは動かない可能性があります。

参照する Google のドキュメント:

- [Google ログインからの移行 — redirect mode](https://developers.google.com/identity/gsi/web/guides/migration?hl=ja#redirect-mode_1)
- [サーバーサイドで Google ID トークンを検証する](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token?hl=ja)

## 生成する

```bash
maronn-oidc generate express --enable google-login
pnpm add express @maronn-openid-connect/core @maronn-openid-connect/google-login
```

`hono` / `fastify` / `nextjs` でも同じです。他の機能と組み合わせられます（例: `--enable google-login --enable par`）。

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

生成される Next.js の `_oidc-provider/provider.ts` と本リポジトリの samples は、`GOOGLE_CLIENT_ID` と `GOOGLE_HOSTED_DOMAIN` からこれを読みます。

## フロント側の設定

パッケージはログイン画面の UI を生成しません。Google のドキュメント（redirect mode）どおり、画面には次の 3 つを置きます。

```html
<script src="https://accounts.google.com/gsi/client" async></script>
<div id="g_id_onload"
     data-client_id="<OAuth クライアント ID>"
     data-ux_mode="redirect"
     data-login_uri="https://op.example.com/login/google"
     data-nonce="<サーバーで発行した nonce>"></div>
<div class="g_id_signin" data-type="standard"></div>
```

`data-ux_mode="redirect"`、Google 側の登録値と完全一致する `data-login_uri`、リクエストごとに発行する `data-nonce` を忘れると動かない（または `login_uri` 側でトランザクションを復元できない）ので、`@maronn-openid-connect/google-login/sign-in` の `buildGoogleSignInAttributes` で `g_id_onload` の属性オブジェクトを組み立てます。キーは GIS の属性名そのものなので、描画方法を問わずそのまま渡せます。このサブパスは何にも依存しないので、ブラウザ向けバンドルや React の client component からも import できます。

```typescript
import { buildGoogleSignInAttributes, googleSignInAttributesToHtml } from '@maronn-openid-connect/google-login/sign-in';

const googleSignIn = buildGoogleSignInAttributes({ clientId, loginUri, nonce, loginHint });

// プレーン HTML（文字列テンプレート）
`<div ${googleSignInAttributesToHtml(googleSignIn)}></div>`;
// React
<div {...googleSignIn} />;
// Vue
// <div v-bind="googleSignIn" />
```

生成コードの既定のログイン画面（`views.ts`、Hono は `views.tsx` / Next.js の `login/page.tsx`）はこの形で 3 要素を書き出しているので、見た目や配置はそこを書き換えます。描画の仕方ごと変える（テンプレートエンジンや別 UI へのリダイレクト）なら `pages/login.ts`（Hono は `pages/login.tsx`）の `renderLoginPage()` を書き換えます。

## 生成されるもの

| 生成物 | 内容 |
|---|---|
| `config.ts` | `GoogleLoginConfig` と `ProviderConfig.googleLogin` |
| `views.ts`（Hono は `views.tsx`） | `LoginPageParams.googleSignIn`（`g_id_onload` の属性）。既定のログイン画面はパスワードフォームの下に GIS の 3 要素（スクリプト / `g_id_onload` / `g_id_signin`）を書き出す。UI は生成コード側にあるので、見た目や配置は自由に変えられる |
| `pages/login.ts`（Hono は `pages/login.tsx`） | `GET /login` と `POST /login/google` のルート。`routes/login.ts` が返した画面データの `googleSignIn`（ボタンの設定）を view に渡して描画し、`completeGoogleLogin()` の結果（セッション確立 → `/consent` へ、未設定なら 404、失敗ならエラー画面）を HTTP に変換する |
| `routes/login.ts` | `buildGoogleSignIn()` で認証トランザクションに束縛した nonce を発行してボタンの設定を組み立て（`GET /login` とログイン失敗時の再表示の両方で使う）、`completeGoogleLogin()` で ID トークンを検証し、パスワードログインと同じ手順でセッションを確立する。Response は作らない |
| `store.ts` | nonce → `transaction_id` を記録する `googleLoginNonceStore`（インメモリ / `JsonStoreBackend` 両対応）と、Google ユーザーを登録する `userStore.linkGoogleAccount()`。`--db` 付きで生成した場合は、`db/stores.ts` が同じ 2 つを SQL のテーブル（`google_login_nonces` / `google_users`）で実装する |
| `app.ts` | `googleIdTokenVerifier` と `googleAccountResolver` を差し替えるオプション |
| Next.js | `login/page.tsx` で `<div {...googleSignIn} />` と `next/script` による描画（`dangerouslySetInnerHTML` は使わない）、`login/google/route.ts`（Node.js ランタイム）、`_oidc-provider/provider.ts` の環境変数読み取り |

Hono のメソッドガードと Fastify アダプタには `POST /login/google` が登録され、それ以外のメソッドは 405 になります。

## ログインの流れ

```
RP ──(認可リクエスト)──> /authorize             core: createAuthTransaction
                          └─> GET /login（トランザクションの ID は HttpOnly Cookie で受け取る）
                                issueGoogleLoginNonce        nonce → transaction_id をストアに保存
                                buildGoogleSignInAttributes  g_id_onload の属性（data-nonce にその nonce）を組み立て、画面が描画
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

Next.js の `login/google/route.ts` は、失敗したコールバックを OP のエラーページ（`oidc-error/page.tsx`）へ 303 でリダイレクトし、`GoogleLoginError` の `code` と `message` を表示します。Route Handler からは React のページを描画できないため、ステータスコードではなくエラーページへの遷移で失敗を伝えます。`config.googleLogin` が未設定のときは `notFound()` で 404 を返します。

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

`googleIdTokenVerifier` を差し替えると、プロキシ経由でしか Google に到達できない環境（`createGoogleIdTokenVerifier({ clientOptions: { transporterOptions } })`）や、Google を呼ばない自動テストに対応できます。

## 注意点

- **Node.js 22 以上限定。** `samples/hono-cloudflare`（Cloudflare Workers）では有効にしていません
- **トランザクション Cookie は `/login/google` に届かない。** トランザクション Cookie（`__Host-oidc_txn`）は `SameSite=Lax` なので、Google からのクロスサイト POST には付きません。生成コードは `/login/google` ではトランザクションを nonce から復元し、nonce の単回使用を束縛とみなします（nonce を発行するログイン画面は Cookie を持つブラウザにしか表示されません）。その後の `/consent` への遷移は通常のナビゲーションなので、Cookie が付きます。`POST /login`・`POST /consent` の送信元チェック（`Origin` / `Sec-Fetch-Site`）も、Google からの POST を受ける `/login/google` には掛けません
- **`login_uri` はログイン画面と同一サイトに置く。** GIS が `g_csrf_token` Cookie をログイン画面のドメインに設定するため、別サイトでは Double Submit Cookie の検証に失敗します
- 実際の Google アカウントで通す E2E は本リポジトリの CI には含まれません。`samples/express-flyio` / `samples/fastify-flyio` / `samples/nextjs-vercel` を `GOOGLE_CLIENT_ID` 付きで起動し、ブラウザで確認してください
