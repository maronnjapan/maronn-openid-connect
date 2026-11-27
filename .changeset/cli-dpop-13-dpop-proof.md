---
---

リリースは要らない。生成するコードは変わらない。

DPoP（RFC 9449）の機能のディレクトリ（Hono の `oidc-provider/features/dpop/`、Next.js の `app/_oidc-provider/features/dpop/`）に、リクエストの DPoP proof を検査するモジュール（`proof.ts`、`htu.ts`）を足し、DPoP proof を受け付ける `iat` の範囲の設定（`dpopProofMaxAgeSeconds`、`dpopProofLeewaySeconds`、既定はどちらも 60 秒）を `config.ts` の `ProviderConfig` に足した。
CLI の機能の一覧にはまだ `dpop` が無く、どの `--enable` でもこのディレクトリは生成されない（`--enable dpop` は知らない機能として拒まれる）ので、生成される OP に変わりはない。
パッケージの雛形にはこのディレクトリのファイルが入るが、生成には使われない。
