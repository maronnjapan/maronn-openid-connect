---
'@maronn-openid-connect/cli': minor
---

拡張機能 `dpop` を追加し、`--enable dpop` で OAuth 2.0 Demonstrating Proof of Possession（DPoP、RFC 9449）を生成する OP に足せるようにする。既定では無効で、実装は `@maronn-openid-connect/dpop`（Web Crypto だけで動くので、エッジランタイムでも動く）にある。`DPoP` ヘッダーを送らないクライアントには、有効にしても従来どおり Bearer トークンを発行する。

- トークンエンドポイント: クライアント認証の直後のステップ `verify-dpop-proof` が `DPoP` ヘッダーの DPoP proof を検査し（`htm` は POST、`htu` は issuer の `/token`）、アクセストークンをその鍵に束縛する（`token_type` は `DPoP`、アクセストークンと保存するレコードに `cnf.jkt`。RFC 9449 §5 / §6.1）。パブリッククライアントにはリフレッシュトークンも同じ鍵に束縛する。`registerClient()` に `dpopBoundAccessTokens: true`（`dpop_bound_access_tokens`、§5.2）を登録したクライアントは、DPoP proof の無いトークンリクエストを `invalid_dpop_proof` で拒否する（メモリの `db/` と自前の `clientResolver` だけが保存し、`--db sql` / `--db kv` には保存する場所が無い）。続く `validate-dpop-grant-binding` は、鍵に束縛した認可コードとリフレッシュトークンに同じ鍵の DPoP proof を求め、違えば使用済みにする前に `invalid_grant` で拒否する（§5 / §10）。どのグラントよりも前に検査するので、`client_credentials`、デバイス認可、CIBA、トークン交換、ID-JAG の引き換えのトークンも同じ鍵に束縛する
- UserInfo エンドポイント: `read-dpop-access-token` が `Authorization: DPoP <token>` と、`ath` 入りの DPoP proof を受け付け、`verify-dpop-access-token` がトークンを束縛した鍵と提示の仕方を照らし合わせる。鍵に束縛したトークンの Bearer での提示は `invalid_token` で拒否する（§7.1 / §7.2）。DPoP スキームのリクエストの失敗は、受け付ける alg（`algs`）を入れた `WWW-Authenticate: DPoP` のチャレンジで応答する
- 認可エンドポイント: `validate-dpop-jkt` が `dpop_jkt`（検証した Request Object にあればその値）を確かめて認可トランザクションに保存し、そこから発行する認可コード（同意、SSO、`prompt=none`、Hybrid Flow）をその鍵に束縛する（§10）。`--enable par` と組み合わせると、PAR の `bind-pushed-dpop-key` がプッシュした認可リクエストの `DPoP` ヘッダーの鍵を `dpop_jkt` にし、プッシュした `dpop_jkt` の形もプッシュのときに確かめる（§10.1）
- イントロスペクションは、鍵に束縛したアクセストークンの `cnf` と `token_type`（`DPoP`）を返し（§6.2）、discovery は `dpop_signing_alg_values_supported` を広告する。設定は `ProviderConfig.dpopSigningAlgValuesSupported`（既定はパッケージが検証できるすべての非対称 alg）、`dpopProofMaxAgeSeconds`、`dpopProofLeewaySeconds`（どちらも既定 60 秒）。DPoP proof の `jti` は private_key_jwt と同じ `clientAssertionJtiStore` に、別の形のキーで覚えるので、ストアは増えない
- トークンエンドポイントと UserInfo エンドポイントの CORS が、`DPoP` リクエストヘッダーを許可し、`WWW-Authenticate` を `Access-Control-Expose-Headers` で読ませる
- Next.js の生成物も同じ動きをする（`_oidc-provider/features/dpop/` と、UserInfo と PAR を含む Route Handler の `(feature: dpop)` のブロック）

`--help` と未知の機能名のエラーメッセージの拡張機能に `dpop` を加え、`generate` の拡張機能の案内と `setup` の次のステップ案内を機能ごとにする（Google の設定の案内は google-login を有効にしたときだけ出し、dpop を有効にしたときは `@maronn-openid-connect/dpop` のインストールと、クライアントが DPoP proof を送ることで DPoP を使い始めることを案内する）。拡張機能の定義を「OP に足す任意の機能を、それぞれ専用の package で、安定した API と通常の semver で提供するもの」に改め、`explain fn` の関数カタログの root に `dpop` を加える。

生成コードの変更（dpop を有効にしない生成物の動きは変わらない）:

- 本体に、機能を知らない形でトークンを鍵に束縛する口を足す。新しい base のファイル `token-binding.ts`（Next.js は `_oidc-provider/token-binding.ts`）の `TokenBinding`（`cnf`、`tokenType`、`refreshTokenCnf`）を、トークンを発行・保存・応答するステップ（`issue-access-token`、`persist-access-token`、`issue-refresh-token`、`build-token-response`）と、機能が答えるグラントの dispatch のステップが省略できる入力 `binding`（`tokenBinding`）として受け取る。束縛が無ければ `token_type` は `Bearer` で、アクセストークンとレコードに `cnf` は入らない。トークンエンドポイントの関数を書き換えている場合も、この入力を渡さなければ従来どおりである
- 認可トランザクションが `cnf` を持てるようになり、`create-transaction` が省略できる入力 `codeConfirmation` を受け取る。トランザクションから認可コードを発行するステップ（認可エンドポイント、同意、Hybrid Flow）は、その `cnf` を認可コードのレコードに引き継ぐ。`cnf` は `--db sql` / `--db kv` でもレコードに保存される
- UserInfo エンドポイントの失敗のチャレンジの認証スキームを変えられるようにする。Hono / Express / Fastify の生成物では、`endpoints/userinfo/response.ts` の `UserInfoChallenge` と `BEARER_CHALLENGE` を追加し、`respondUserInfoError()` は第 3 引数でチャレンジを受け取る（省略すると従来どおり Bearer）
- Next.js の生成物では、`userinfo/route.ts` をステップの目印付きのブロックに分け、隣に `userinfo/endpoint.ts` を置く。新しい `userinfo/response.ts` に `UserInfoChallenge`、`BEARER_CHALLENGE`、`UserInfoEndpointError` を置き、署名付きの応答を含む応答の組み立ては `buildUserInfoResponse()` / `respondUserInfo()`、失敗は `respondUserInfoError()` が受け持つ。Bearer の応答は変わらない。`(par)/par/route.ts` も目印付きのブロックに分け、`(par)/par/endpoint.ts` を置く
- Next.js の discovery の Route Handler から、存在しない export（`SUPPORTED_SCOPES`）の import を消す。`.well-known` のディレクトリは型検査の対象から漏れていたので、CLI の matrix の型検査の対象に加えた
- 機能のフックに `cors`（保護されたエンドポイントの CORS に加える `allowHeaders` / `exposeHeaders`）と、それを集める `corsHeadersOf()` を追加し、`createCorsMiddleware()` の `exposeHeaders` で `Access-Control-Expose-Headers` を付けられるようにする
- イントロスペクションの応答を組み立てるステップは、保存したレコードに `cnf` があるアクセストークンにだけ `cnf` と `token_type` を加える（`withTokenBinding()`）

`generate` が機能のブロックを取り除いた後に「まだ読まれている名前」を探すとき、テンプレートリテラルの `${…}` の中を読まず、そこでだけ読む名前の宣言や import を消して生成物が壊れることがあったのを直す（`https://${host}` のようなテンプレートリテラルの中の `//` もコメントと取り違えていた）。コメントとリテラルを先頭から一度だけ走査して見分け、`${…}` の中はコードとして読む。
