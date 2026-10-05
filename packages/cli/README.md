# @maronn-openid-connect/cli

OpenID Connect Provider のコードを生成する CLI ツール。
Hono / Express / Fastify / Next.js 向けに、Authorization Code Flow（OAuth 2.1 / OIDC Core 1.0 準拠）を実装した OP コード一式を生成する。

生成コードは [`@maronn-openid-connect/core`](../core) のロジックを HTTP に配線したもので、利用者はこのコードを改造しながら「自分の要件がこの仕様で実現できるか」を検証する。

生成されるエンドポイントは、core の機能単位ステップ関数を 1 ステップ = 1 関数呼び出しの形で並べる。
各ステップが生成コード上に見えているため、不要な検証を消したり、ステップの間に独自処理を足したりして仕様の挙動を検証しやすい。

| 生成ファイル | 並べているステップ |
|---|---|
| `routes/authorize.ts` | 認可リクエスト検証（`resolveClientForAuthorization` → `validateResponseType` → `validateAuthorizationCodePkce` ほか）と `prompt=none`（`resolvePromptNoneSession` → `validatePromptNoneIdTokenHint` → `validatePromptNoneConsent`） |
| `routes/token.ts` | クライアント認証（`extractClientCredentials` → `validateClientAuthMethod` → `verifyClientSecret`）、grant 検証（`resolveAuthorizationCode` → `validateAuthorizationCodeExpiration` → `verifyAuthorizationCodePkce` ほか）、レスポンス生成（`buildAccessTokenPayload` → `computeAtHash` → `resolveAcrAmr` → `buildIdTokenPayload` → `generateIdToken`） |
| `routes/userinfo.ts` | `resolveUserInfoAccessToken` → `validateUserInfoTokenExpiration` → `validateUserInfoScope` → `validateUserInfoAudience` → `resolveUserInfoClaims` → `filterClaimsByScope` → `applyRequestedClaims` |
| `routes/introspection.ts` | `requireIntrospectionToken` → `requireIntrospectionClient` → `resolveIntrospectionToken` → `isIntrospectionTokenActive` → `buildIntrospectionResponse` |
| `routes/revocation.ts` | `requireRevocationToken` → `requireRevocationClient` → `resolveRevocationTarget` → `validateRevocationTokenClient` → `revokeResolvedToken` → `revokeGrantAccessTokens` |

ID Token へ独自クレームを足すなら `routes/token.ts` の `buildIdTokenPayload` の戻り値を署名前に書き換える、といった改修が生成コード上で完結する。ただし検証ステップを消した構成は `conformance.test.ts`（契約テスト）が失敗し、Basic OP の想定挙動から外れたことを検知できる。

## インストールと実行

```bash
# インストールせずに実行
pnpm dlx @maronn-openid-connect/cli generate hono

# またはプロジェクトに追加してから実行
pnpm add -D @maronn-openid-connect/cli
pnpm maronn-oidc generate hono
```

## 使い方

```bash
# コード生成
maronn-oidc generate <framework> [options]

# 生成 + 既存エントリファイルへの組み込み（Next.js 以外）
maronn-oidc setup <framework> [options]
```

対応フレームワーク: `hono`, `express`, `fastify`, `nextjs`

`setup` は生成に加えて、エントリファイル内のプレースホルダーコメント（`// <!-- OIDC_IMPORT_PLACEHOLDER -->` と `// <!-- OIDC_SETUP_PLACEHOLDER -->`）を `applyOidc` の import と呼び出しに置換する。Next.js は App Router のファイル規約に従うため `setup` 非対応で、`maronn-oidc generate nextjs --output ./src/app` を使う。

### オプション

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

### 既存ファイルの上書き保護

出力先に生成対象と同名のファイルが 1 つでもある場合、`generate` / `setup` は**何も書き込まずに**そのファイル一覧を表示して終了コード 1 で終わる。改造済みの `config.ts` や `store.ts` を再実行で失わないためで、上書きするには `--force` を明示する（ログは新規が `Created:`、上書きが `Overwritten:` になる）。事前に結果を確認したいときは `--dry-run` を使う。

再生成する予定があるなら、生成直後にコミットしてから改造すること。`--force` で上書きしても、自分の変更を `git diff` で取り戻せる。

## 生成されるもの

```
oidc-provider/
├── app.ts / apply.ts     # OP 本体と既存アプリへの組み込み関数
├── config.ts             # ProviderConfig・クライアント登録（既定値はローカル検証専用）
├── store.ts              # インメモリストア（認可コード・トークン・セッション等）
├── resolvers.ts          # セッション・同意状態の resolver
├── views.ts              # ログイン / 同意 / エラー画面のデフォルト HTML（Hono は views.tsx の JSX コンポーネント）
├── pages/                # 画面用ルーティング（ブラウザ向けの GET/POST。描画・リダイレクト・Cookie 付与はすべてここ。UI カスタマイズはここ）
├── routes/               # API ルーティング（ロジック本体。ブラウザ向けステップは Response を返さず結果（outcome）を返す関数）
├── conformance.test.ts   # 生成 OP の想定挙動を固定する契約テスト
└── .maronn-openid-connect.json  # 生成元の CLI バージョンと機能構成の記録
```

Next.js は App Router のファイル規約に沿った別の構成になる（[Next.js の生成物](#nextjs-の生成物)を参照）。

Hono の出力は TSX 前提で生成される。画面のマークアップ（`views.tsx`）は [hono/jsx](https://hono.dev/docs/guides/jsx) のコンポーネントで、画面を描く `pages/`（`errors` / `login` / `consent`、機能有効時は `device` / `ciba` / `logout`）も `.tsx` になり、`renderView(<views.loginPage {...params} />)` のように JSX でビューを描画する。HTML を返さない `pages/authorize.ts` と `pages/respond.ts` は `.ts` のまま。JSX は `{...}` で埋め込んだ値をすべてエスケープするので、`login_hint` や `error_description` のような信頼できない値も手でエスケープせずに描画できる。

ビューは JSX 要素を返すコンポーネントで、`createApp` / `applyOidc` の `views` オプションで差し替えるときも `loginPage: (params) => <MyLoginPage {...params} />` のように書く。別の手段で組み立てた HTML を返すときは `hono/html` の `html` タグか `raw()` で包む（`raw()` は渡した文字列をそのまま信頼するので、エスケープ済みの HTML だけを渡す）。ステータスやヘッダーなど Response そのものを変えたいときは、`pages/*.tsx` の `render*Page()` を書き換える。

コンパイルには `tsconfig.json` で JSX を有効にしておく必要がある。

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  }
}
```

`.maronn-openid-connect.json` は、どの CLI バージョン・どの機能構成（`framework` / `features` / `scopes`）から生成されたかを記録するマニフェスト。テンプレートへ仕様修正が入ったとき、リリースノートと突き合わせて「自分のコードがどの版から生成されたか」を特定する起点になる。利用者が編集するファイルではないため、上書き保護の対象外として毎回更新される（生成日時は含めず、同じ入力からは同じ出力になる）。

生成される OP のエンドポイント:

| パス | 役割 |
|---|---|
| `/authorize` | 認可エンドポイント（`response_type=code`、PKCE S256、`prompt` / `max_age` / `claims` / Request Object 対応） |
| `/token` | トークンエンドポイント（`authorization_code` / `refresh_token` グラント、`client_secret_basic` / `client_secret_post` / public client） |
| `/userinfo` | UserInfo エンドポイント（Bearer トークン、scope 別クレーム） |
| `/login`, `/consent` | ログイン・同意画面。ルート（GET / POST）と描画は `pages/`、認証・同意の判断は `routes/` の関数が担当する（差し替え可能なデフォルト UI 付き。Next.js はページと Server Action） |
| `/login/google` | Sign in with Google の `login_uri`（Google が ID トークンを POST する先。`google-login` 有効時） |
| `/.well-known/openid-configuration` | Discovery メタデータ |
| `/.well-known/jwks.json` | JWKS（公開鍵） |
| `/introspect` | RFC 7662 Token Introspection（`introspection` 有効時） |
| `/revoke` | RFC 7009 Token Revocation（`revocation` 有効時） |

## 画面用ルーティング（pages/）と API ルーティング（routes/）

生成されるルーティングは 2 種類に分かれている。ブラウザに返すもの（画面の描画・リダイレクト・Cookie の付与）はすべて `pages/` が担当し、`routes/` は Response を一切作らない。UI をカスタマイズするときに触るのは `pages/`（と `views.ts`、Hono は `views.tsx`）だけで、`routes/` のロジックは読まなくてよい。以下の `pages/login.ts` などのファイル名は、Hono では `authorize.ts` と `respond.ts` を除いて `.tsx` になる。

| 層 | ファイル | 役割 |
|---|---|---|
| 画面用ルーティング | `pages/authorize.ts` / `pages/login.ts` / `pages/consent.ts` / `pages/errors.ts` / `pages/respond.ts`（機能有効時: `pages/device.ts` / `pages/ciba.ts` / `pages/logout.ts`） | ブラウザ向けのルートは **GET も POST も** ここにある（`GET\|POST /authorize`・`GET\|POST /login`・`GET\|POST /consent` など）。リクエストを読み、`routes/` の関数を 1 回呼び、返ってきた結果（outcome）を画面かリダイレクトに変換する。ロジックは持たない |
| API ルーティング | `routes/*.ts` | OIDC のロジック本体。`token` / `userinfo` などの JSON エンドポイントはルーターのまま。ブラウザ向けの各ステップ（`authorize` / `login` / `consent` / `device` / `ciba-verification` / `logout`）は Response を返さない関数（`processAuthorizationRequest()` / `prepareLogin()` / `submitLogin()` / `submitConsent()` など）で、結果を `kind` 付きの outcome（リダイレクト先 `location`、付与する `cookies`、画面データ、またはエラー）として返す。描画・リダイレクト・`Set-Cookie`・`c.json()` は一切行わず、`views.ts` も `pages/` も import しない |

たとえば `POST /login` は `pages/login.ts` がフォームを読んで `submitLogin()` を呼び、`{ kind: 'authenticated', cookies }` なら Cookie を付けて `/consent` へ 302、`{ kind: 'invalid_credentials' }` ならフォームを再表示、`{ kind: 'locked_out' }` なら 429 のエラー画面、という変換だけを行う。ステータスコード・Cookie・リダイレクト先といった HTTP の契約は `conformance.test.ts` が固定している。

UI を変える場所は、変えたい範囲で選ぶ。

- **HTML だけ変える** → `views.ts`（Hono は `views.tsx`）の `default*Page` を書き換えるか、`createApp` / `applyOidc` の `views` オプションで差し替える
- **描画の仕方を変える**（テンプレートエンジン、フレームワークネイティブの Response、別に用意した UI へのリダイレクト）→ `pages/*.ts` の `render*Page()` と outcome を変換している箇所を書き換える。画面を返す経路はすべて `pages/` を通るので、`GET /login` もログイン失敗時の再表示も一緒に変わる
- **画面遷移を変える**（ログイン後の遷移先、エラー時の見せ方など）→ `pages/*.ts` で `redirectWithCookies()` / `withCookies()`（`pages/respond.ts`）を呼んでいる箇所。付けるべき Cookie は outcome の `cookies` にそのまま入っている
- **非リダイレクトの認可エラー（OIDC Core 1.0 §3.1.2.2）の見せ方を変える** → `pages/errors.ts` の `renderAuthorizationErrorPage()`

フォームの `name`（`transaction_id` / `csrf_token` / `username` / `password`、同意の `action=approve|deny`）は `pages/` が `routes/` の関数へ渡す入力なので、画面を差し替えても維持する。transaction-binding の束縛チェック（`rejectUnboundTransaction()`）や google-login のボタン設定（`buildGoogleSignIn()`）は判断なので `routes/login.ts` / `routes/consent.ts` にあり、`pages/` は返ってきた結果を描くだけでよい。

## Next.js の生成物

Next.js では、App Router の機能をそのまま使ったコードを `--output`（例: `./src/app`）へ生成する。共通のルーターや独自のコンテキストは挟まず、エンドポイントごとの Route Handler にその処理を上から順に書いている。`/token` の挙動を知りたければ `token/route.ts` だけを読めばよい。

```
src/app/
├── _oidc-provider/           # 全エンドポイントが共有する部品（private folder なのでルーティングされない）
│   ├── provider.ts           # 設定・クライアント・署名鍵・ストアの組み立て。プロジェクトへ組み込むときに編集する場所
│   ├── http.ts               # CORS・キャッシュ禁止の JSON 応答・パラメータ重複の検出・エラーページへのリダイレクトなど、Route Handler と Server Action 共通の部品
│   ├── transaction.ts        # ログイン・同意が続ける認可トランザクションの取得（無ければ notFound()）
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

各 `route.ts` は `GET` / `POST` / `OPTIONS` などの HTTP メソッドを自分で export する。ログイン・同意画面は React のページと Server Action なので、見た目は `page.tsx`、判断は `actions.ts` を書き換える。device / CIBA / RP-Initiated Logout の画面は、表示と同時に Cookie を発行し、403 や 429 などのステータスを返す必要がある。Server Component はどちらもできないため、これらは HTML を返す Route Handler（描画は各ディレクトリの `screens.ts`）として生成する。実験的機能の設定は、それを使うコードの隣に置く（例: `par/config.ts`、トークンエンドポイントの grant なら `token/token-exchange.ts` の `tokenExchangeConfig`）。認可エンドポイントと同意の両方が読む JARM の設定は `_oidc-provider/jarm.ts` にある。

OP がブラウザを止める場面は、Next.js の機能で表す。

- `transaction_id` に対応する認可リクエストが無い（不明・完了済み・期限切れ）: ページと Server Action が `notFound()` を呼び、隣の `not-found.tsx` を HTTP 404 で表示する。利用者はクライアントからやり直すしかない
- クライアントへ返してはいけないエラー（OIDC Core 1.0 §3.1.2.2。未登録の `redirect_uri`、CSRF トークンの不一致、ログイン試行回数の上限、transaction-binding の不一致、判断を含まない同意の POST、Google ログインのコールバックの失敗など）: `redirect()` で `oidc-error/page.tsx` へ送る。Route Handler からは 303 でリダイレクトする
- 想定外の例外（ストアの障害など）: `error.tsx`（error boundary）が表示する。本番の Next.js はエラーメッセージをブラウザへ渡さないので、画面にはサーバーログと突き合わせられる `digest` だけを出す

これらの画面はどれも `_oidc-provider/error-view.tsx` の `ErrorView` で描くので、見た目はそこを書き換えれば揃って変わる。device / CIBA / RP-Initiated Logout の画面のエラーは、ステータスコード（403 / 429 など）を保つため、画面と同じく `_oidc-provider/html.ts` の HTML で返す。

Next.js は Route Handler とページ・Server Action を別々のモジュール層にバンドルする。両方から同じインスタンスを参照する必要があるストアと署名鍵は、`globalThis` に保持している（`provider.ts` / `storage-backend.ts`）。

設定は環境変数から読む。

| 環境変数 | 用途 |
|---|---|
| `OIDC_ISSUER` | issuer。OP 自身の URL はすべてこれを基準に組み立てる |
| `OIDC_CLIENTS_JSON` | 登録クライアント（`RegisteredClient` の JSON 配列）。未指定なら `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_CLIENT_REDIRECT_URI` の 1 クライアント |
| `OIDC_SIGNING_KEY_ID` | 起動時に生成する署名鍵の `kid` |
| `OIDC_CORS_ORIGINS` | トークンエンドポイントなどをブラウザから呼べるオリジン（既定は issuer） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Vercel で使うストア。未指定ならローカル SQLite（`OIDC_SQLITE_PATH`、既定 `.data/oidc.sqlite`） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_HOSTED_DOMAIN` | Sign in with Google（`google-login` 有効時） |

契約テスト `_oidc-provider/conformance.test.ts` は、Route Handler・ページ・Server Action を Next.js と同じ形で直接呼び出す。リクエストの中でしか使えない `cookies()`（`next/headers`）と `redirect()` / `notFound()`（`next/navigation`）だけを差し替えているので、サーバーを起動せずに `vitest run` で実行できる（`vitest` を devDependencies に追加する）。

## 機能トグル（--enable / --disable）

生成されるOPの機能は、既定の全部入り構成から機能単位で増減できる。

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

Basic OP に必須の機能（authorize / token / userinfo / discovery / jwks / login / consent）はトグル対象外で、常に生成される。
未知の機能名や、同じ機能を `--enable` と `--disable` の両方に指定した場合はエラーになる。

### 拡張機能（--enable google-login）

拡張機能は、OAuth / OIDC の仕様ではなく**ログイン手段**を生成コードに足すカテゴリで、既定では無効。実装は別 package にあり、有効にしたときだけ import される。

```bash
maronn-oidc generate express --enable google-login
pnpm add express @maronn-openid-connect/core @maronn-openid-connect/google-login
```

| 機能名 | 既定 | 内容 | 実装 package |
|---|---|---|---|
| `google-login` | 無効 | ログイン画面に「Google でログイン」（Google Identity Services の redirect mode）を追加し、Google が ID トークンを POST する `POST /login/google` を生成する。ID トークンの検証は Google 公式の `google-auth-library` に委ね、CSRF（`g_csrf_token` の Double Submit Cookie）、nonce による認証トランザクションへの束縛、`google:<sub>` を subject にした Google ユーザーの JIT 登録を生成コードが行う | `@maronn-openid-connect/google-login`（Node.js 22 以上限定。Cloudflare Workers などのエッジでは動かない） |

有効化しても `config.googleLogin` を渡すまでボタンは表示されず、`/login/google` は 404 を返す。設定は `ProviderConfig.googleLogin = { clientId, hostedDomain?, requireVerifiedEmail? }` で、Google Cloud コンソールの OAuth クライアントには `<issuer>/login/google` を「承認済みのリダイレクト URI」に、ログイン画面のオリジンを「承認済みの JavaScript 生成元」に登録する。生成される Next.js の `_oidc-provider/provider.ts` と本リポジトリの samples は `GOOGLE_CLIENT_ID` / `GOOGLE_HOSTED_DOMAIN` からこれを読む。詳細は [`@maronn-openid-connect/google-login` の README](../google-login/README.md) を参照。

## カスタムスコープ（--scope）

標準スコープ（`openid` / `profile` / `email` / `address` / `phone` / `offline_access`）以外に受け付けるスコープを、生成時に宣言できる。

```bash
maronn-oidc generate hono --scope reports.read,reports.write
```

宣言すると `scopes.ts`（スコープポリシー）が生成され、生成 OP は次のようになる。

- discovery の `scopes_supported` に宣言したスコープが載る
- **宣言していないスコープ値は `invalid_scope` で拒否される**（RFC 6749 §3.3 / §4.1.2.1）。宣言が 1 つも無ければこのチェック自体を生成しないので、既定の生成物の挙動は変わらない
- ユーザーごとの絞り込みは、生成された `scopes.ts` に書く

### ユーザーごとの絞り込みは生成コードに書く

「誰にどのスコープを許すか」は CLI のオプションにしていない。運用ごとに条件（ロール、テナント、DB 参照）が違い、生成コードを改造して検証するというこのライブラリの使い方に合わないためである。代わりに、生成される `scopes.ts` に絞り込みの入口を用意し、判断が必要な全ステップから呼び出した状態で生成する。

```typescript
// scopes.ts
export const RESTRICTED_SCOPE_SUBJECTS: Record<string, readonly string[]> = {
  'reports.read': ['alice'],   // ← 手早く絞るならここに書く
};

export async function resolveGrantableScopes(
  requested: readonly string[],
  subject: string,
): Promise<string[]> {
  // ← ロール・テナント・DB 参照など、複雑な条件はここに書く（async なので
  //    DB / KV 参照を入れても呼び出し側の変更は不要）
  return requested.filter((scope) => { /* ... */ });
}
```

`resolveGrantableScopes()` は End-User が確定した後に呼ばれ、生成コードの次の箇所からすでに `await` されている。

| 呼び出し元 | タイミング |
|---|---|
| `routes/consent.ts` | 同意画面の表示内容と、承認時の付与スコープ |
| `routes/authorize.ts` | SSO fast path と `prompt=none`（同意画面を出さずに付与する経路）。どちらも**保存済み同意を引く前**に適用する。絞る前の scope で同意を探すと、そのユーザーが持てないスコープをキーに検索することになり永久に一致しない |
| `routes/device.ts` / `routes/ciba-verification.ts` | device / CIBA の承認ステップ（該当機能を有効にした場合） |

落としたスコープはリクエストを失敗させず、付与スコープを狭めるだけになる（RFC 6749 §3.3 は要求より狭いスコープの発行を認めており、トークンレスポンスの `scope` に実際の付与内容が載る）。リクエストごと拒否したい場合は、呼び出し元で throw する。

カスタムスコープに対応する UserInfo クレームは無い（OIDC Core 1.0 §5.4 が定義するのは profile / email / address / phone のみ）。独自クレームを返す場合は `routes/userinfo.ts` を編集する。

### conformance.test.ts との関係

生成物には `conformance.test.ts`（契約テスト）が含まれ、選択した機能構成に合わせた内容で生成される。
無効化した機能については「無効であること」（404 応答、`unsupported_grant_type` / `request_not_supported` の拒否、discovery メタデータの不在など）をテストで固定する。
生成コードをカスタマイズした結果このテストが通らなくなった場合、本リポジトリが担保する Basic OP 挙動から外れている可能性がある。

## 生成後のセットアップ

1. ProviderConfig・署名鍵・クライアント resolver を環境変数 / DB / KV から供給する
2. 生成される `JsonStoreBackend` を実装し、`createJsonProviderStores()` の結果を `storage` に渡す
3. `config.ts` と未指定時のインメモリストアはローカル検証・契約テスト専用として扱う
4. 依存をインストールしてサーバーを起動する（例: `pnpm add hono @maronn-openid-connect/core`。`--enable google-login` 時は `@maronn-openid-connect/google-login` も）

Next.js では 1〜3 をすべて `_oidc-provider/provider.ts` で行う（クライアント・署名鍵・ストアの差し替え先がこのファイルに集まっている）。

署名鍵は `SigningKeyProvider`（`getSigningKeys()` で鍵の配列を返す）として注入する。配列の先頭の鍵が新しいトークンの署名に使われ、すべての鍵が JWKS で公開される。ローテーションでは新しい鍵を先頭に置き、古い鍵はそれで署名したトークンが失効するまで後ろに残す。`createCachedSigningKeyProvider()`（core 提供）でラップすると、TTL 付きキャッシュで鍵ローテーションに追随できる。

```typescript
import { applyOidc } from './oidc-provider/apply.js';
import { createJsonProviderStores } from './oidc-provider/store.js';

applyOidc(app, {
  config: { issuer: 'http://localhost:3000' },
  signingKeyProvider: yourSigningKeyProvider,
  storage: createJsonProviderStores(yourJsonStoreBackend),
});
```

Honoではリクエストごとのバインディングを受け取るstorage factoryも指定できる。配線済みの実例は本リポジトリの `samples/hono-cloudflare` / `samples/express-flyio` / `samples/fastify-flyio` / `samples/nextjs-vercel` を参照。

## ライセンス

MIT
