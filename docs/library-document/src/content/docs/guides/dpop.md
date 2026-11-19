---
title: DPoP（拡張）
description: CLI の --enable dpop で、アクセストークンをクライアントの鍵に束縛する DPoP（RFC 9449）を OP に足す。
---

`--enable dpop` は、生成される OP に OAuth 2.0 Demonstrating Proof of Possession（DPoP、[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)）を足す**拡張機能**です。既定では無効です。

DPoP のコードは、検査も配線もすべて生成コードの `features/dpop/`（Hono / Express / Fastify は `oidc-provider/features/dpop/`、Next.js は `app/_oidc-provider/features/dpop/`）に入ります。専用の package は無く、core のほかにインストールするものは増えません。生成した OP の利用者は、DPoP の検査をすべて読んで、方針を変えたいときはそのファイルを直接直せます（[生成されるもの](#生成されるもの)）。

拡張機能は、`--enable` で名前を挙げたときだけ生成する任意の機能のカテゴリです。API が不安定なことを理由に分けた Experimental とは別のカテゴリです。`google-login` はログイン手段を足し、上流の ID プロバイダーとその公式クライアントライブラリを取り込むので専用の package を使います。`dpop` は送信者制約付きのトークン（sender-constrained tokens）を足し、コードがすべて生成コードに入ります。

DPoP proof の検査は Web Crypto だけで行います。Node.js の API を使わないので、Cloudflare Workers などのエッジランタイムでも動きます。

## DPoP とは

Bearer トークンは、持っている人なら誰でも使えます。漏れたアクセストークンは、そのまま第三者に使われます。

DPoP では、クライアントが自分の鍵の組を持ち、リクエストごとにその秘密鍵で署名した JWT（DPoP proof）を `DPoP` ヘッダーで送ります。DPoP proof には、公開鍵（`jwk` ヘッダー）、リクエストの HTTP メソッド（`htm`）と URI（`htu`）、発行時刻（`iat`）、一意な ID（`jti`）が入ります。OP はトークンを発行するときに DPoP proof を検査し、発行するアクセストークンをその鍵の JWK Thumbprint（RFC 7638）に束縛します。束縛したトークンを使うには、同じ鍵で署名した DPoP proof が毎回要るので、トークンだけが漏れても使えません。

## 生成する

```bash
maronn-oidc generate hono --enable dpop
pnpm add hono @maronn-openid-connect/core
```

`express` / `fastify` / `nextjs` でも同じです。他の機能と組み合わせられます（例: `--enable dpop --enable par`）。

有効にしても、DPoP を使うかはクライアントが決めます。`DPoP` ヘッダーを送らないクライアントには、従来どおり Bearer トークンを発行します。DPoP を必ず使わせたいクライアントには、`dpopBoundAccessTokens: true` を登録します（[クライアントのメタデータ](#クライアントのメタデータ)）。

## エンドポイントごとの動き

### トークンエンドポイント

クライアント認証の直後に、`DPoP` ヘッダーの DPoP proof を検査します（RFC 9449 §4.3）。

1. `DPoP` ヘッダーがちょうど一つであること
2. JWS の形で、`typ` が `dpop+jwt` であること
3. `alg` が `dpopSigningAlgValuesSupported` にある非対称の alg であること（`none` と HS 系は受け付けない）
4. `jwk` が `alg` の公開鍵で（秘密鍵のパラメータを含まない）、その鍵で署名を検証できること
5. `jti` があり、`htm` が `POST`、`htu` が issuer の `/token`（クエリとフラグメントを除いて比べる）で、`iat` が許す範囲にあること
6. 同じ `jti` の DPoP proof がまだ使われていないこと

検査に通ると、発行するトークンを DPoP proof の鍵に束縛します。

- トークンレスポンスの `token_type` は `DPoP` になる（RFC 9449 §5）
- アクセストークン（JWT のペイロード）と保存するレコードに、`cnf: { jkt: <JWK Thumbprint> }` を入れる（RFC 9449 §6.1）
- パブリッククライアントには、リフレッシュトークンも同じ鍵に束縛する（RFC 9449 §5 の MUST）。コンフィデンシャルクライアントのリフレッシュトークンは、クライアント認証で送り手が限られているので束縛しない
- 束縛したリフレッシュトークンと、`dpop_jkt` で束縛した認可コードは、同じ鍵の DPoP proof を付けたリクエストでしか使えない。DPoP proof が無いか、別の鍵のものなら `invalid_grant` で拒否する（RFC 9449 §5 / §10）。この確認は認可コードやリフレッシュトークンを使用済みにする前に行うので、拒否したリクエストはそれらを消費しない

DPoP proof の検査は、どのグラントよりも前に行います。認可コードとリフレッシュトークンのグラントだけでなく、有効にした機能が答えるグラント（`client_credentials`、デバイス認可グラント、CIBA、トークン交換、ID-JAG の引き換え）のトークンも、同じ鍵に束縛します。

DPoP proof を受け付けないときは、400 の `invalid_dpop_proof` で応答します。`dpopBoundAccessTokens: true` のクライアントが DPoP proof を送らなかったときも同じです（RFC 9449 §5.2）。

### UserInfo エンドポイント

DPoP で束縛したアクセストークンは、`Authorization: DPoP <token>` で、DPoP proof を添えて提示します（RFC 9449 §7.1）。

```http
GET /userinfo HTTP/1.1
Authorization: DPoP eyJhbGciOi...
DPoP: eyJ0eXAiOiJkcG9wK2p3dCIs...
```

この DPoP proof の `htm` はリクエストのメソッド、`htu` は issuer の `/userinfo` で、`ath` にアクセストークンの SHA-256 ハッシュ（base64url）を入れます。UserInfo エンドポイントは、DPoP proof を検査したあと、トークンを取得して、トークンが DPoP proof の鍵に束縛されていることを確かめます。

- 鍵に束縛したトークンを `Authorization: Bearer` で提示すると、`invalid_token` で拒否する（RFC 9449 §7.2 の MUST）
- 束縛していないトークンを DPoP スキームで提示したとき、別の鍵の DPoP proof を添えたときも `invalid_token`
- DPoP スキームなのに DPoP proof が無いか、受け付けないときは `invalid_dpop_proof`（どちらも 401）
- DPoP スキームにトークンが無いとき、ヘッダーと POST のボディの両方でトークンを送ったときは 400 の `invalid_request`

DPoP の失敗は、`WWW-Authenticate: DPoP` のチャレンジに `error`、`error_description` と、受け付ける alg（`algs`）を入れて応答します。

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: DPoP error="invalid_token", error_description="A DPoP-bound access token must be presented with the DPoP scheme", algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256 RS384 RS512 EdDSA"
```

DPoP スキームで提示したリクエストは、トークンの期限切れなど DPoP 以外の失敗も DPoP のチャレンジで応答します。Bearer で提示したリクエストは、従来どおり Bearer のチャレンジで応答します。

### イントロスペクション

鍵に束縛した有効なアクセストークンには、保存したレコードから `cnf` と `token_type: "DPoP"` を返します（RFC 9449 §6.2）。リソースサーバーは、`cnf.jkt` と、リクエストに添えられた DPoP proof の鍵を照らし合わせられます。束縛していないトークンの応答は変わりません。

### Discovery

`dpop_signing_alg_values_supported` に、DPoP proof に受け付ける alg（`dpopSigningAlgValuesSupported`）を広告します（RFC 9449 §5.1）。

### 認可エンドポイント（dpop_jkt）

認可リクエストの `dpop_jkt` パラメータで、認可コードを DPoP の鍵に束縛できます（RFC 9449 §10）。値は鍵の JWK Thumbprint（SHA-256 の base64url、43 文字）です。

- `dpop_jkt` は認可トランザクションに保存され、そこから発行する認可コード（同意、SSO、`prompt=none`、Hybrid Flow の `code` のどれでも）に引き継がれる
- トークンエンドポイントは、その鍵の DPoP proof を付けた交換だけを受け付ける。別の鍵か DPoP proof の無い交換は `invalid_grant`
- 形式が正しくない `dpop_jkt` は、`invalid_request` をクライアントへリダイレクトで返す
- 検証した Request Object に `dpop_jkt` があれば、クエリの値より優先する（OIDC Core 1.0 §6.1、RFC 9101 §6.3）。Request Object に無ければクエリの値を使う

### PAR（--enable par と組み合わせたとき）

Experimental 機能の PAR も有効にすると、プッシュした認可リクエストの `DPoP` ヘッダーの鍵が、そのリクエストの `dpop_jkt` になります（RFC 9449 §10.1）。DPoP proof の `htm` はリクエストのメソッド、`htu` は issuer の `/par` です。

- `dpop_jkt` と DPoP proof の両方があれば、同じ鍵でなければ 400 の `invalid_dpop_proof` で拒否する
- プッシュした `dpop_jkt` の形は、`DPoP` ヘッダーが無くてもプッシュのときに確かめ、正しくなければ 400 の `invalid_request` で拒否する（認可エンドポイントと同じ検証。RFC 9126 §2.1）
- DPoP proof を受け付けないときも、PAR のエラーと同じ形（RFC 9126 §2.3）の 400 で応答する
- `DPoP` ヘッダーが無ければ、プッシュした `dpop_jkt`（あれば）をそのまま使う

## 設定

`ProviderConfig` に次の項目が加わります。どれも省略できます。

| 項目 | 既定値 | 説明 |
|---|---|---|
| `dpopSigningAlgValuesSupported` | `['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA']` | DPoP proof に受け付ける alg。Discovery の `dpop_signing_alg_values_supported` と、UserInfo エンドポイントの DPoP のチャレンジの `algs` に載る。`features/dpop/jwk.ts` の `SUPPORTED_DPOP_SIGNING_ALGS` に無い alg は、挙げても受け付けない（`EdDSA` は Ed25519 の鍵だけ） |
| `dpopProofMaxAgeSeconds` | `60` | DPoP proof を、その `iat` から何秒まで受け付けるか（RFC 9449 §11.1）。時計のずれの `dpopProofLeewaySeconds` は別に足すので、`iat` が「今 − `dpopProofMaxAgeSeconds` − `dpopProofLeewaySeconds`」以上の DPoP proof を受け付ける（既定では `iat` から 120 秒まで）。`jti` は、受け付ける最後の秒まで覚える |
| `dpopProofLeewaySeconds` | `60` | DPoP proof の `iat` に許す時計のずれ（秒）。未来の `iat` は「今 + この値」まで受け付け、古い側の範囲にもこの値を足す |

```typescript
applyOidc(app, {
  config: {
    issuer: 'https://op.example.com',
    dpopSigningAlgValuesSupported: ['ES256', 'EdDSA'],
    dpopProofMaxAgeSeconds: 30,
  },
  // ...
});
```

`htu` は、リクエストの URL ではなく `issuer` とエンドポイントのパスから組み立てて比べます。プロキシの後ろに置いても、クライアントが見る URL（`issuer` の URL）で DPoP proof を作れば通ります。

## クライアントのメタデータ

`RegisteredClient` に `dpopBoundAccessTokens`（RFC 9449 §5.2 の `dpop_bound_access_tokens`）が加わります。`true` のクライアントは常に DPoP を使い、DPoP proof の無いトークンリクエストを `invalid_dpop_proof` で拒否します。

```typescript
await registerClient(db, {
  clientId: 'spa',
  // ...
  dpopBoundAccessTokens: true,
});
```

この値を保存するのは、メモリの `db/`（`--db` を付けない生成物）と、自分で書いた `clientResolver` だけです。`--db sql` と `--db kv` のクライアントには、この値を保存する場所がありません。その場合でも、DPoP proof を送ったクライアントのトークンは鍵に束縛されます。必ず DPoP を使わせる指定だけが効きません。

トークン、認可コード、リフレッシュトークン、認可トランザクションの `cnf` は、`--db sql` と `--db kv` でもレコードに保存されます。

## CORS

ブラウザで動くクライアントのために、クライアントが直接呼ぶエンドポイント（トークンエンドポイント、UserInfo エンドポイントと、ほかの機能の PAR、イントロスペクション、リボケーション、動的クライアント登録、デバイス認可、CIBA のエンドポイント）の CORS に次を加えます。PAR には DPoP proof を送ることがあります（RFC 9449 §10.1）。

- `Access-Control-Allow-Headers` に `DPoP`（DPoP proof を送るリクエストヘッダー）
- `Access-Control-Expose-Headers` に `WWW-Authenticate`（DPoP のチャレンジをクライアントが読めるようにする。RFC 9449 §7.1）

## 生成されるもの

DPoP のコードは、Hono / Express / Fastify では `oidc-provider/features/dpop/`、Next.js では `app/_oidc-provider/features/dpop/` に生成されます。検査の関数はどちらも同じファイルにあります。

| ファイル | 内容 |
|---|---|
| `proof.ts` | DPoP proof の検査（RFC 9449 §4.3）。`DPoP` ヘッダーの読み取り（`readDpopProofHeader()`）、JWS の分解と `typ` の確認（`decodeDpopProof()`）、`alg`（`validateDpopProofAlg()`）、署名（`verifyDpopProofSignature()`）、`jti` / `htm` / `htu` / `iat`（`validateDpopProofClaims()`）、保護されたリソースでの `ath`（`validateDpopProofAccessTokenHash()`）、`jti` の消費（`consumeDpopProofJti()`）。トークン、UserInfo、PAR のエンドポイントは、これらを `verifyDpopRequestProof()` から順に呼ぶ |
| `jwk.ts` | `jwk` ヘッダーの公開鍵の検査（`validateDpopProofJwk()`。秘密鍵のメンバーを含む鍵、`alg` に合わない鍵、2048 ビットより短い RSA の鍵を拒否する）、署名の検証、JWK Thumbprint（RFC 7638、`computeJwkThumbprint()`）、検証できる alg（`SUPPORTED_DPOP_SIGNING_ALGS`） |
| `htu.ts` | `htu` とリクエストの URI を比べる前の正規化（`normalizeDpopHtu()`。RFC 3986 §6.2.2 / §6.2.3） |
| `binding.ts` | トークンと認可コードの鍵への束縛（RFC 9449 §5 / §6 / §10）。`cnf` の組み立てと読み取り（`buildDpopConfirmation()` / `readDpopJkt()`）、`dpop_jkt` の形（`parseDpopJkt()`）、PAR の鍵の決め方（`resolvePushedDpopJkt()`）、`dpopBoundAccessTokens` の要求（`requireDpopProofForClient()`）、束縛した認可コードとリフレッシュトークンの確認（`validateDpopBoundGrant()`）、リフレッシュトークンを束縛するか（`selectDpopRefreshTokenJkt()`） |
| `resource.ts` | 保護されたリソースの `DPoP` スキーム（RFC 9449 §7）。`Authorization: DPoP` の読み取り（`readDpopAuthorization()`）、トークンと DPoP proof の鍵の照合（`validateDpopAccessTokenBinding()`）、`WWW-Authenticate: DPoP` のチャレンジ（`buildDpopChallenge()`） |
| `base64url.ts` | JWS と JWK Thumbprint が使う base64url（RFC 4648 §5） |
| `errors.ts` | 検査の失敗（`DpopError`。`error` は OAuth のエラーコード、`errorDescription` は固定の文言） |
| `error-responses.ts` | `DpopError` を、トークンエンドポイントの OAuth のエラーと UserInfo エンドポイントの DPoP のチャレンジにする関数 |
| `config.ts` | `ProviderConfig` に足す `dpopSigningAlgValuesSupported` / `dpopProofMaxAgeSeconds` / `dpopProofLeewaySeconds`、`RegisteredClient` に足す `dpopBoundAccessTokens` と、その既定値 |
| `feature.ts` | 機能の登録。Discovery の `dpop_signing_alg_values_supported` と、CORS に加えるヘッダー |
| `steps/`（Hono / Express / Fastify） | パイプラインのステップ。トークンエンドポイントの `verify-dpop-proof` と `validate-dpop-grant-binding`、UserInfo エンドポイントの `read-dpop-access-token` と `verify-dpop-access-token`、認可エンドポイントの `validate-dpop-jkt`、PAR の `bind-pushed-dpop-key` |
| `token.ts`、`userinfo.ts`、`authorize.ts`、`par.ts`（Next.js） | Route Handler の同じ名前のブロックから呼ぶ関数（`steps/` の代わり） |

ステップは、各エンドポイントのパイプライン（Next.js は Route Handler）の `(feature: dpop)` の印が付いたブロックから呼ばれます。`maronn-oidc graph --enable dpop --detail steps` で、どのステップがどこに入るかを確かめられます。dpop を無効にして生成すると、`features/dpop/` とこれらのブロックは消えます。トークンを鍵に束縛する口（`token-binding.ts` の `TokenBinding`）は機能を知らない形で本体にあり、束縛が無ければ Bearer トークンを発行します。

### 方針を変える

[設定](#設定)で変えられない方針は、`features/dpop/` のファイルを直して変えます。`--force` を付けて生成し直すと直したファイルも上書きされるので、直したファイルは自分のコードとして管理してください。

- 受け付ける alg や鍵の形を変える: `jwk.ts` の `SUPPORTED_DPOP_SIGNING_ALGS` と `validateDpopProofJwk()`
- `iat` の範囲や `htu` の比べ方を変える: `proof.ts` の `validateDpopProofClaims()` と、`htu.ts` の `normalizeDpopHtu()`
- DPoP proof の鍵を、クライアントが登録した鍵に限る: `proof.ts` の `verifyDpopRequestProof()` で、`ClientKeyResolver` の `dpop` の用途の鍵と照らし合わせる
- リフレッシュトークンを束縛するクライアントを変える: `binding.ts` の `selectDpopRefreshTokenJkt()`
- エラーの応答を変える: `error-responses.ts`

## 制限と注意点

- **サーバーが発行する nonce（RFC 9449 §8 / §9）には対応していない。** `DPoP-Nonce` ヘッダーを返さず、DPoP proof の `nonce` も確かめない。DPoP proof の新しさは `iat` の範囲と `jti` の再利用の拒否で確かめる
- **Implicit Flow と Hybrid Flow の認可エンドポイントが返すアクセストークンは Bearer のまま。** フロントチャネルには DPoP proof を送る場所が無いため。Hybrid Flow の認可コードは、`dpop_jkt` があればトークンエンドポイントで交換するときに束縛を確かめる
- **DPoP proof の `jti` は、private_key_jwt のクライアントアサーションの `jti` と同じストア（`clientAssertionJtiStore`）に覚える。** キーの形が違う（DPoP は `["dpop", jkt, jti]`）ので重ならない。ストアの実装を差し替えるときは、DPoP の `jti` も入ることを前提にする。`jti` は署名とクレームを確かめた後で消費するので、検証できない DPoP proof が正しいクライアントの `jti` を先に使ってしまうことは無い
- **登録した鍵に限ることはしない。** DPoP proof の `jwk` ヘッダーの鍵で署名を検証し、その鍵にトークンを束縛する。クライアントが事前に鍵を登録する必要は無く、`ClientKeyResolver` の `dpop` の用途の鍵も読まない
- 保護されたリソースとして DPoP を検査するのは、生成 OP の UserInfo エンドポイントだけ。自分のリソースサーバーで束縛したトークンを受け付けるには、UserInfo エンドポイントのステップ（`read-dpop-access-token` と `verify-dpop-access-token`）と同じく、`resource.ts` の `readDpopAuthorization()`、`proof.ts` の DPoP proof の検査、`resource.ts` の `validateDpopAccessTokenBinding()` と `buildDpopChallenge()` を順に呼ぶか、イントロスペクションの `cnf` を使う
