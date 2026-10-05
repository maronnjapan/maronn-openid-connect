---
title: CLI Guide
description: Generate OpenID Provider code with the maronn-oidc CLI.
---

`@maronn-openid-connect/cli` は、Authorization Code Flow（OAuth 2.1 / OIDC Core 1.0 準拠）を実装した OP コード一式を生成する CLI ツールです。生成コードは `@maronn-openid-connect/core` のロジックを HTTP に配線したもので、利用者はこのコードを改造しながら仕様を検証します。

生成される各エンドポイント（`routes/authorize.ts` / `token.ts` / `userinfo.ts` / `introspection.ts` / `revocation.ts`）は、core の合成関数を1回呼ぶ形ではなく、クライアント認証・クライアント解決・期限・redirect URI・PKCE・scope・再利用検知・ID Token クレーム構築などの機能単位ステップを順に呼び出す形で生成されます。必要なステップを消す、独自検証を間に足す、ID Token に独自クレームを足す、といった PoC 向けの改修を生成コード上で直接行えます。

## Commands

```bash
# コード生成
maronn-oidc generate <framework> [options]

# 生成 + 既存エントリファイルへの組み込み（Next.js 以外）
maronn-oidc setup <framework> [options]
```

対応フレームワーク: `hono`, `express`, `fastify`, `nextjs`

`setup` は生成に加えて、エントリファイル内のプレースホルダーコメント（`// <!-- OIDC_IMPORT_PLACEHOLDER -->` と `// <!-- OIDC_SETUP_PLACEHOLDER -->`）を `applyOidc` の import と呼び出しに置換します。Next.js は App Router のファイル規約に従うため `setup` 非対応で、`maronn-oidc generate nextjs --output ./src/app` を使います。

### setup に必要なプレースホルダー

`setup` は、エントリファイルに次の 2 種のコメントが**両方**書かれていることを前提とします。

```typescript
import { Hono } from 'hono';
// <!-- OIDC_IMPORT_PLACEHOLDER -->
const app = new Hono();
// <!-- OIDC_SETUP_PLACEHOLDER -->
```

- 2 種のうち片方でも欠けている場合、`setup` は**エントリファイルを一切書き換えずに**エラーを表示し、終了コード 1 で終わります。片方だけを置換すると、OP がマウントされないまま成功したように見えたり、import の無い `applyOidc(app);` が書き込まれてエントリファイルが型検査を通らなくなるためです。エラーには欠けているプレースホルダー名と記述例が表示されるので、追記して `setup` を再実行してください。なお、コード生成自体は配線判定より前に完了しているため、生成物は出力先に残ります。
- 既に `applyOidc` の import と呼び出しが両方存在する場合（＝一度 `setup` 済み）は、`Already patched (no changes):` と表示してファイルを書き換えずに成功終了します。`setup` の再実行は安全です。

## Options

| オプション | 説明 |
|---|---|
| `--output, -o <dir>` | 出力先ディレクトリ（既定: `./oidc-provider`） |
| `--entry, -e <file>` | setup 時にパッチするエントリファイル（既定: `./src/index.ts`） |
| `--enable <features>` | 有効化する機能（カンマ区切り・複数回指定可） |
| `--disable <features>` | 既定セットから外す機能（カンマ区切り・複数回指定可） |
| `--scope <scopes>` | 生成 OP が受け付けるカスタムスコープ（カンマ区切り・複数回指定可） |
| `--force` | 出力先に既にあるファイルを上書きする |
| `--dry-run` | 書き込みを行わず、出力予定のファイル一覧（新規か上書きか）を表示する |
| `--help, -h` | ヘルプ表示 |

## Overwrite Protection

出力先に生成対象と同名のファイルが 1 つでもある場合、`generate` / `setup` は**何も書き込まずに**そのファイル一覧を表示し、終了コード 1 で終わります。生成コードは改造して使うことが前提のため、`-o` の指定ミスや機能フラグを変えた再実行が、改造済みの `config.ts` や `store.ts` を無警告で潰さないようにしています。

```
Error: 2 file(s) already exist in ./oidc-provider:
  config.ts
  store.ts

Re-run with --force to overwrite them, or use -o <dir> to generate into a new directory.
Tip: commit the generated files before overwriting so you can diff your changes.
```

- 上書きするには `--force` を明示します。ログは新規作成が `Created:`、上書きが `Overwritten:` で区別されます
- `--dry-run` は何も書き込まず、出力予定の全ファイルを `Would create:` / `Would overwrite:` で表示します。`--force` の前に影響範囲を確認する用途を想定しています
- 再生成する予定があるなら、**生成直後にコミットしてから改造してください**。`--force` で上書きしても、自分の変更を `git diff` で取り戻せます

## Generated Files

```
oidc-provider/
├── app.ts / apply.ts     # OP 本体と既存アプリへの組み込み関数
├── config.ts             # ProviderConfig・クライアント登録（既定値はローカル検証専用）
├── scopes.ts             # スコープポリシー（--scope 指定時のみ）
├── store.ts              # インメモリストア（認可コード・トークン・セッション等）
├── resolvers.ts          # セッション・同意状態の resolver
├── views.ts              # ログイン / 同意 / エラー画面のデフォルト HTML（Hono は views.tsx の JSX コンポーネント）
├── pages/                # 画面用ルーティング（ブラウザ向けの GET/POST。描画・リダイレクト・Cookie 付与はすべてここ。UI カスタマイズはここ）
├── routes/               # API ルーティング（ロジック本体。ブラウザ向けステップは Response を返さず結果（outcome）を返す関数）
├── conformance.test.ts   # 生成 OP の想定挙動を固定する契約テスト
└── .maronn-openid-connect.json  # 生成元の CLI バージョンと機能構成の記録
```

Next.js は App Router のファイル規約に沿った別の構成になります（[Next.js](#nextjs) を参照）。

### Screen Routes (pages/) and API Routes (routes/)

生成されるルーティングは 2 種類に分かれています。ブラウザに返すもの（画面の描画・リダイレクト・Cookie の付与）はすべて `pages/` が担当し、`routes/` は Response を一切作りません。UI をカスタマイズするときに触るのは `pages/`（と `views.ts`、Hono は `views.tsx`）だけで、`routes/` のロジックは読まなくて済みます。以下の `pages/login.ts` などのファイル名は、Hono では `authorize.ts` と `respond.ts` を除いて `.tsx` になります（[Hono Screens](#hono-screens-honojsx) を参照）。

| 層 | ファイル | 役割 |
|---|---|---|
| 画面用ルーティング | `pages/authorize.ts` / `pages/login.ts` / `pages/consent.ts` / `pages/errors.ts` / `pages/respond.ts`（機能有効時: `pages/device.ts` / `pages/ciba.ts` / `pages/logout.ts`） | ブラウザ向けのルートは **GET も POST も** ここにあります（`GET\|POST /authorize`・`GET\|POST /login`・`GET\|POST /consent` など）。リクエストを読み、`routes/` の関数を 1 回呼び、返ってきた結果（outcome）を画面かリダイレクトに変換します。ロジックは持ちません |
| API ルーティング | `routes/*.ts` | OIDC のロジック本体。`token` / `userinfo` などの JSON エンドポイントはルーターのままです。ブラウザ向けの各ステップ（`authorize` / `login` / `consent` / `device` / `ciba-verification` / `logout`）は Response を返さない関数（`processAuthorizationRequest()` / `prepareLogin()` / `submitLogin()` / `submitConsent()` など）で、結果を `kind` 付きの outcome（リダイレクト先 `location`、付与する `cookies`、画面データ、またはエラー）として返します。描画・リダイレクト・`Set-Cookie`・`c.json()` は一切行わず、`views.ts` も `pages/` も import しません |

たとえば `POST /login` は `pages/login.ts` がフォームを読んで `submitLogin()` を呼び、`{ kind: 'authenticated', cookies }` なら Cookie を付けて `/consent` へ 302、`{ kind: 'invalid_credentials' }` ならフォームを再表示、`{ kind: 'locked_out' }` なら 429 のエラー画面、という変換だけを行います。ステータスコード・Cookie・リダイレクト先といった HTTP の契約は `conformance.test.ts` が固定します。

UI を変える場所は、変えたい範囲で選びます。

- **HTML だけ変える** → `views.ts`（Hono は `views.tsx`）の `default*Page` を書き換えるか、`createApp` / `applyOidc` の `views` オプションで差し替える
- **描画の仕方を変える**（テンプレートエンジン、フレームワークネイティブの Response、別に用意した UI へのリダイレクト）→ `pages/*.ts` の `render*Page()` と outcome を変換している箇所を書き換える。画面を返す経路はすべて `pages/` を通るので、`GET /login` もログイン失敗時の再表示も一緒に変わる
- **画面遷移を変える**（ログイン後の遷移先、エラー時の見せ方など）→ `pages/*.ts` で `redirectWithCookies()` / `withCookies()`（`pages/respond.ts`）を呼んでいる箇所。付けるべき Cookie は outcome の `cookies` にそのまま入っている
- **非リダイレクトの認可エラー（OIDC Core 1.0 §3.1.2.2）の見せ方を変える** → `pages/errors.ts` の `renderAuthorizationErrorPage()`

フォームの `name`（`csrf_token` / `username` / `password`、同意の `action=approve|deny`）は `pages/` が `routes/` の関数へ渡す入力なので、画面を差し替えても維持してください。フォームに認可トランザクションの ID は入りません（[Auth Transaction](#auth-transaction-cookie--csrf_token) を参照）。トランザクション Cookie と `csrf_token` の照合や `google-login` のボタン設定（`buildGoogleSignIn()`）は判断なので `routes/login.ts` / `routes/consent.ts` にあり、`pages/` は返ってきた結果を描くだけで済みます。

### Next.js

Next.js では、App Router の機能をそのまま使ったコードを `--output`（例: `./src/app`）へ生成します。共通のルーターや独自のコンテキストは挟まず、エンドポイントごとの Route Handler にその処理を上から順に書いています。`/token` の挙動を知りたければ `token/route.ts` だけを読めば済みます。

```
src/app/
├── _oidc-provider/           # 全エンドポイントが共有する部品（private folder なのでルーティングされない）
│   ├── provider.ts           # 設定・クライアント・署名鍵・ストアの組み立て。プロジェクトへ組み込むときに編集する場所
│   ├── http.ts               # CORS・キャッシュ禁止の JSON 応答・パラメータ重複の検出・エラーページへのリダイレクトなど、Route Handler と Server Action 共通の部品
│   ├── transaction.ts        # ログイン・同意が続ける認可トランザクションを Cookie から取得（無ければ notFound()）
│   ├── error-view.tsx        # エラー画面の共通レイアウト（oidc-error・not-found・error の各画面が使う）
│   ├── config.ts / store.ts / resolvers.ts  # 他のフレームワークと共通の設定型・ストア・resolver
│   ├── storage-backend.ts    # Vercel 向け Upstash Redis REST とローカル SQLite のストア
│   └── conformance.test.ts   # 契約テスト
├── authorize/route.ts        # GET|POST /authorize（検証パイプラインをこのファイルに直接書いている）
├── token/route.ts            # POST /token
├── userinfo/route.ts         # GET|POST /userinfo
├── introspect/route.ts       # POST /introspect（introspection 有効時）
├── revoke/route.ts           # POST /revoke（revocation 有効時）
├── .well-known/openid-configuration/route.ts
├── .well-known/jwks.json/route.ts
├── login/page.tsx            # ログイン画面（React Server Component）
├── login/actions.ts          # ログインの Server Action
├── login/session.ts          # OP セッションの開始（パスワードログインと Google ログインで共有）
├── login/not-found.tsx       # トランザクションが無いとき（notFound()）の画面。HTTP 404
├── login/error.tsx           # 想定外の例外のときの画面（error boundary）
├── consent/page.tsx          # 同意画面
├── consent/actions.ts        # 同意の Server Action（認可コードを発行してクライアントへリダイレクト）
├── consent/not-found.tsx / consent/error.tsx  # 同意画面の not-found / error（ログイン画面と同じ役割）
└── oidc-error/page.tsx       # クライアントへ返してはいけないエラーの表示先
```

各 `route.ts` は `GET` / `POST` / `OPTIONS` などの HTTP メソッドを自分で export します。ログイン・同意画面は React のページと Server Action なので、見た目は `page.tsx`、判断は `actions.ts` を書き換えます。device / CIBA / RP-Initiated Logout の画面は、表示と同時に Cookie を発行し、403 や 429 などのステータスを返す必要があります。Server Component はどちらもできないため、これらは HTML を返す Route Handler（描画は各ディレクトリの `screens.ts`）として生成します。実験的機能の設定は、それを使うコードの隣に置きます（例: `par/config.ts`、トークンエンドポイントの grant なら `token/token-exchange.ts` の `tokenExchangeConfig`）。認可エンドポイントと同意の両方が読む JARM の設定は `_oidc-provider/jarm.ts` にあります。

OP がブラウザを止める場面は、Next.js の機能で表します。

- 進行中の認可リクエストが無い（トランザクション Cookie が無い、または Cookie が指すトランザクションが不明・完了済み・期限切れ）: ページと Server Action が `notFound()` を呼び、隣の `not-found.tsx` を HTTP 404 で表示します。利用者はクライアントからやり直すしかありません
- クライアントへ返してはいけないエラー（OIDC Core 1.0 §3.1.2.2。未登録の `redirect_uri`、CSRF トークンの不一致、ログイン試行回数の上限、判断を含まない同意の POST、Google ログインのコールバックの失敗など）: `redirect()` で `oidc-error/page.tsx` へ送ります。Route Handler からは 303 でリダイレクトします
- 想定外の例外（ストアの障害など）: `error.tsx`（error boundary）が表示します。本番の Next.js はエラーメッセージをブラウザへ渡さないので、画面にはサーバーログと突き合わせられる `digest` だけを出します

これらの画面はどれも `_oidc-provider/error-view.tsx` の `ErrorView` で描くので、見た目はそこを書き換えれば揃って変わります。device / CIBA / RP-Initiated Logout の画面のエラーは、ステータスコード（403 / 429 など）を保つため、画面と同じく `_oidc-provider/html.ts` の HTML で返します。

Next.js は Route Handler とページ・Server Action を別々のモジュール層にバンドルします。両方から同じインスタンスを参照する必要があるストアと署名鍵は、`globalThis` に保持しています（`provider.ts` / `storage-backend.ts`）。

設定は環境変数から読みます。

| 環境変数 | 用途 |
|---|---|
| `OIDC_ISSUER` | issuer。OP 自身の URL はすべてこれを基準に組み立てる |
| `OIDC_CLIENTS_JSON` | 登録クライアント（`RegisteredClient` の JSON 配列）。未指定なら `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_CLIENT_REDIRECT_URI` の 1 クライアント |
| `OIDC_SIGNING_KEY_ID` | 起動時に生成する署名鍵の `kid` |
| `OIDC_CORS_ORIGINS` | トークンエンドポイントなどをブラウザから呼べるオリジン（既定は issuer） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Vercel で使うストア。未指定ならローカル SQLite（`OIDC_SQLITE_PATH`、既定 `.data/oidc.sqlite`） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_HOSTED_DOMAIN` | Sign in with Google（`google-login` 有効時） |

契約テスト `_oidc-provider/conformance.test.ts` は、Route Handler・ページ・Server Action を Next.js と同じ形で直接呼び出します。リクエストの中でしか使えない `cookies()`（`next/headers`）と `redirect()` / `notFound()`（`next/navigation`）だけを差し替えているので、サーバーを起動せずに `vitest run` で実行できます（`vitest` を devDependencies に追加してください）。

### Hono Screens (hono/jsx)

Hono の出力は TSX 前提で生成されます。画面のマークアップ（`views.tsx`）は [hono/jsx](https://hono.dev/docs/guides/jsx) のコンポーネントで、画面を描く `pages/`（`errors` / `login` / `consent`、機能有効時は `device` / `ciba` / `logout`）も `.tsx` になり、`renderView(<views.loginPage {...params} />)` のように JSX でビューを描画します。HTML を返さない `pages/authorize.ts` と `pages/respond.ts` は `.ts` のままです。JSX は `{...}` で埋め込んだ値をすべてエスケープするので、`login_hint` や `error_description` のような信頼できない値も手でエスケープせずに描画できます。

ビューは JSX 要素を返すコンポーネントです。`createApp` / `applyOidc` の `views` オプションで差し替えるときも、JSX で書きます。

```tsx
const app = createApp({
  views: {
    loginPage: (params) => <MyLoginPage {...params} />,
  },
});
```

別の手段で組み立てた HTML を返すときは `hono/html` の `html` タグか `raw()` で包みます（`raw()` は渡した文字列をそのまま信頼するので、エスケープ済みの HTML だけを渡してください）。ステータスやヘッダーなど Response そのものを変えたいときは、`pages/*.tsx` の `render*Page()` を書き換えます。

コンパイルには `tsconfig.json` で JSX を有効にしておく必要があります。

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  }
}
```

### Generation Manifest (.maronn-openid-connect.json)

生成物には、どの CLI バージョン・どの入力から生成されたかを記録するマニフェストが含まれます。

```json
{
  "cliVersion": "0.5.0",
  "framework": "hono",
  "features": { "pkce": true, "refreshToken": true, "...": "..." },
  "scopes": []
}
```

このライブラリはテンプレートへ仕様修正（多くはセキュリティ修正）を継続的に入れています。手元の生成コードへ修正を取り込むか判断するときは、`cliVersion` と [リリースノート](https://github.com/maronnjapan/maronn-openid-connect/releases) を突き合わせ、生成元の版と最新版の差分を確認してください。マニフェストは利用者が編集するファイルではないため、上書き保護の対象外として生成のたびに更新されます（生成日時は含めず、同じ入力からは同じ出力になります）。

## Auth Transaction (Cookie + csrf_token)

`/authorize` から `/login`・`/consent` へ認可リクエストを引き継ぐ認可トランザクションの ID は、URL にも HTML にも載せません。どのフレームワーク・どの機能構成でも同じで、トグルはありません。

- `/authorize` はトランザクションを作ると、その ID を HttpOnly Cookie `oidc_txn`（`Secure; SameSite=Lax; Path=/; Max-Age=600`）でブラウザに渡し、クエリの無い `/login`（SSO で同意だけが残っている場合は `/consent`）へリダイレクトします
- `/login`・`/consent` は Cookie からトランザクションを引き、フォームには `csrf_token` だけを埋め込みます
- `POST /login`・`POST /consent` は、Cookie が指すトランザクションに対して、送られてきた `csrf_token` を照合します。Cookie と `csrf_token` のどちらか一方だけでは進めません
- 同意の結果（承認・拒否）をクライアントへ返すときに Cookie を消します

ID が URL に出ないので、ブラウザ履歴・アクセスログ・画面共有から漏れた ID で第三者に同意画面を開かれることはありません。攻撃者が自分のクライアントで始めたトランザクションへ被害者を誘導し、被害者の認可コードを攻撃者のクライアントへ届かせる攻撃（RP の `state` 検証では防げない）も、他のサイトから Cookie を設定できないため成立しません。OIDC Core 1.0 §3.1.2.3 / §3.1.2.4 は「認可リクエストを送った User-Agent の End-User」を認証・同意させることを前提にしていますが、その同一性を保証する手段は実装に委ねており、この Cookie がその手段です。

Cookie はブラウザに 1 つです。同じブラウザの別タブで新しい認可リクエストを始めると Cookie が置き換わり、先に開いていたタブのフォームは `csrf_token` が一致しないため拒否されます。古いタブから誤ったリクエストを完了させないための挙動です。

| 状況 | Hono / Express / Fastify | Next.js |
|---|---|---|
| Cookie が無い、または指すトランザクションが無い（不明・完了済み・期限切れ） | OP のエラー画面（400） | `not-found.tsx`（404） |
| `csrf_token` が Cookie のトランザクションのものではない | OP のエラー画面（403） | `oidc-error` へリダイレクト |

curl などで手動でフローを進めるときは Cookie を持ち回ってください（Hono / Express / Fastify の例）。

```bash
curl -sS -c jar.txt -o /dev/null 'http://localhost:3000/authorize?response_type=code&client_id=...&redirect_uri=...&scope=openid&code_challenge=...&code_challenge_method=S256'
curl -sS -b jar.txt http://localhost:3000/login
# ↑ 応答 HTML の csrf_token を控える
curl -sS -b jar.txt -c jar.txt -X POST http://localhost:3000/login \
  -d csrf_token=<控えた値> -d username=testuser -d password=password
```

## Feature Toggles

生成される OP の機能は、既定の全部入り構成から機能単位で増減できます。

```bash
# リフレッシュトークンとイントロスペクションを外した OP を生成
maronn-oidc generate hono --disable refresh-token,introspection

# PKCE を任意化（confidential client の非PKCEフローを許可）
maronn-oidc generate express --disable pkce
```

| 機能名 | 既定 | `--disable` 時の挙動 |
|---|---|---|
| `pkce` | 有効 | PKCE を任意化する（`allowNonPkceAuthorizationCodeFlow: true`）。明示的な confidential client の完全な非PKCEリクエストのみ許可され、public client や不正な PKCE 値は引き続き拒否される |
| `refresh-token` | 有効 | `refresh_token` grant を `unsupported_grant_type` で拒否。`offline_access` は付与されず、リフレッシュトークンは発行されない。discovery からも除去される |
| `introspection` | 有効 | RFC 7662 introspection エンドポイント（`/introspect`）を生成しない |
| `revocation` | 有効 | RFC 7009 revocation エンドポイント（`/revoke`）を生成しない |
| `request-object` | 有効 | `request` パラメータ（Request Object by value, OIDC Core 1.0 §6.1）を `request_not_supported` で拒否。discovery は `request_parameter_supported: false` を広告する |

Basic OP に必須の機能（authorize / token / userinfo / discovery / jwks / login / consent）はトグル対象外で、常に生成されます。
未知の機能名や、同じ機能を `--enable` と `--disable` の両方に指定した場合はエラーになります。

### Experimental Features

Experimental 機能は上記いずれとも別カテゴリで、**既定では無効**です。`--enable` で明示したときだけ生成され、実装は別 package の `@maronn-openid-connect/experimental` にあります。

```bash
maronn-oidc generate hono --enable par
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`@maronn-openid-connect/core` は `@maronn-openid-connect/experimental` の peerDependency なので、両方を入れてください（CLI のインストール案内も両方を出力します）。experimental のほうが速く更新されるため、バージョン番号が揃っていない状態は正常です。

| 機能名 | 既定 | 内容 | 準拠仕様 |
|---|---|---|---|
| `par` | 無効 | Pushed Authorization Requests エンドポイント（`/par`）と認可エンドポイントの `request_uri` 解決 | RFC 9126 |

API は安定しておらず、破壊的に変更されることがあります。詳細と注意点は [Experimental機能とは](../../experimental/) を参照してください。

### Extension Features

拡張機能は、OAuth / OIDC の仕様ではなく**ログイン手段**を生成コードに足すカテゴリで、**既定では無効**です。実装は別 package にあり、`--enable` で明示したときだけ生成コードから import されます。

```bash
maronn-oidc generate express --enable google-login
pnpm add @maronn-openid-connect/core @maronn-openid-connect/google-login
```

| 機能名 | 既定 | 内容 | 実装 package |
|---|---|---|---|
| `google-login` | 無効 | ログイン画面に「Google でログイン」（Sign in with Google、redirect mode）を追加し、Google が ID トークンを POST する `POST /login/google` を生成する。検証は Google 公式の `google-auth-library` に委ねる | `@maronn-openid-connect/google-login`（Node.js 22 以上限定） |

有効化しても `config.googleLogin` を渡すまでボタンは表示されません。設定手順・生成物・ユーザーの扱いは [Google ログイン（拡張）](../google-login/) を参照してください。

## Custom Scopes

標準スコープ（`openid` / `profile` / `email` / `address` / `phone` / `offline_access`）は生成 OP 自身が扱います。それ以外に受け付けるスコープは、生成時に `--scope` で宣言します。

```bash
maronn-oidc generate hono --scope reports.read,reports.write
```

宣言すると `scopes.ts`（スコープポリシー）が生成され、生成 OP は次のようになります。

- discovery の `scopes_supported` に宣言したスコープが載る
- 宣言していないスコープ値を要求した認可リクエストは `invalid_scope` で拒否される（RFC 6749 §3.3 / §4.1.2.1）
- ユーザーごとの絞り込みは、生成された `scopes.ts` に書く

宣言が 1 つも無ければ `scopes.ts` も許容リストのチェックも生成しないため、既定の生成物の挙動は変わりません。

許容リストのチェックは `applyOfflineAccessPolicy` の**後**に置かれます。付与条件を満たさない `offline_access` は OIDC Core 1.0 §11 に従ってそこで既に落ちているため、「無視する」挙動が `invalid_scope` に変わることはありません。`--enable device-authorization-grant` / `--enable ciba` を有効にした場合は、デバイス認可エンドポイントとバックチャネル認証エンドポイントにも同じ許容リストが適用されます。

### ユーザーごとの絞り込みは生成コードに書く

「誰にどのスコープを許すか」は CLI のオプションにしていません。運用ごとに条件（ロール、テナント、DB 参照）が違い、生成コードを改造しながら検証するというこのライブラリの使い方に合わないためです。代わりに、生成される `scopes.ts` に絞り込みの入口を用意し、判断が必要な全ステップから呼び出した状態で生成します。

```typescript
// scopes.ts（生成物）
export const RESTRICTED_SCOPE_SUBJECTS: Record<string, readonly string[]> = {
  'reports.read': ['alice'],   // 手早く絞るならここに書く
};

export async function resolveGrantableScopes(
  requested: readonly string[],
  subject: string,
): Promise<string[]> {
  // ロール・テナント・DB 参照など、複雑な条件はここに書く
  return requested.filter((scope) => { /* ... */ });
}
```

`resolveGrantableScopes()` は End-User が確定した後に呼ばれ、次の箇所からすでに `await` されています。async なので、DB / KV 参照へ置き換えても呼び出し側の変更は要りません。

| 呼び出し元 | タイミング |
|---|---|
| `routes/consent.ts` | 同意画面の表示内容と、承認時の付与スコープ |
| `routes/authorize.ts` | SSO fast path と `prompt=none`（同意画面を出さずに付与する経路） |
| `routes/device.ts` / `routes/ciba-verification.ts` | device / CIBA の承認ステップ（該当機能を有効にした場合） |

SSO と `prompt=none` では、**保存済み同意を引く前**にポリシーを適用します。絞る前の scope で同意を探すと、そのユーザーが持てないスコープをキーに検索することになり、いつまでも一致しないためです。

落としたスコープはリクエストを失敗させず、付与スコープを狭めます。RFC 6749 §3.3 が要求より狭いスコープの発行を認めており、トークンレスポンスの `scope` に実際の付与内容が載ります。リクエストごと拒否したい場合は、呼び出し元で throw してください。

なお、カスタムスコープに対応する UserInfo クレームはありません（OIDC Core 1.0 §5.4 が定義するのは profile / email / address / phone のみ）。独自クレームを返す場合は `routes/userinfo.ts` を編集してください。

## Contract Test (conformance.test.ts)

生成物には、選択した機能構成に合わせた契約テスト `conformance.test.ts` が含まれます。生成 OP がこのリポジトリの想定する Basic OP 挙動を満たすことを固定するテストで、無効化した機能については「無効であること」（404 応答、`unsupported_grant_type` / `request_not_supported` の拒否、discovery メタデータの不在など）を検証します。

生成コードは自由にカスタマイズできますが、このテストが通らなくなった場合は担保対象の挙動から外れている可能性があります。

## After Generation

1. ProviderConfig・署名鍵・クライアント resolver を環境変数 / DB / KV から供給する
2. `config.ts` のデフォルト値はローカル検証専用として扱う
3. 依存をインストールしてサーバーを起動する（例: `pnpm add hono @maronn-openid-connect/core`）

Next.js では 1 と 2 を `_oidc-provider/provider.ts` で行います（クライアント・署名鍵・ストアの差し替え先がこのファイルに集まっています）。

具体的な組み込み手順は [Quick Start](../../quick-start/) を参照してください。
