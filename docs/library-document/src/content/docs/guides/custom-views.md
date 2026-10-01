---
title: 画面の差し替え
description: 生成 OP のログイン画面や同意画面を、HTML 文字列や React、Vue など好きな方法で描画した画面に差し替える。
---

生成される OP の画面（ログイン、同意、エラー、有効にした機能の device / CIBA / logout 画面）は、`views.ts` にある画面ごとの関数（**ビュー**）が描画します。
既定のビューは、フローを動かすためだけの装飾のない HTML を返します。
見た目を整えた画面は、利用者がビューを差し替えて用意する前提です。

このライブラリが画面について受け持つのは、ビューに渡すデータ（画面ごとのパラメータ）と、画面から送られるフォームの項目です。
HTML の組み立て方（テンプレート文字列、テンプレートエンジン、React や Vue のサーバー描画など）と、ブラウザで動くスクリプトは利用者が決めます。

## ビューを差し替える

`createApp` / `applyOidc` の `views` オプションに、差し替える画面のビューだけを渡します。
渡さなかった画面は既定のビューのままです。
`views.ts` を編集しないので、CLI で生成し直しても差し替えた画面は残ります。

次の例は、ログイン画面をテンプレート文字列で書き直したものです。

```typescript
import { applyOidc } from './oidc-provider/apply.js';
import { escapeHtml, type LoginPageParams } from './oidc-provider/views.js';

function loginPage(params: LoginPageParams): string {
  const error = params.error ? `<p role="alert">${escapeHtml(params.error)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><title>ログイン</title></head>
<body>
  <h1>ログイン</h1>
  ${error}
  <form method="POST" action="/login">
    <input type="hidden" name="transaction_id" value="${escapeHtml(params.transactionId)}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrfToken)}">
    <label>ユーザー名 <input name="username" value="${escapeHtml(params.loginHint ?? '')}" required></label>
    <label>パスワード <input type="password" name="password" required></label>
    <button type="submit">ログイン</button>
  </form>
</body>
</html>`;
}

applyOidc(app, {
  // config, signingKeyProvider など
  views: { loginPage },
});
```

`escapeHtml()` は既定のビューが値を埋め込むときに使っている関数で、`views.ts` から import できます。

## 差し替えた画面が守るフォームの契約

生成されるルートは、既定のビューが送るフォームの項目をそのまま読みます。
そのため、差し替えた画面でも、送信先と項目の名前とボタンの値は既定のビューと同じにします。
見た目、文言、要素の構成は自由に変えられます。

| ビュー | 送信先 | 送る項目 |
|---|---|---|
| `loginPage` | `POST /login` | `transaction_id`（hidden）、`csrf_token`（hidden）、`username`、`password` |
| `consentPage` | `POST /consent` | `transaction_id`（hidden）、`csrf_token`（hidden）、`action`（ボタンの値 `approve` または `deny`） |
| `deviceVerificationPage` | `POST /device` | `user_code` |
| `deviceLoginPage` | `POST /device/login` | `user_code`（hidden）、`csrf_token`（hidden）、`username`、`password` |
| `deviceApprovalPage` | `POST /device/approve` | `user_code`（hidden）、`csrf_token`（hidden）、`decision`（ボタンの値 `approve` または `deny`） |
| `cibaLoginPage` | `POST /ciba/login` | `login_transaction_id`（hidden）、`csrf_token`（hidden）、`username`、`password` |
| `cibaPendingRequestsPage` | `POST /ciba/approve`（リクエストごとのフォーム） | `auth_req_id`（hidden）、`csrf_token`（hidden）、`decision`（ボタンの値 `approve` または `deny`） |
| `logoutConfirmationPage` | `POST /logout/approve` | `csrf_token`（hidden） |

`errorPage`、`deviceCompletedPage`、`cibaCompletedPage`、`logoutCompletedPage` はフォームを持ちません。
同意画面の `action` は、`approve` と `deny` 以外の値を 400 で拒否します。
ボタンの値を変えると、承認がすべて失敗します。

`--enable google-login` で生成した場合、ログイン画面のパラメータには `googleSignIn`（`g_id_onload` に置く属性）が加わります。
差し替えた画面にも、Google Identity Services が求める 3 つの要素を置いてください（[Google ログイン（拡張）](../google-login/)）。

既定のビューには、仕様上の理由で置いている表示もあります。
device の承認画面は、利用者が手元のデバイスの表示と見比べられるように `user_code` を表示します（RFC 8628 §5.4）。
CIBA の承認画面は `binding_message` を表示し、拒否のボタンを許可のボタンと同じ目立ち方で置きます（CIBA Core 1.0 §7.1）。
logout の確認画面と完了画面は、セッションの有無で文言を変えません。
文言が変わると、その画面がセッションの存在を判定する手段になるためです。
これらの画面を差し替えるときも、同じ表示を保ってください。

## パラメータのエスケープ

パラメータには、`loginHint`、`bindingMessage`、`errorDescription` のように OP の外から来る値が含まれます。
HTML を文字列で組み立てるときは、すべての値を `escapeHtml()` でエスケープします。
React や Vue は埋め込んだ値を自動でエスケープしますが、`dangerouslySetInnerHTML` や `v-html` にパラメータを渡すとその保護が外れます。

## ビューが返せる値

ビューの返り値（`ViewResult`）は次の 3 種類で、どれも Promise で返せます。

- **HTML 文字列**：既定のビューが返す形です
- **HTML の `ReadableStream`**：ストリーミングで描画するサーバーレンダラーの出力です
- **`Response`**：ステータスコードやヘッダーをビュー自身で決めるときに返します

生成されるルートは、ビューの返り値を `renderView()` で `Response` に変換します。
文字列とストリームは `Content-Type: text/html; charset=UTF-8` の本文になり、`Response` は加工せずに返ります。
それ以外の値を受け取ると、`renderView()` は `TypeError` を投げます。
コンポーネントを HTML に描画せずに返したときに、`[object Object]` という本文をブラウザへ送らないためです。

## React や Vue で描画する

サーバーレンダラーの出力はそのままビューの返り値になるので、React や Vue のコンポーネントも短い関数で包むだけでビューになります。
コンポーネントには、画面のパラメータを props として渡します。

React では、`react-dom/server` の `renderToReadableStream` が返すストリームをそのまま返します。
コンポーネントのルート要素が `<html>` なら、`<!DOCTYPE html>` は React が付けます。

```tsx
import { renderToReadableStream } from 'react-dom/server';
import type { LoginPageParams } from './oidc-provider/views.js';
import { LoginPage } from './LoginPage.js';

export const loginPage = (params: LoginPageParams) =>
  renderToReadableStream(<LoginPage {...params} />);
```

Vue では、`vue/server-renderer` の `renderToString` が返す文字列に `<!DOCTYPE html>` を付けて返します。
パラメータは `h()` で props として渡します[^vue-props]。

```typescript
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { ConsentPageParams } from './oidc-provider/views.js';
import { ConsentPage } from './ConsentPage.js';

export const consentPage = async (params: ConsentPageParams) =>
  '<!DOCTYPE html>' +
  (await renderToString(createSSRApp({ render: () => h(ConsentPage, params) })));
```

どちらも `views: { loginPage, consentPage }` のように渡します。
このライブラリは React や Vue に依存せず、これらの関数も提供しません。

[^vue-props]: `createSSRApp(ConsentPage, params)` の第 2 引数で渡すと型エラーになります。画面のパラメータ型はインデックスシグネチャを持たない interface なので、`createSSRApp` の props 引数の型に代入できません。

## ブラウザ側の動き

ビューの返り値は、そのまま HTML としてブラウザへ送られます。
フォームの送信は通常の HTML フォームの POST なので、スクリプトがなくても画面は動きます。
一方で、サーバーで描画しただけのコンポーネントは静的な HTML です。
React の `useState` や Vue の `ref` のような状態とイベントハンドラーは、ブラウザでは動きません。

画面に動きが必要なら、利用者のアプリでクライアント向けのスクリプトを配信し、ビューが返す HTML から `<script>` で読み込みます。
ハイドレーションには、React の `hydrateRoot` や Vue の `createSSRApp(...).mount()` のような各フレームワークの仕組みをそのまま使います。
パラメータを JSON にして HTML に埋め込むときは、`</script>` で抜け出されないように `<` を `\u003c` に置き換えます。

## Next.js の場合

Next.js ターゲットでは、ログイン画面、同意画面、認可エラー画面は、生成される `login/page.tsx`、`consent/page.tsx`、`oidc-error/error.tsx` の React コンポーネントです。
これらは Next.js が描画する通常のページなので、ファイルを直接編集して差し替えます。
`views.ts` のビューが使われるのは、device や CIBA の画面のように Route Handler が描画する画面です。
ビューは、`_oidc-provider/runtime.ts` の `createOidcProviderOptions()` が返すオブジェクトに `views` として足します。

App Router は、`react-dom/server` の静的な import をビルドエラーにします。
Route Handler の画面を React で描画するときは、ビューの中で `react-dom/server` を動的に import します。

```tsx
import type { DeviceVerificationPageParams } from './_oidc-provider/views';
import { DeviceVerificationPage } from './DeviceVerificationPage';

export const deviceVerificationPage = async (params: DeviceVerificationPageParams) => {
  const { renderToReadableStream } = await import('react-dom/server');
  return renderToReadableStream(<DeviceVerificationPage {...params} />);
};
```
