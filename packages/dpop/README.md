# @maronn-openid-connect/dpop

OAuth 2.0 Demonstrating Proof of Possession（DPoP、[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)）を、maronn-openid-connect の OpenID Provider に加えるための拡張パッケージ。

クライアントは、リクエストごとに自分の鍵で署名した DPoP proof を `DPoP` ヘッダーで送る。OP はトークンエンドポイントで DPoP proof を検査し、発行するアクセストークンをその鍵に束縛する（`token_type` は `DPoP`、アクセストークンの `cnf.jkt` は鍵の JWK Thumbprint）。保護されたリソース（UserInfo エンドポイント）は、`Authorization: DPoP <token>` と `ath` 入りの DPoP proof を受け取り、トークンが DPoP proof の鍵に束縛されていることを確かめる。

## 位置づけ

- **CLI 生成コードから呼び出す想定で API を切っている。** `@maronn-openid-connect/cli` の `--enable dpop`（拡張機能。既定では無効）で生成コードに組み込まれ、トークンエンドポイント、UserInfo エンドポイント、認可エンドポイント、PAR のステップがこのパッケージの関数を順に呼ぶ（[CLI での利用](#cli-での利用)）。HTTP の配線（ヘッダーの読み取り、エラーレスポンスの組み立て、`jti` のストア）は呼び出し側の責務で、このパッケージは検査と束縛の関数だけを提供する
- **core に依存しない。** `dependencies` も `peerDependencies` も持たない。core のエラー型も使わず、検査の失敗は `DpopError`（OAuth のエラーコード付き）で投げ、生成コードがエンドポイントごとのエラーレスポンスにする。core のリリースが、このパッケージのリリースを強制することはない（[RELEASE.md](../../RELEASE.md)「dpop は core に依存しない拡張パッケージ」）
- **Web Crypto だけで動く。** Node.js の API を使わないので、Cloudflare Workers や Vercel Edge などのエッジランタイムでも動く。テストも Edge Runtime 環境で行う
- **拡張パッケージとして semver でリリースする。** experimental（API が不安定で、常に patch）と違い、API は安定していて、互換性の変化に応じて minor / major も使う

## インストール

```bash
pnpm add @maronn-openid-connect/dpop
```

エントリポイントはルート（`@maronn-openid-connect/dpop`）の 1 つだけ。

## 提供機能（API 概要）

`src/index.ts` の並びのとおり、検査を段階ごとの関数に分けている。

### DPoP proof の検査（RFC 9449 §4.3）

| API | 役割 |
|---|---|
| `readDpopProofHeader(value)` | `DPoP` ヘッダーの値から DPoP proof を返す。ヘッダーが無ければ `undefined`。複数のヘッダー（`,` でつながった値）と、一つの JWT でない値は拒否する |
| `decodeDpopProof(proof)` | JWS のコンパクト形式を分解し、`typ` が `dpop+jwt` であること、`alg` と `jwk` のヘッダーがあることを確かめる。署名はまだ検証しない |
| `validateDpopProofAlg(alg, acceptedAlgs)` | `alg` が受け付ける非対称の alg であることを確かめる。`none` と HS 系は、`acceptedAlgs` に含めても受け付けない |
| `verifyDpopProofSignature(decoded, jwk)` | `jwk` の公開鍵で署名を検証する |
| `validateDpopProofClaims(claims, policy)` | `jti`、`htm`、`htu`（クエリとフラグメントを除き、正規化して比べる）、`iat`（`maxAgeSeconds` と `leewaySeconds` の範囲）を確かめ、`jti` の消費に使う値を返す |
| `validateDpopProofAccessTokenHash(claims, accessToken)` / `computeDpopAccessTokenHash(accessToken)` | 保護されたリソースで、`ath` がアクセストークンの SHA-256（base64url）であることを確かめる |
| `consumeDpopProofJti(store, proof)` | `jti` を消費し、同じ DPoP proof の再利用を拒否する。キーは `["dpop", jkt, jti]` で、private_key_jwt の `jti` と同じストア（core の `ClientAssertionJtiStore` と同じ形の `DpopProofJtiStore`）を共有できる。署名とクレームを確かめた後で呼ぶ |
| `DPOP_PROOF_TYPE`、`DEFAULT_DPOP_PROOF_MAX_AGE_SECONDS`、`DEFAULT_DPOP_PROOF_LEEWAY_SECONDS` | `dpop+jwt` と、`iat` の既定の範囲（どちらも 60 秒） |

### 公開鍵と JWK Thumbprint（RFC 9449 §4.2 / §6.1、RFC 7638）

| API | 役割 |
|---|---|
| `validateDpopProofJwk(jwk, alg)` | `jwk` ヘッダーが `alg` で使える公開鍵であることを確かめる。秘密鍵か対称鍵のメンバーを含む鍵、`kty` / `crv` が `alg` に合わない鍵、2048 ビットより短い RSA の鍵は拒否する |
| `computeJwkThumbprint(jwk)` | 鍵の JWK Thumbprint（SHA-256、base64url）を返す。トークンを束縛する `cnf.jkt` の値 |
| `SUPPORTED_DPOP_SIGNING_ALGS` / `isSupportedDpopSigningAlg(alg)` | 検証できる alg |
| `normalizeDpopHtu(uri)` | `htu` を比べる形に正規化する（RFC 3986 §6.2.2 / §6.2.3） |

### トークンと認可コードの鍵への束縛（RFC 9449 §5 / §6 / §10）

| API | 役割 |
|---|---|
| `buildDpopConfirmation(jkt)` / `readDpopJkt(record)` | トークンやレコードの `cnf`（`{ jkt }`）を作る、読む |
| `parseDpopJkt(value)` | 認可リクエストの `dpop_jkt` が JWK Thumbprint の形（43 文字）であることを確かめる |
| `resolvePushedDpopJkt(dpopJkt, proofJkt)` | PAR で、`dpop_jkt` と `DPoP` ヘッダーの鍵から、認可コードを束縛する鍵を決める（両方あれば同じ鍵であることを求める。§10.1） |
| `requireDpopProofForClient(dpopBoundAccessTokens, proof)` | `dpop_bound_access_tokens` を登録したクライアントのトークンリクエストに DPoP proof を求める（§5.2） |
| `validateDpopBoundGrant(boundJkt, proofJkt)` | 鍵に束縛した認可コードかリフレッシュトークンが、同じ鍵の DPoP proof とともに提示されたことを確かめる |
| `selectDpopRefreshTokenJkt(publicClient, proofJkt)` | リフレッシュトークンを束縛する鍵を返す（パブリッククライアントだけ。§5） |
| `DPOP_TOKEN_TYPE` | トークンレスポンスの `token_type`（`DPoP`） |

### 保護されたリソース（RFC 9449 §7）

| API | 役割 |
|---|---|
| `readDpopAuthorization(header)` | `Authorization: DPoP <token>` のトークンを返す。DPoP スキームでなければ `undefined` |
| `validateDpopAccessTokenBinding(boundJkt, proofJkt)` | トークンが DPoP proof の鍵に束縛されていることを確かめる。束縛したトークンを Bearer で提示したときも拒否する（§7.2） |
| `buildDpopChallenge(challenge)` | `WWW-Authenticate: DPoP` のチャレンジ（`error`、`error_description`、`algs`）を組み立てる |
| `DPOP_AUTHENTICATION_SCHEME` | `DPoP` |

### エラー

`DpopError` の `error` は、OAuth のエラーレスポンスにそのまま載せるエラーコード（`invalid_dpop_proof`、`invalid_token`、`invalid_grant`、`invalid_request`）で、`errorDescription` はパッケージが決めた固定の文言だけを入れる（クライアントの値を含めない）。`isDpopError(value)` で判定する。

## 対応する alg

`ES256`、`ES384`、`ES512`、`PS256`、`PS384`、`PS512`、`RS256`、`RS384`、`RS512`、`EdDSA`（Ed25519 の鍵だけ）。どれも Web Crypto で検証する。`none` と MAC（HS 系）は受け付けない。

## CLI での利用

```bash
maronn-oidc generate <hono|express|fastify|nextjs> --enable dpop
pnpm add @maronn-openid-connect/core @maronn-openid-connect/dpop
```

有効にすると、生成コードに `features/dpop/`（Next.js は `_oidc-provider/features/dpop/`）が加わり、各エンドポイントのパイプラインの `(feature: dpop)` のブロックがステップを呼ぶ。

- トークンエンドポイント: DPoP proof を検査し、アクセストークンを鍵に束縛する（`token_type: DPoP`、`cnf.jkt`）。パブリッククライアントのリフレッシュトークンも束縛し、束縛した認可コードとリフレッシュトークンには同じ鍵の DPoP proof を求める
- UserInfo エンドポイント: `Authorization: DPoP` と `ath` 入りの DPoP proof を受け付け、束縛したトークンの Bearer での提示を拒否する。失敗は `WWW-Authenticate: DPoP` で応答する
- 認可エンドポイントと PAR: `dpop_jkt`（PAR では `DPoP` ヘッダーの鍵）で認可コードを束縛する
- イントロスペクションは `cnf` と `token_type` を返し、Discovery は `dpop_signing_alg_values_supported` を広告する

`DPoP` ヘッダーを送らないクライアントには、従来どおり Bearer トークンを発行する。設定（`dpopSigningAlgValuesSupported`、`dpopProofMaxAgeSeconds`、`dpopProofLeewaySeconds`）、クライアントのメタデータ（`dpopBoundAccessTokens`）、CORS は、ドキュメントの [DPoP（拡張）](../../docs/library-document/src/content/docs/guides/dpop.md) を参照。

## 制限事項

- **サーバーが発行する nonce（RFC 9449 §8 / §9）には対応していない。** `nonce` クレームは確かめず、DPoP proof の新しさは `iat` の範囲と `jti` の再利用の拒否で確かめる
- **登録した鍵に限らない。** DPoP proof の `jwk` ヘッダーの鍵で署名を検証し、その鍵に束縛する。クライアントが事前に鍵を登録する必要は無い
- **HTTP の配線は行わない。** ヘッダーの読み取り、エラーレスポンスの組み立て、`jti` を覚えるストアは呼び出し側が用意する（CLI の生成コードが行う）

## ライセンス

MIT
