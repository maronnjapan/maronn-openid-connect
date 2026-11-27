---
---

リリースは要らない。生成するコードは変わらない。

DPoP（RFC 9449）の機能のディレクトリ（Hono の `oidc-provider/features/dpop/`、Next.js の `app/_oidc-provider/features/dpop/`）に、DPoP proof の `jwk` ヘッダーの公開鍵の検査、JWS の署名の検証、JWK Thumbprint の計算、base64url、検査の失敗のエラー、受け付ける alg の設定を足した。
CLI の機能の一覧にはまだ `dpop` が無く、どの `--enable` でもこのディレクトリは生成されない（`--enable dpop` は知らない機能として拒まれる）ので、生成される OP に変わりはない。
パッケージの雛形にはこのディレクトリのファイルが入るが、生成には使われない。
