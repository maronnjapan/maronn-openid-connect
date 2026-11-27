---
title: DPoP（拡張）
description: CLI の --enable dpop で、アクセストークンをクライアントの鍵に束縛する DPoP（RFC 9449）を OP に足す。
---

`--enable dpop` は、生成される OP に OAuth 2.0 Demonstrating Proof of Possession（DPoP、[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)）を足す**拡張機能**です。既定では無効です。

拡張機能は、`--enable` で名前を挙げたときだけ生成する任意の機能のカテゴリで、API が不安定なことを理由に分けた Experimental とは別のカテゴリです。`google-login` は上流の ID プロバイダーとその公式クライアントライブラリを取り込むので専用の package を使いますが、`dpop` は package を持ちません。DPoP のコードはすべて生成コードの `features/dpop/`（Next.js は `_oidc-provider/features/dpop/`）に入り、各エンドポイントのパイプライン（Next.js は Route Handler）の `(feature: dpop)` のブロックがそれを呼びます。core のほかにインストールするものは増えません。生成した OP の利用者は DPoP の検査をすべて読めて、方針を変えたいときはそのファイルを直接直せます（[生成されるもの](#生成されるもの)）。

DPoP proof の検査と nonce の発行は、Web Crypto だけで行います。Node.js の API を使わないので、Cloudflare Workers などのエッジランタイムでも動きます。

## DPoP とは

Bearer トークンは、持っている人なら誰でも使えます。漏れたアクセストークンは、そのまま第三者に使われます。

DPoP では、クライアントが自分の鍵の組を持ち、リクエストごとにその秘密鍵で署名した JWT（DPoP proof）を `DPoP` ヘッダーで送ります。DPoP proof には、公開鍵（JOSE ヘッダーの `jwk`）、リクエストの HTTP メソッド（`htm`）と URI（`htu`）、発行時刻（`iat`）、一意な ID（`jti`）が入ります。OP はトークンを発行するときに DPoP proof を検査し、発行するアクセストークンをその鍵の JWK Thumbprint（RFC 7638）に束縛します。束縛したトークンを使うには、同じ鍵で署名した DPoP proof が毎回要るので、トークンだけが漏れても使えません。

## 対応する仕様

| RFC 9449 | 生成 OP での対応 |
|---|---|
| §4 DPoP proof | トークンエンドポイント、UserInfo エンドポイント、PAR エンドポイント（`--enable par` のとき）で検査する |
| §5 トークンリクエスト | DPoP proof を送ったトークンリクエストのアクセストークンを、どのグラントでも鍵に束縛する。パブリッククライアントのリフレッシュトークンも束縛する |
| §5.1 認可サーバーのメタデータ | Discovery の `dpop_signing_alg_values_supported` |
| §5.2 クライアントのメタデータ | `dpop_bound_access_tokens`（`RegisteredClient.dpopBoundAccessTokens`。`--enable dynamic-client-registration` のときは `POST /register` でも登録できる） |
| §6 鍵の確認（`cnf`） | JWT のアクセストークンと保存するレコードの `cnf.jkt`。イントロスペクションも `cnf` を返し、`token_type` を `DPoP` にする（§6.2） |
| §7 保護されたリソース | UserInfo エンドポイントの `DPoP` スキーム。Bearer と並べたチャレンジと、Bearer として提示した束縛済みトークンの拒否（§7.2） |
| §8 認可サーバーの nonce | `dpopNonceRequiredAtAuthorizationServer: true` のとき、トークンエンドポイントと PAR エンドポイントが求める（既定は求めない） |
| §9 リソースサーバーの nonce | `dpopNonceRequiredAtResourceServer: true` のとき、UserInfo エンドポイントが求める（既定は求めない） |
| §10 `dpop_jkt` | 認可リクエストの `dpop_jkt`（クエリ、Request Object、PAR でプッシュしたパラメータ）が認可コードを鍵に束縛する |
| §10.1 PAR | `--enable par` のとき、PAR のリクエストの DPoP proof の鍵が認可コードを束縛する |

対応しないこと、制限のあることは [制限と注意点](#制限と注意点) にまとめています。

## 生成する

```bash
maronn-oidc generate hono --enable dpop
pnpm add hono @maronn-openid-connect/core
```

`express` / `fastify` / `nextjs` でも同じです。他の機能と組み合わせられます（例: `--enable dpop --enable par`）。

有効にしても、DPoP を使うかはクライアントが決めます。`DPoP` ヘッダーを送らないクライアントには、これまでどおり Bearer トークンを発行します。DPoP を必ず使わせたいクライアントには `dpop_bound_access_tokens` を登録します（[クライアントのメタデータ](#クライアントのメタデータ)）。

DPoP を使わないクライアントにも、有効にしたことで次の違いが見えます。

- Discovery が `dpop_signing_alg_values_supported` を返す
- UserInfo エンドポイントの失敗の `WWW-Authenticate` は、`Bearer realm="UserInfo"` のチャレンジの後ろに `DPoP algs="…"` のチャレンジを並べる
- クライアントが直接呼ぶエンドポイントの CORS が、`DPoP` ヘッダーを許し、`WWW-Authenticate` と `DPoP-Nonce` を読ませる（[CORS](#cors)）
- 認可リクエストの `dpop_jkt` を読むので、JWK Thumbprint の形でない `dpop_jkt` は `invalid_request` になる
- `--enable dynamic-client-registration` のとき、`POST /register` の 201 が `"dpop_bound_access_tokens": false` を返す（省略したとき）

## クライアントから見た流れ

1. クライアントは鍵の組を作り、トークンリクエストに DPoP proof を付ける
2. OP は、DPoP proof の鍵に束縛したアクセストークンを `token_type: "DPoP"` で返す
3. クライアントは、アクセストークンを `Authorization: DPoP <token>` で送り、アクセストークンのハッシュ（`ath`）を入れた新しい DPoP proof を添える

```http
POST /token HTTP/1.1
Host: op.example.com
Content-Type: application/x-www-form-urlencoded
DPoP: eyJ0eXAiOiJkcG9wK2p3dCIsImFsZyI6IkVTMjU2IiwiandrIjp7Imt0eSI6...

grant_type=authorization_code&code=...&redirect_uri=...&code_verifier=...&client_id=...
```

DPoP proof の JOSE ヘッダーとペイロードは、次の形です。

```json
{ "typ": "dpop+jwt", "alg": "ES256", "jwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." } }
{ "jti": "-BwC3ESc6acc2lTc", "htm": "POST", "htu": "https://op.example.com/token", "iat": 1562262616 }
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{ "access_token": "eyJhbGciOi...", "token_type": "DPoP", "expires_in": 3600, "refresh_token": "...", "id_token": "..." }
```

```http
GET /userinfo HTTP/1.1
Host: op.example.com
Authorization: DPoP eyJhbGciOi...
DPoP: eyJ0eXAiOiJkcG9wK2p3dCIs...
```

UserInfo エンドポイントへの DPoP proof は、`htm` が `GET`、`htu` が `https://op.example.com/userinfo` で、`ath` にアクセストークンの SHA-256 ハッシュ（base64url）を入れます。DPoP proof はリクエストごとに作り、`jti` を使い回しません。

## エンドポイントごとの動き

### トークンエンドポイント

`DPoP` ヘッダーのあるリクエストは、クライアント認証の直後に、DPoP proof を次の順に検査します（RFC 9449 §4.3）。クライアント認証に失敗したリクエストは、DPoP proof の署名とクレームを確かめる前に 401 の `invalid_client` で拒否し、その DPoP proof の `jti` は覚えません（認可サーバーの nonce を求める設定では、`DPoP` ヘッダーの形と nonce だけはクライアント認証の前に確かめます）。

1. `DPoP` ヘッダーが一つだけで、その値が JWS のコンパクト形式であること
2. `typ` が `dpop+jwt`（`application/dpop+jwt` も同じ型として受け付ける）で、`alg` と `jwk` があり、`crit` が無いこと
3. `alg` が設定の `dpopSigningAlgValuesSupported` のうち、この実装が検証できる非対称の alg であること（`none` と HS 系は受け付けない）
4. `jwk` が `alg` に合う公開鍵で（秘密鍵のメンバーを含まない。RSA は 2048 ビット以上）、その鍵で署名を検証できること
5. `jti` が 256 文字までの空でない文字列で、`htm` が `POST`、`htu` が issuer の `/token`（クエリとフラグメントを除き、RFC 3986 §6.2.2 / §6.2.3 で正規化して比べる）、`iat` が許す範囲にあること（[設定](#設定)）
6. 設定が nonce を求めるときは、`nonce` が認可サーバーの最近発行した nonce であること（[サーバーが発行する nonce](#サーバーが発行する-nonce)）
7. 同じ鍵と `jti` の DPoP proof がまだ使われていないこと

検査に通ると、発行するトークンを DPoP proof の鍵に束縛します。

- トークンレスポンスの `token_type` は `DPoP` になる（RFC 9449 §5）
- JWT のアクセストークンのペイロードと、保存するアクセストークンのレコードに、`cnf: { "jkt": "<JWK Thumbprint>" }` を入れる（RFC 9449 §6.1）。`accessTokenFormat: 'opaque'` のアクセストークンは、レコードの `cnf` で束縛する
- パブリッククライアントのリフレッシュトークンも、同じ鍵に束縛する（RFC 9449 §5 の MUST）。コンフィデンシャルクライアントのリフレッシュトークンは、クライアント認証で送り手が限られているので束縛しない
- 束縛したリフレッシュトークンと、`dpop_jkt` で束縛した認可コードは、同じ鍵の DPoP proof を付けたリクエストでしか使えない（RFC 9449 §5 / §10）。この確認はグラントを検証する前に行うので、拒否したリクエストは認可コードを使用済みにせず、リフレッシュトークンもローテーションしない
- 束縛していないリフレッシュトークンを、パブリッククライアントが DPoP proof を付けて使うと、新しいリフレッシュトークンはその鍵に束縛する

DPoP proof の検査は、どのグラントよりも前に行います。認可コードとリフレッシュトークンのグラントのほか、有効にした機能が答えるグラント（`client_credentials`、デバイス認可グラント、CIBA、トークン交換、ID-JAG の jwt-bearer での受領）のアクセストークンも、同じ鍵に束縛します。ID-JAG の発行（トークン交換で `requested_token_type` が ID-JAG のもの）が返す ID-JAG はアクセストークンではないので、束縛しません。

| 場合 | 応答 |
|---|---|
| DPoP proof を受け付けない | 400 の `invalid_dpop_proof` |
| `dpop_bound_access_tokens` を登録したクライアントのリクエストに `DPoP` ヘッダーが無い（RFC 9449 §5.2） | 400 の `invalid_dpop_proof` |
| 鍵に束縛した認可コードかリフレッシュトークンを、DPoP proof 無しか別の鍵の DPoP proof で使った | 400 の `invalid_grant` |
| 設定が nonce を求め、DPoP proof に認可サーバーの最近発行した nonce が無い | 400 の `use_dpop_nonce`（次の nonce を `DPoP-Nonce` ヘッダーで返す） |

エラーのボディは RFC 6749 §5.2 の形で、`error_description` に理由を書きます（例: `The DPoP proof htu claim does not match the request URI`）。

### UserInfo エンドポイント

DPoP で束縛したアクセストークンは、`Authorization: DPoP <token>` で、DPoP proof を添えて提示します（RFC 9449 §7.1）。UserInfo エンドポイントは、DPoP proof を検査し（`htm` はリクエストのメソッド、`htu` は issuer の `/userinfo`、`ath` はアクセストークンのハッシュ）、トークンを取得した後で、トークンが DPoP proof の鍵に束縛されていることを確かめます。

| 場合 | 応答 |
|---|---|
| `Authorization: DPoP` にトークンが無いか、トークンが一つの token68 でない | 400 の `invalid_request` |
| DPoP スキームなのに `DPoP` ヘッダーが無いか、DPoP proof を受け付けない | 401 の `invalid_dpop_proof` |
| DPoP スキームで提示したトークンが、DPoP proof の鍵に束縛されていない（束縛していない、別の鍵に束縛した） | 401 の `invalid_token` |
| 鍵に束縛したトークンを `Authorization: Bearer` で提示した（RFC 9449 §7.2 の MUST） | 401 の `invalid_token` |
| Bearer と DPoP の両方でトークンを送った（`Authorization` を二つ送った、`Authorization: DPoP` にフォームのボディの `access_token` を添えた） | 400 の `invalid_request` |
| 設定が nonce を求め、DPoP proof に保護されたリソースの最近発行した nonce が無い | 401 の `use_dpop_nonce`（次の nonce を `DPoP-Nonce` ヘッダーで返す） |

失敗の応答の `WWW-Authenticate` は、Bearer のチャレンジと、受け付ける alg（`algs`）を並べた DPoP のチャレンジの二つを返します（RFC 9449 §7.2）。エラーの情報（`error`、`error_description`）は、トークンを提示したスキームのチャレンジが伝えます。トークンの期限切れや `insufficient_scope` のような DPoP 以外の失敗も同じです。

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="UserInfo", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA", error="invalid_token", error_description="The access token is bound to a different DPoP key"
```

鍵に束縛したトークンを Bearer で提示したときは、Bearer のチャレンジがエラーを伝え、DPoP のチャレンジはエラーなしで並びます。

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="UserInfo", error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"
```

トークンの無いリクエストには、どちらのチャレンジもエラーを伝えません（`Bearer realm="UserInfo", DPoP algs="…"`。RFC 9449 Figure 17）。Bearer と DPoP の両方でトークンを送ったリクエストは、どちらのスキームで認証しようとしたのか決まらないので、両方のチャレンジに `error="invalid_request"` を入れた 400 で拒否します（RFC 9449 Figure 19）。

`Authorization` の二つのフィールドを見分けられるのは、ランタイムが二つの値をつないで渡すときだけです。Hono は、Cloudflare Workers でも Node.js（`@hono/node-server`）でも二つを受け取ります。Express、Fastify、Next.js（UserInfo のルートは Node.js ランタイムで動く）は、二つ目の `Authorization` を捨てる Node.js の `http` モジュールの上で動くので、最初のフィールドのスキームのリクエストとして答えます。

### イントロスペクション

鍵に束縛した有効なアクセストークンには、保存したレコードから `cnf` と `token_type: "DPoP"` を返します（RFC 9449 §6.2）。リソースサーバーは、`cnf.jkt` と、リクエストに添えられた DPoP proof の鍵を照らし合わせられます。束縛していないトークンとリフレッシュトークンの応答は変わりません。Experimental 機能の `jwt-introspection-response` の JWT の応答にも同じメンバーが入ります。

### Discovery

`dpop_signing_alg_values_supported` に、DPoP proof に受け付ける alg を、設定の `dpopSigningAlgValuesSupported` の順に返します（RFC 9449 §5.1）。この実装が検証できない alg は、設定に挙げても返しません。検証できる alg が一つも無ければ、メンバーごと返しません。

### 認可エンドポイント（dpop_jkt）

認可リクエストの `dpop_jkt` パラメータで、認可コードを DPoP の鍵に束縛できます（RFC 9449 §10）。値は鍵の JWK Thumbprint（SHA-256 の base64url、43 文字）です。

- `dpop_jkt` は認可トランザクションに保存され、そこから発行する認可コード（同意、SSO、`prompt=none`、Hybrid Flow の `code` のどれでも）に引き継がれる
- トークンエンドポイントは、その鍵の DPoP proof を付けた交換だけを受け付ける。別の鍵か DPoP proof の無い交換は `invalid_grant` で、認可コードは使用済みにならない
- 形式が正しくない `dpop_jkt` は、`invalid_request` をクライアントへリダイレクトで返す。空の値は省略と同じに扱う（RFC 6749 §3.1）
- 検証した Request Object に `dpop_jkt` があれば、クエリの値より優先する（OIDC Core 1.0 §6.1、RFC 9101 §6.3）。Request Object に無ければクエリの値を使う
- PAR でプッシュしたパラメータの `dpop_jkt` も読む

### PAR（--enable par と組み合わせたとき）

Experimental 機能の PAR も有効にすると、PAR エンドポイントが `DPoP` ヘッダーの DPoP proof を検査し、その鍵の JWK Thumbprint を、プッシュした認可リクエストの `dpop_jkt` にします（RFC 9449 §10.1）。DPoP proof の `htm` は `POST`、`htu` は issuer の `/par` です。検査はクライアント認証の後で行います。

- プッシュした `dpop_jkt` の形は、`DPoP` ヘッダーが無くてもプッシュのときに確かめ、正しくなければ 400 の `invalid_request` で拒否する（認可エンドポイントと同じ検証。RFC 9126 §2.1）
- `dpop_jkt` と DPoP proof の両方があり、鍵が違えば 400 の `invalid_dpop_proof` で拒否する
- DPoP proof を受け付けないときも、PAR のエラーと同じ形（RFC 9126 §2.3）の 400 の `invalid_dpop_proof` で応答する
- `DPoP` ヘッダーが無ければ、プッシュした `dpop_jkt`（あれば）をそのまま使う

トークンエンドポイントへは、`htu` を `/token` にした新しい DPoP proof を送ります。

### 動的クライアント登録（--enable dynamic-client-registration と組み合わせたとき）

Experimental 機能の動的クライアント登録も有効にすると、`POST /register` が `dpop_bound_access_tokens`（RFC 9449 §5.2）を登録します。

- 値は真偽値で、省略すると `false` として登録し、201 の応答でも返す
- 真偽値でなければ（`null` も）、400 の `invalid_client_metadata` で拒否する
- `customClientMetadata` に `dpop_bound_access_tokens` の検証関数を置き、その関数が `undefined` 以外を返したときは、その値を同じく確かめて登録する
- 登録した値はクライアントの `registrationMetadata` に入り、トークンエンドポイントはそこから読む

## サーバーが発行する nonce

RFC 9449 §8 / §9 の nonce は、DPoP proof を前もって作っておく攻撃（RFC 9449 §11.2）を防ぎます。nonce は発行したときのサーバーの時刻を持つので、DPoP proof の新しさを、`iat` の範囲に加えてサーバーの時計でも確かめられます（RFC 9449 §11.1）。どちらも既定では求めず、`DPoP-Nonce` ヘッダーも返しません。設定で有効にするまでは、DPoP proof の `nonce` クレームも確かめません。

### 認可サーバー（トークンエンドポイントと PAR エンドポイント）

`dpopNonceRequiredAtAuthorizationServer: true`（Next.js は環境変数 `OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER=1`）にすると、トークンエンドポイントと PAR エンドポイントは次のように動きます（RFC 9449 §8）。

- `DPoP` ヘッダーのあるリクエストへの、リクエストを解析した後のレスポンス（成功もエラーも）に、次の DPoP proof に入れる nonce を `DPoP-Nonce` ヘッダーで付ける（RFC 9449 §8.2）
- `nonce` の無い DPoP proof と、認可サーバーが `dpopNonceLifetimeSeconds` 秒の間に発行した nonce でない DPoP proof を、400 の `use_dpop_nonce` で拒否する

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
Cache-Control: no-store
DPoP-Nonce: AAAAAGlVuQAAAQIDBAUGBwgJCgs.qlRn_qjLCd4ScDSkutyR475dsXalwZpCxni6jPVshAI

{ "error": "use_dpop_nonce", "error_description": "Authorization server requires nonce in DPoP proof" }
```

クライアントは、`DPoP-Nonce` の値を `nonce` に入れた新しい DPoP proof でやり直します。nonce は、クライアントの認証より前に、署名を確かめずに分解した DPoP proof で確かめます。そのため、拒否したリクエストの private_key_jwt のクライアントアサーションは使用済みにならず、やり直しにもそのまま使えます。署名と一緒の検査は、クライアントの認証の後でもう一度行います。

nonce を求めると、`DPoP` ヘッダーが一つの DPoP proof の形でないリクエスト（値が二つある、空か空白を含む、JWS のコンパクト形式でない、`typ` が `dpop+jwt` でない、`alg` か `jwk` が無い、`crit` がある）は、クライアントの認証より前に 400 の `invalid_dpop_proof` になります。ボディの形が正しくないなど、リクエストの解析で拒否したレスポンス、Next.js が署名鍵を読み込めないときの 503、`DPoP` ヘッダーの値が二つあるか、空か、空白を含むリクエストへのレスポンスには、nonce を付けません。

### 保護されたリソース（UserInfo エンドポイント）

`dpopNonceRequiredAtResourceServer: true`（Next.js は環境変数 `OIDC_DPOP_NONCE_REQUIRED_AT_RESOURCE_SERVER=1`）にすると、UserInfo エンドポイントは次のように動きます（RFC 9449 §9）。

- DPoP スキーム（`Authorization: DPoP`）のリクエストへの、そのスキームを読んだ後のレスポンス（成功もエラーも。Next.js が署名鍵を読み込めないときの 503 と、nonce の秘密が 32 バイトより短いときの 500 を除く）に、保護されたリソースの次の nonce を `DPoP-Nonce` ヘッダーで付ける。`DPoP` ヘッダーの無いリクエストへのエラーにも付ける
- `nonce` の無い DPoP proof と、保護されたリソースが `dpopNonceLifetimeSeconds` 秒の間に発行した nonce でない DPoP proof を、401 の `use_dpop_nonce` で拒否する。エラーは DPoP のチャレンジが伝える

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="UserInfo", DPoP algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA", error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"
DPoP-Nonce: AAAAAGlVuQAAAQIDBAUGBwgJCgs.qMJbK4hF-YMMuV93-YOisKgT890kG1mcLWrlBS0Hgvc
```

Bearer のリクエスト、トークンの無いリクエスト、`Authorization` が Bearer と DPoP の両方を名指すリクエストには、nonce を渡さず、求めもしません。

### nonce の形と秘密

認可サーバーと保護されたリソースの nonce は別のもので、トークンエンドポイントと PAR エンドポイントは保護されたリソースの nonce を、UserInfo エンドポイントは認可サーバーの nonce を受け付けません。

nonce はサーバーに状態を残しません。発行した時刻（秒）と 12 バイトの乱数に、秘密の鍵の HMAC-SHA256 を付けた `<payload>.<mac>` の形（どちらも base64url。RFC 9449 §8.1 の NQCHAR だけからなる）で、MAC には nonce を発行したサーバーの役割と issuer も入れます。発行から `dpopNonceLifetimeSeconds` 秒（既定は 120）の間、同じ秘密を持つどのインスタンスでも受け付けます。同じ nonce は、その間に何度使っても受け付けます（RFC 9449 §11.1。DPoP proof の再利用は `jti` で拒否する）。

秘密は 32 バイト以上の文字列で、Hono・Express・Fastify では `createApp()` / `applyOidc()` の `dpopNonceSecret`、Next.js では環境変数 `OIDC_DPOP_NONCE_SECRET` で渡します。OP を複数のインスタンスで動かすときは、どのインスタンスにも同じ値を渡します。

秘密を渡さなければ、インスタンスごとに乱数の鍵を作ります。インスタンスとは、Cloudflare Workers の Hono では isolate、Node.js の Hono・Express・Fastify と `next start` の Next.js ではプロセス、サーバーレス関数の Next.js ではその関数のインスタンスです。ほかのインスタンスや再起動した後のインスタンスはその nonce を受け付けないので、秘密を渡さずに nonce を求められるのは、長く動く一つのインスタンスだけです。32 バイトより短い秘密を渡すと、nonce を作るリクエストが 500 の `server_error` になります（そのレスポンスに nonce は付きません）。

## 設定

`ProviderConfig` に次の項目が加わります。どれも省略でき、既定値は生成コードの `features/dpop/config.ts` の `dpopConfigDefaults` にあります。

| 項目 | 既定値 | 説明 |
|---|---|---|
| `dpopSigningAlgValuesSupported` | `['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA']` | DPoP proof に受け付ける alg。Discovery の `dpop_signing_alg_values_supported` と、UserInfo エンドポイントの DPoP のチャレンジの `algs` に載る。`features/dpop/jwk.ts` の `SUPPORTED_DPOP_SIGNING_ALGS` に無い alg（`none`、HS 系、`ES256K` など）は、挙げても受け付けない（`EdDSA` は Ed25519 の鍵だけ） |
| `dpopProofMaxAgeSeconds` | `60` | DPoP proof を、その `iat` から何秒まで受け付けるか（RFC 9449 §11.1）。時計のずれの `dpopProofLeewaySeconds` は別に足すので、`iat` が「今 − `dpopProofMaxAgeSeconds` − `dpopProofLeewaySeconds`」以上の DPoP proof を受け付ける（既定では `iat` から 120 秒まで）。`jti` は、受け付ける最後の秒まで覚える |
| `dpopProofLeewaySeconds` | `60` | DPoP proof の `iat` に許す時計のずれ（秒）。未来の `iat` は「今 + この値」まで受け付け、古い側の範囲にもこの値を足す |
| `dpopNonceLifetimeSeconds` | `120` | 発行した nonce を何秒まで受け付けるか（RFC 9449 §8 / §9） |
| `dpopNonceRequiredAtAuthorizationServer` | `false` | `true` にすると、トークンエンドポイントと PAR エンドポイントが DPoP proof に認可サーバーの nonce を求める（Next.js は `OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER=1`） |
| `dpopNonceRequiredAtResourceServer` | `false` | `true` にすると、UserInfo エンドポイントが DPoP proof に保護されたリソースの nonce を求める（Next.js は `OIDC_DPOP_NONCE_REQUIRED_AT_RESOURCE_SERVER=1`） |

秒数の項目は 0 以上の有限の数にします。そうでない値では、その値を使う検査（`dpopNonceLifetimeSeconds` は nonce を求めるときだけ使う）がどの DPoP proof も受け付けず、500 の `server_error` で応答します。

Hono・Express・Fastify では、`applyOidc()`（または `createApp()`）の `config` と、nonce の秘密の `dpopNonceSecret` で渡します。

```typescript
applyOidc(app, {
  config: {
    issuer: 'https://op.example.com',
    accessTokenExpiresIn: 300,
    dpopSigningAlgValuesSupported: ['ES256', 'EdDSA'],
    dpopNonceRequiredAtAuthorizationServer: true,
    dpopNonceRequiredAtResourceServer: true,
  },
  // 32 バイト以上。どのインスタンスにも同じ値を、シークレットを置く場所から読んで渡す
  dpopNonceSecret: yourDpopNonceSecret,
  signingKeyProvider: yourSigningKeyProvider,
});
```

Next.js では、nonce の二つの項目と秘密を環境変数（`OIDC_DPOP_NONCE_REQUIRED_AT_AUTHORIZATION_SERVER`、`OIDC_DPOP_NONCE_REQUIRED_AT_RESOURCE_SERVER`、`OIDC_DPOP_NONCE_SECRET`）から読みます。ほかの項目は、`_oidc-provider/provider.ts` の `createProviderConfig()` に渡す値に足します。

`htu` は、リクエストの URL ではなく `issuer` とエンドポイントのパスから組み立てて比べます。プロキシの後ろに置いても、クライアントが見る URL（`issuer` の URL）で DPoP proof を作れば通ります。`issuer` が `/` で終わるときは、`/` を重ねない URL（`https://op.example.com/token`）も受け付けます。

## クライアントのメタデータ

`RegisteredClient` に `dpopBoundAccessTokens`（RFC 9449 §5.2 の `dpop_bound_access_tokens`）が加わります。`true` のクライアントは常に DPoP を使い、`DPoP` ヘッダーの無いトークンリクエストを、どのグラントでも 400 の `invalid_dpop_proof` で拒否します。省略すると `false` で、そのクライアントは Bearer トークンも得られます。

```typescript
await registerClient(db, {
  clientId: 'spa',
  // ...
  dpopBoundAccessTokens: true,
});
```

`--db` を付けない生成物はクライアントと一緒にメモリに持ち、`--db sql` は `clients.payload` 列に、`--db kv` はクライアントのレコードの `payload` に JSON で保存します。`clients.payload` 列が加わる前の CLI で作った SQL のデータベースには、[移行](#既存の生成物に足すとき) の `ALTER TABLE` で列を足してから登録します。動的クライアント登録で登録したクライアントは、この値を `registrationMetadata` の `dpop_bound_access_tokens` に持ち、トークンエンドポイントはどちらも読みます（真偽値の `true` だけを数えます）。

トークン、認可コード、リフレッシュトークン、認可トランザクションの `cnf` は、`--db sql` と `--db kv` でも、それぞれのレコードの JSON に保存されます。スキーマを変える必要はありません。

## CORS

ブラウザで動くクライアントのために、クライアントが直接呼ぶエンドポイント（トークンエンドポイント、UserInfo エンドポイントと、有効にした機能の PAR、イントロスペクション、リボケーション、動的クライアント登録、デバイス認可、CIBA のエンドポイント）の CORS に次を加えます。nonce を求めない設定でも同じです。

- `Access-Control-Allow-Headers` に `DPoP`（DPoP proof を送るリクエストヘッダー。RFC 9449 §4.1）
- `Access-Control-Expose-Headers` に `WWW-Authenticate`（UserInfo エンドポイントのチャレンジ。RFC 9449 §7.1）と `DPoP-Nonce`（次の nonce。RFC 9449 §8 / §9）

## 生成されるもの

DPoP のコードは、Hono / Express / Fastify では `features/dpop/`、Next.js では `_oidc-provider/features/dpop/` に生成されます。検査の関数はどちらも同じファイルにあります。

| ファイル | 内容 |
|---|---|
| `proof.ts` | DPoP proof の検査（RFC 9449 §4.3）。`DPoP` ヘッダーの読み取り（`readDpopProofHeader()`）、JWS の分解と JOSE ヘッダーの確認（`decodeDpopProof()`）、`alg`（`validateDpopProofAlg()`）、署名（`verifyDpopProofSignature()`）、`jti` / `htm` / `htu` / `iat`（`validateDpopProofClaims()`）、`nonce`（`validateDpopProofNonce()`）、保護されたリソースでの `ath`（`validateDpopProofAccessTokenHash()`）、`jti` の消費（`consumeDpopProofJti()`）。エンドポイントは、これらを `verifyDpopRequestProof()` から順に呼ぶ |
| `jwk.ts` | `jwk` ヘッダーの公開鍵の検査（`validateDpopProofJwk()`）、署名の検証（`verifyJwsSignature()`）、JWK Thumbprint（RFC 7638、`computeJwkThumbprint()`）、検証できる alg（`SUPPORTED_DPOP_SIGNING_ALGS`） |
| `htu.ts` | `htu` とエンドポイントの URI を比べる前の正規化（`normalizeDpopHtu()`。RFC 3986 §6.2.2 / §6.2.3） |
| `binding.ts` | トークンと認可コードの鍵への束縛（RFC 9449 §5 / §6 / §10）。`cnf` の組み立てと読み取り（`buildDpopConfirmation()` / `readDpopJkt()`）、`dpop_jkt` の形（`parseDpopJkt()`）、PAR の鍵の決め方（`resolvePushedDpopJkt()`）、`dpop_bound_access_tokens` の読み取りと要求（`dpopBoundAccessTokensOf()` / `requireDpopProofForClient()`）、束縛した認可コードとリフレッシュトークンの確認（`validateDpopBoundGrant()`）、リフレッシュトークンを束縛するか（`selectDpopRefreshTokenJkt()`） |
| `resource.ts` | 保護されたリソースの `DPoP` スキーム（RFC 9449 §7）。`Authorization: DPoP` の読み取り（`readDpopAuthorization()`、`validateDpopCredentials()`）、Bearer と DPoP の両方の提示の判定（`namesBearerAndDpopSchemes()`）、トークンと DPoP proof の鍵の照合（`validateDpopAccessTokenBinding()`）、DPoP のチャレンジ（`dpopChallengeOf()`） |
| `nonce.ts` | nonce の発行と確認（`issueDpopNonce()` / `verifyDpopNonce()`）と、その鍵（`dpopNonceKeyOf()`）（RFC 9449 §8 / §9） |
| `server-nonce.ts` | エンドポイントが nonce を求めるか（`authorizationServerNonceOf()` / `resourceServerNonceOf()`）、認可サーバーのクライアント認証の前の nonce の確認（`requireDpopNonce()`）、保護されたリソースの nonce の付与（`provideDpopNonce()`） |
| `base64url.ts` | JWS と JWK Thumbprint が使う base64url（RFC 4648 §5） |
| `errors.ts` | 検査の失敗（`DpopError`。`error` は OAuth のエラーコード、`errorDescription` は固定の文言）。どのエンドポイントがどのコードを返すかも書いてある |
| `error-responses.ts` | `DpopError` を、トークンエンドポイントと PAR エンドポイントの OAuth のエラーと、UserInfo エンドポイントのチャレンジ付きのエラーにする関数 |
| `config.ts` | `ProviderConfig` に足す設定と既定値（`dpopConfigDefaults`）、受け付ける alg（`dpopSigningAlgsOf()`）、`RegisteredClient` に足す `dpopBoundAccessTokens`。Hono / Express / Fastify では `OidcProviderOptions` に足す `dpopNonceSecret` も |
| `feature.ts` | 機能の登録。設定の既定値、Discovery の `dpop_signing_alg_values_supported`、CORS に加えるヘッダー（Hono / Express / Fastify では nonce の秘密をリクエストのコンテキストに入れる） |
| `steps/`（Hono / Express / Fastify） | パイプラインのステップ。トークンエンドポイントの `require-dpop-nonce`、`verify-dpop-proof`、`validate-dpop-grant-binding`、UserInfo エンドポイントの `read-dpop-access-token`、`verify-dpop-access-token`、認可エンドポイントの `validate-dpop-jkt`、PAR の `require-pushed-dpop-nonce`、`bind-pushed-dpop-key`、動的クライアント登録の `validate-dpop-client-metadata` |
| `token.ts`、`userinfo.ts`、`authorize.ts`、`par.ts`、`register.ts`（Next.js） | Route Handler の同じ名前のブロックから呼ぶ関数（`steps/` の代わり） |

ステップは、各エンドポイントのパイプライン（Next.js は Route Handler）の `(feature: dpop)` の印が付いたブロックから呼ばれます。どのステップがどこに入るかは、次のコマンドで確かめられます。

```bash
maronn-oidc graph hono --enable dpop,par --detail steps --endpoint token,userinfo,par
```

PAR と動的クライアント登録のためのファイル（Hono / Express / Fastify の `steps/require-pushed-dpop-nonce.ts`、`steps/bind-pushed-dpop-key.ts`、`steps/validate-dpop-client-metadata.ts`、Next.js の `par.ts`、`register.ts`）は、`par` や `dynamic-client-registration` を有効にしなくても生成されます。そのときは、どこからも呼ばれません。

dpop を無効にして生成すると、`features/dpop/` とこれらのブロックは消えます。トークンを鍵に束縛する口（`token-binding.ts` の `TokenBinding`）と、UserInfo エンドポイントのチャレンジを並べる仕組みは機能を知らない形で本体にあり、束縛が無ければ Bearer トークンを発行し、Bearer のチャレンジだけを返します。

### 方針を変える

[設定](#設定)で変えられない方針は、`features/dpop/` のファイルを直して変えます。`--force` を付けて生成し直すと直したファイルも上書きされるので、直したファイルは自分のコードとして管理してください（[Overwrite Protection](../cli/#overwrite-protection)）。

- 受け付ける alg や鍵の形を変える: `jwk.ts` の `SUPPORTED_DPOP_SIGNING_ALGS` と `validateDpopProofJwk()`
- `iat` の範囲や `htu` の比べ方を変える: `proof.ts` の `validateDpopProofClaims()` と、`htu.ts` の `normalizeDpopHtu()`
- DPoP proof の鍵を、クライアントが登録した鍵に限る: `proof.ts` の `verifyDpopRequestProof()` で、`ClientKeyResolver` の `dpop` の用途の鍵と照らし合わせる
- リフレッシュトークンを束縛するクライアントを変える: `binding.ts` の `selectDpopRefreshTokenJkt()`
- nonce を求める条件を変える: `server-nonce.ts` の `authorizationServerNonceOf()` / `resourceServerNonceOf()`。nonce の形は `nonce.ts`
- エラーの応答を変える: トークンエンドポイント、PAR エンドポイント、UserInfo エンドポイントは `error-responses.ts`。認可エンドポイントは `validateDpopJktParameter()`（Hono / Express / Fastify は `steps/validate-dpop-jkt.ts`、Next.js は `authorize.ts`）、動的クライアント登録は `registerDpopClientMetadata()`（`steps/validate-dpop-client-metadata.ts`、Next.js は `register.ts`）が応答を作る

## 運用の注意

- **本番では HTTPS で動かす。** DPoP はメッセージの完全性を TLS に任せている（RFC 9449 §1 / §11.7）。DPoP proof が守るのはトークンの使い手で、リクエストの中身ではない。`issuer` も https の URL にする
- **nonce を求めないなら、アクセストークンの有効期間を短くする。** クライアントの中で鍵を使える攻撃者（XSS で入り込んだコードなど）は、未来の `iat` の DPoP proof を前もって作れる。nonce を使わない配置は長く使えるアクセストークンを発行するべきでない（RFC 9449 §11.2 の SHOULD NOT）ので、`accessTokenExpiresIn`（既定は 3600 秒）を短くし、リフレッシュトークンで取り直させる。前もって作った DPoP proof を拒むには、nonce を求める（RFC 9449 §11.2）
- **複数のインスタンスで動かすときは、状態を共有する。** nonce の秘密はどのインスタンスにも同じ値を渡す。DPoP proof の `jti` は、private_key_jwt のクライアントアサーションの `jti` と同じストア（`clientAssertionJtiStore`。`--db sql` は `client_assertion_jtis`、`--db kv` は `client_assertion_jti:<hash>` のキー）に、鍵と `jti` のハッシュから作ったキーで覚える。`--db` を付けない生成物はインスタンスのメモリに覚えるので、ほかのインスタンスに送られた同じ DPoP proof を拒否できない

## 既存の生成物に足すとき

- `--db sql` で、`clients.payload` 列が加わる前の CLI で作ったデータベースには、`dpopBoundAccessTokens` を登録する前に列を足す（[CLI Guide のテーブルの構成](../cli/#テーブルの構成)）。`--db kv` とメモリは、何もしなくてよい

```sql
ALTER TABLE clients ADD COLUMN payload TEXT;
```

- `dpop` のブロックは、トークン、UserInfo、認可、PAR、動的クライアント登録のエンドポイントのパイプライン（Next.js は Route Handler）に入る。それらを手で直した生成物は、`--dry-run` で上書きするファイルを確かめ、別のディレクトリに生成した `(feature: dpop)` のブロックを取り込む。nonce を求める設定にする前に、`require-dpop-nonce` と `require-pushed-dpop-nonce` のブロックがあることを確かめる。無いまま求めると、DPoP のリクエストが `DPoP-Nonce` の無い `use_dpop_nonce` で拒否され、クライアントはやり直せない
- Next.js の nonce は、`_oidc-provider/http.ts` の `setResponseHeader()` で付け、`withCors()` がレスポンスに入れる。自分で直した `http.ts` を使っているなら、`dpop` のファイルを使う前に、生成し直した `http.ts` からこの二つを取り込む

## 制限と注意点

- **Implicit Flow と Hybrid Flow の認可エンドポイントが返すアクセストークンは Bearer のまま。** フロントチャネルには DPoP proof を送る場所が無いため。`dpop_bound_access_tokens` を登録したクライアントでも同じで、OP はそのクライアントの `token` を含む `response_type` を拒まない（RFC 9449 §5.2 が求めるのはトークンリクエストの拒否）。Hybrid Flow の認可コードは、`dpop_jkt` があれば、トークンエンドポイントで交換するときに束縛を確かめる
- **保護されたリソースとして DPoP を検査するのは、生成 OP の UserInfo エンドポイントだけ。** 保護されたリソースの nonce も UserInfo エンドポイントだけが求め、その秘密は認可サーバーの nonce と同じものを使う（nonce の MAC に役割を入れて分ける）。生成 OP の外のリソースサーバーは、イントロスペクションの `cnf.jkt` と、自分で検査した DPoP proof の鍵の JWK Thumbprint を照らし合わせる（`features/dpop/` の検査の関数は、その実装の参考にできる）
- **登録した鍵に限ることはしない。** DPoP proof の `jwk` ヘッダーの鍵で署名を検証し、その鍵にトークンを束縛する。クライアントが前もって鍵を登録する必要は無く、`ClientKeyResolver` の `dpop` の用途の鍵も読まない（[方針を変える](#方針を変える)）
- **Ed25519 の alg は `EdDSA` だけを受け付ける。** RFC 9864 の、曲線を名前に含む `Ed25519` は受け付けず、`dpop_signing_alg_values_supported` にも載らない。Ed448 の鍵と、`ES256K` のようにこの実装が検証できない alg も受け付けない
- **`Authorization` の二つのフィールドを見分けるのは、Hono（Cloudflare Workers と、Node.js の `@hono/node-server`）だけ。** Express、Fastify、Next.js では二つ目が届かないので、Bearer と DPoP の両方を送ったリクエストを、最初のフィールドのスキームのリクエストとして答える（[UserInfo エンドポイント](#userinfo-エンドポイント)）
- **認可サーバーの nonce を求めると、`DPoP` ヘッダーの形の誤りと nonce の不足は、クライアントの認証より先に答える。** 認証に失敗するクライアントでも、401 の `invalid_client` より前に 400 の `invalid_dpop_proof` か `use_dpop_nonce` が返る
- **nonce の秘密を渡さなければ、nonce を受け付けるのは発行したインスタンスだけ。** [nonce の形と秘密](#nonce-の形と秘密) を参照
