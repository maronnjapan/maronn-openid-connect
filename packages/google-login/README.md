# @maronn-openid-connect/google-login

Sign in with Google（Google Identity Services、以下 GIS）の redirect mode を、`@maronn-openid-connect/core` で組んだ OpenID Provider のログイン手段として使うための拡張パッケージ。

## 位置づけ

- **core と組み合わせて使う。単体では使わない。** Google のログイン結果を core の認証トランザクション（`getAuthTransaction` → 認証セッションの確立 → 同意 → `completeAuthTransaction`）へ接続するための部品で、OP 本体の機能は持たない
- **CLI 生成コードから呼び出す想定で API を切っている。** core と同じく HTTP の配線（ルーティング・本文解析・Cookie の発行）は呼び出し側の責務とし、このパッケージは検証と生成のステップ関数だけを提供する。`@maronn-openid-connect/cli` への組み込み（`--enable google-login`）は未対応で、それまでは生成コードへ手で配線する（[生成コードへの配線](#生成コードへの配線)）
- **ID トークンの検証は Google 公式の [`google-auth-library`](https://github.com/googleapis/google-auth-library-nodejs) に委ねる。** 公開鍵の取得とローテーション追随、署名・`iss`・`aud`・`exp` の検証はライブラリが行い、Google 側の仕様変更にはライブラリの更新で追随する。このパッケージが自前で持つのは、redirect mode の POST の読み取り、Double Submit Cookie の検証、core の認証トランザクションへの束縛、ログイン画面のボタン生成だけ
- **Node.js 22 以上限定。** `google-auth-library` が Node.js の API を前提にするため、core / experimental と違い Cloudflare Workers などのエッジランタイムでは動かない。production 依存に外部ライブラリを持つのはモノレポ内でこのパッケージだけ
- **core は peerDependency**（`>=0.3.0 <1.0.0`）。experimental と同じ理由で `dependencies` には置かない（アプリ内の core のインスタンスを 1 つに保つため。[RELEASE.md](../../RELEASE.md)「バージョニング方針」）

## 参照ドキュメント

実装は次の 2 つの Google のドキュメントに従う。

- [Google ログインからの移行 — redirect mode](https://developers.google.com/identity/gsi/web/guides/migration?hl=ja#redirect-mode_1): `ux_mode: 'redirect'` では、ユーザーがアカウントを選ぶとブラウザが `login_uri` へ ID トークンを POST する
- [サーバーサイドで Google ID トークンを検証する](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token?hl=ja): 検証条件（署名・`aud`・`iss`・`exp`、任意で `hd`）、Node.js では `google-auth-library` の `verifyIdToken` を使うこと、`g_csrf_token` による Double Submit Cookie の CSRF 対策

## 全体の流れ

```
RP ──(認可リクエスト)──> OP /authorize        core: validateAuthorizationRequest → createAuthTransaction
                          │
                          └─> OP /login?transaction_id=…（GET）
                                issueGoogleLoginNonce  … nonce → transaction_id をストアに保存
                                buildGoogleSignInMarkup … data-ux_mode="redirect" / data-login_uri / data-nonce
                          │
ユーザーが Google でアカウントを選択（GIS クライアントが g_csrf_token Cookie を設定）
                          │
Google ──(POST credential, g_csrf_token, select_by)──> OP login_uri（例: /login/google）
                                handleGoogleLoginRedirect
                                  1. parseGoogleCsrfTokenCookie / parseGoogleRedirectCredential / validateGoogleCsrfToken
                                  2. verifyGoogleIdToken … google-auth-library（署名 → aud → iss → exp）+ 任意の hd / email_verified
                                  3. consumeGoogleLoginNonce … ID トークンの nonce から transaction_id を復元（単回使用）
                                core: getAuthTransaction(transactionId)
                                resolveGoogleLoginSubject … Google アカウント → OP の subject
                                以降はユーザー名 + パスワードのログインと同じ（セッション確立 → /consent）
```

Google の POST には `credential` と `g_csrf_token` しか入らず、`login_uri` は Google Cloud コンソールに登録した URI と完全一致させる必要がある（クエリでトランザクション ID を運べない）。そこで GIS の `data-nonce` に載せた nonce が ID トークンの `nonce` クレームとして返ることを使い、検証を通ったトークンの `nonce` で認証トランザクションを引く。nonce は CSPRNG 由来（32 バイト）で、引いた時点で削除する。

## インストール

```bash
pnpm add @maronn-openid-connect/core @maronn-openid-connect/google-login
```

`google-auth-library` は本パッケージの `dependencies` に入っているので、別途追加する必要はない。

## Google Cloud コンソール側の設定

1. OAuth 2.0 クライアント ID（種類: ウェブ アプリケーション）を作成する
2. **承認済みの JavaScript 生成元**に、ログイン画面を配信するオリジン（例: `https://op.example.com`）を登録する
3. **承認済みのリダイレクト URI**に、ID トークンの POST 先（`loginUri` に渡す値。例: `https://op.example.com/login/google`）を登録する。GIS はこの値と `data-login_uri` の完全一致を要求する

`login_uri` はログイン画面と同一サイトに置く。GIS クライアントが `g_csrf_token` Cookie をログイン画面のドメインに設定し、同じ値を POST 本文にも入れるため、別サイトでは Cookie が届かず Double Submit Cookie の検証に失敗する。

## 提供機能（API 概要）

すべて `@maronn-openid-connect/google-login` からエクスポートされる。

### ログイン画面

| API | 役割 |
|---|---|
| `issueGoogleLoginNonce` | 認証トランザクション ID に対応する nonce を発行し、`GoogleLoginNonceStore` に保存する（TTL はトランザクションの `expiresAt` まで） |
| `buildGoogleSignInMarkup` | GIS の「Google でログイン」ボタン（redirect mode）の HTML を生成する。`data-nonce` / `data-login_hint`（OIDC の `login_hint`）/ `data-hd` / ボタンの見た目を指定できる。属性値は HTML エスケープする |
| `assertGoogleLoginUri` | `loginUri` が GIS の条件（絶対 URL・HTTPS・fragment 無し。localhost のみ HTTP 可）を満たすことを検証する |
| `GOOGLE_SIGN_IN_CSP_SOURCES` | ログイン画面に Content-Security-Policy を設定している場合に各ディレクティブへ足す GIS のソース |

### login_uri（redirect mode の POST 先）

| API | 役割 |
|---|---|
| `handleGoogleLoginRedirect` | 下記ステップ関数を Google のドキュメントの順序で呼び出す合成関数。`transactionId`（core の `getAuthTransaction` に渡す）と検証済みの Google アカウントを返す |
| `parseGoogleCsrfTokenCookie` | `Cookie` ヘッダーから `g_csrf_token` を取り出す |
| `parseGoogleRedirectCredential` | POST 本文（`Record` / `URLSearchParams` / `FormData`）から `credential` / `g_csrf_token` / `select_by` を取り出す |
| `validateGoogleCsrfToken` | Double Submit Cookie 検証（Cookie 無し → 本文無し → 不一致の順で拒否。比較は constant-time） |
| `consumeGoogleLoginNonce` | 検証済み ID トークンの `nonce` からログイン試行の記録を引き、同時に削除する（単回使用） |
| `resolveGoogleLoginSubject` | `GoogleAccountResolver` で Google アカウントを OP の subject に対応付ける。未連携なら `account_not_linked` |

### ID トークンの検証

| API | 役割 |
|---|---|
| `verifyGoogleIdToken` | verifier で検証（下記）したあと、任意の `hostedDomain` / `requireVerifiedEmail` / `expectedNonce` を確認して `GoogleIdTokenPayload`（`google-auth-library` の `TokenPayload`）を返す |
| `createGoogleIdTokenVerifier` | `google-auth-library` の `OAuth2Client.verifyIdToken` で検証する verifier を作る。ライブラリが Google の公開鍵を取得して `Cache-Control` の間キャッシュし、署名・`aud`（複数可）・`iss`・`exp` / `iat` を検証する。`OAuth2Client` のオプション（`transporter` / `endpoints` など）や既存のインスタンスを渡せる |
| `getDefaultGoogleIdTokenVerifier` | プロセスで共有する既定の verifier（初回に生成）。`verifier` を省略したときに使われる。公開鍵のキャッシュは `OAuth2Client` が持つので、検証のたびに作り直さない |
| `validateGoogleHostedDomain` | 任意。`hd` が許可した Google Workspace のドメイン（のいずれか）と一致する |
| `validateGoogleEmailVerified` | 任意。`email_verified` が `true`（メールでユーザーを対応付ける構成向け） |
| `validateGoogleIdTokenNonce` | 任意。`nonce` が期待値と一致する（nonce をストアではなく Cookie やセッションで持つ構成向け） |

`GoogleIdTokenVerifier` はインターフェースなので、テストや特殊な環境では差し替えられる。

### エラー

`GoogleLoginError`（`code: GoogleLoginErrorCode`、`httpStatusCode`）。core の `AuthTransactionError` と同じ形なので、生成コードは同じ catch 節で扱える。

| `httpStatusCode` | 対象 |
|---|---|
| 400 | `credential` 無し、`g_csrf_token` の Cookie 無し / 本文無し / 不一致、`nonce` 無し・未発行・使用済み・期限切れ |
| 401 | `invalid_id_token`: `google-auth-library` が ID トークンを受け入れなかった（形式・署名・`iss`・`aud`・`exp` / `iat`）。ライブラリのエラーは `cause` に入り、`message` はそのまま |
| 403 | トークンは正しいが受け入れない（`hd` 不一致、`email_verified` でない、OP のユーザーに未連携） |
| 503 | `signing_key_unavailable`: Google の公開鍵を取得できない（ライブラリのエラーは `cause`） |

## 生成コードへの配線

CLI が生成するログインルート（`routes/login.ts`）と同じ材料（`transactionStore` / `authSessionStore` / `browserSessionStore` / `views`）を使って、GET のログイン画面にボタンを足し、`login_uri` のルートを 1 つ追加する。以下は Hono の例。

```typescript
import { Hono } from 'hono';
import { getAuthTransaction, generateRandomString } from '@maronn-openid-connect/core';
import {
  buildGoogleSignInMarkup,
  handleGoogleLoginRedirect,
  issueGoogleLoginNonce,
  resolveGoogleLoginSubject,
  GoogleLoginError,
  type GoogleAccountResolver,
  type GoogleLoginNonceRecord,
  type GoogleLoginNonceStore,
} from '@maronn-openid-connect/google-login';
import { transactionStore, authSessionStore, browserSessionStore, buildSessionCookie, userStore } from './store.js';
import { defaultProviderConfig } from './config.js';

const googleLoginConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID!,
  // Google Cloud コンソールの「承認済みのリダイレクト URI」と完全一致させる
  loginUri: new URL('/login/google', defaultProviderConfig.issuer).toString(),
};

// nonce → transaction_id の記録。core の AuthTransactionStore と同じ KV 契約
// （ここではインメモリ。TTL の扱いは consumeGoogleLoginNonce が期限を見るので省いてよい）
const nonceRecords = new Map<string, GoogleLoginNonceRecord>();
const googleLoginNonceStore: GoogleLoginNonceStore = {
  async get(key) {
    return nonceRecords.get(key) ?? null;
  },
  async put(key, record) {
    nonceRecords.set(key, record);
  },
  async delete(key) {
    nonceRecords.delete(key);
  },
};

// Google アカウント → OP の subject。sub をキーにし、email はキーにしない。
// findByGoogleSubject はアプリ側のユーザーストアに用意する（生成コードの userStore には無い）
const googleAccountResolver: GoogleAccountResolver = {
  async resolveSubject(account) {
    return (await userStore.findByGoogleSubject(account.sub))?.sub ?? null;
  },
};

export const googleLoginApp = new Hono();

// ログイン画面（GET /login）でボタンを描画する部分
export async function renderGoogleSignInButton(transactionId: string): Promise<string> {
  const transaction = await getAuthTransaction(transactionId, transactionStore);
  const nonce = await issueGoogleLoginNonce({
    transactionId,
    expiresAt: transaction.expiresAt,
    store: googleLoginNonceStore,
  });
  return buildGoogleSignInMarkup({
    ...googleLoginConfig,
    nonce,
    loginHint: transaction.loginHint, // OIDC Core 1.0 §3.1.2.1
  });
}

// login_uri（POST /login/google）
googleLoginApp.post('/', async (c) => {
  let login;
  try {
    // verifier を省略すると、プロセス共有の google-auth-library 版が使われる
    login = await handleGoogleLoginRedirect({
      params: await c.req.parseBody(),
      cookieHeader: c.req.header('Cookie') ?? null,
      clientId: googleLoginConfig.clientId,
      nonceStore: googleLoginNonceStore,
    });
  } catch (error) {
    if (!(error instanceof GoogleLoginError)) throw error;
    return c.text(error.message, error.httpStatusCode as 400);
  }

  const transaction = await getAuthTransaction(login.transactionId, transactionStore);
  const subject = await resolveGoogleLoginSubject(login.account, googleAccountResolver);

  // ここから先はユーザー名 + パスワードのログイン成功時と同じ
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject, authTime });
  c.header('Set-Cookie', buildSessionCookie(sessionId));
  await authSessionStore.set(login.transactionId, { subject, authTime, sessionId });

  const consentUrl = new URL('/consent', defaultProviderConfig.issuer);
  consentUrl.searchParams.set('transaction_id', login.transactionId);
  return c.redirect(consentUrl.toString());
});
```

`prompt=login` / `select_account` の扱い、`max_age` による再認証、同意ステップは既存のログインルートの実装をそのまま使う。`GoogleLoginError` を `AuthTransactionError` と同じ catch 節で処理する場合は `error.httpStatusCode` をそのまま使える。

プロキシ経由でしか Google に到達できない環境では、`createGoogleIdTokenVerifier({ clientOptions: { transporterOptions: { ... } } })` で作った verifier を `handleGoogleLoginRedirect` の `verifier` に渡す（`OAuth2Client` のオプションはそのまま通る）。

### `transaction-binding` を有効にした生成コードとの併用

`--enable transaction-binding` の束縛 Cookie は `SameSite=Lax` で発行される。Google からの POST はクロスサイトの遷移なので、ブラウザは Lax の Cookie をこの POST に付けない。`login_uri` のルートで `validateTransactionBinding` を呼ぶ場合は、束縛 Cookie を `SameSite=None; Secure` で発行し直すか、このルートでは束縛検証の代わりに nonce の単回使用を束縛とみなす、のどちらかを選ぶ。

## 検証内容とドキュメントの対応

| Google のドキュメントの条件 | 実装 |
|---|---|
| Google の公開鍵で署名を検証する。鍵はローテーションされるため `Cache-Control` を見て再取得する | `google-auth-library`（`OAuth2Client.verifyIdToken`） |
| `aud` がアプリのクライアント ID と同じ | `google-auth-library`（`verifyIdToken` の `audience`） |
| `iss` が `accounts.google.com` または `https://accounts.google.com` | `google-auth-library` |
| `exp` が経過していない | `google-auth-library`（`iat` が未来でないことも含む） |
| （任意）`hd` でホストされたドメインを確認する | `validateGoogleHostedDomain` |
| `g_csrf_token` の Cookie と POST 本文を突き合わせる（Double Submit Cookie） | `validateGoogleCsrfToken` |
| ユーザーの識別子には `sub` を使う（`email` は変わりうる） | `GoogleAccountResolver` に `sub` を含む検証済みペイロードを渡す |

tokeninfo エンドポイント（`https://oauth2.googleapis.com/tokeninfo`）は使わない。ドキュメントが本番環境での利用を推奨していない（レイテンシとネットワークエラーの可能性）ため、ライブラリがローカルで署名を検証する。

## テスト

`google-auth-library` が公開鍵を取りに行くエンドポイント（`OAuth2Client` の `endpoints` オプション）をローカルの HTTP サーバーに向け、テスト用の RSA 鍵で署名した ID トークンをライブラリ本体に検証させる。ライブラリの拒否が `GoogleLoginError` に写ること、検証を通ったペイロードがそのまま返ること、Double Submit Cookie と nonce の束縛が仕様どおりに動くことを確認する。

## 制限事項

- **Node.js 22 以上のみ。** `google-auth-library` の要件。エッジランタイムで動かしたい場合は `GoogleIdTokenVerifier` を Web 標準 API だけで実装して差し替える必要がある（このパッケージは提供しない）
- **redirect mode のみ。** popup mode / One Tap の JavaScript コールバック（`callback`）で受け取った credential をブラウザから別途送る構成は対象外。ただし `verifyGoogleIdToken` 単体は、どの経路で受け取った Google の ID トークンにも使える
- **CLI 未統合。** `--enable google-login` での生成は今後の対応。それまでは上記の配線を手で行う
- `login_uri` へ届く POST の本文解析と Cookie の発行は行わない（core と同じく呼び出し側の責務）

## ライセンス

MIT
