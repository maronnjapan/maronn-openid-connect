---
'@maronn-openid-connect/cli': minor
---

拡張機能に `dpop`（OAuth 2.0 Demonstrating Proof of Possession、RFC 9449）を加え、`maronn-oidc generate <framework> --enable dpop` で生成できるようにする。既定は無効で、`--enable dpop` を付けない生成物は変わらない（`.maronn-openid-connect.json` の `features` に `"dpop": false` が増えるだけ）。

DPoP は、このリリースから後のリリースにかけて段階的に組み上げる。まずトークンエンドポイントが DPoP proof を検査してアクセストークンをその鍵に束縛し、続いてリフレッシュトークン、UserInfo エンドポイント、認可エンドポイントの `dpop_jkt`、PAR、`dpop_bound_access_tokens`、サーバーが発行する nonce を足していく。このリリースの `--enable dpop` が生成するのは次のものだけで、どのエンドポイントもまだ DPoP proof を検査しないので、トークンはすべて Bearer のまま発行される。ディスカバリーも、DPoP に対応していることを示す `dpop_signing_alg_values_supported`（RFC 9449 §5.1）をまだ返さない。トークンエンドポイントが DPoP proof を検査するリリースで返し始める。

- `features/dpop/`（Next.js は `_oidc-provider/features/dpop/`）に、DPoP proof の検査（`proof.ts`、`jwk.ts`、`htu.ts`）と、その設定を生成する。設定は `ProviderConfig` の `dpopSigningAlgValuesSupported`（DPoP proof の署名に受け付ける alg。既定は `jwk.ts` が検証できるすべての非対称の alg）、`dpopProofMaxAgeSeconds`、`dpopProofLeewaySeconds`（DPoP proof の `iat` の範囲。既定はどちらも 60 秒）である。どのファイルも Web Crypto だけを使い、core のほかに package を読み込まないので、インストールするものは増えず、エッジのランタイムでも動く。
- クライアントが直接呼ぶエンドポイント（トークン、UserInfo、イントロスペクション、PAR など）の CORS が、`Access-Control-Allow-Headers` に `DPoP` を加え、`Access-Control-Expose-Headers` に `WWW-Authenticate` を出す。

あわせて、CLI の拡張機能の定義を「上流の ID プロバイダーを package で取り込むもの」から「実験的ではない、任意で足す機能」に改め、`--help` と README に `dpop` を載せる。`generate` と `setup` が出す拡張機能の案内は、有効にした拡張機能ごとに出す（`--enable dpop` だけのときに Google でログインの案内は出ない）。
