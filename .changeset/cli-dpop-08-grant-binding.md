---
'@maronn-openid-connect/cli': patch
---

生成コードの、機能が答えるグラントの dispatch が、トークンを鍵に束縛する省略できる入力 `binding`（`token-binding.ts` の `TokenBinding`）を受け取るようにする。後の段で加える DPoP（RFC 9449）の機能が、`client_credentials`、デバイス認可、CIBA、トークン交換、ID-JAG の引き換えで発行するトークンを、DPoP proof の鍵に束縛するときに使う（RFC 9449 §5 は、グラントの種類によらずアクセストークンを束縛するとしている）。

- Hono（Express、Fastify を含む）のステップ `issueClientCredentialsToken()`、`redeemDeviceCode()`、`redeemCibaRequest()`、`exchangeToken()`、`redeemIdJag()` は、最後の引数に `binding` を受け取る。ステップの説明の入力には、省略できる `tokenBinding` が加わる。
- Next.js の `dispatchClientCredentials()`、`dispatchDeviceCode()`、`redeemDeviceCode()`、`dispatchCiba()`、`redeemCibaRequest()`、`dispatchTokenExchange()`、`exchangeToken()`、`dispatchIdJagRedemption()`、`redeemIdJag()` も、最後の引数に `binding` を受け取る。
- `binding` を渡すと、アクセストークンに `cnf` が入り、保存するアクセストークンのレコードに `cnf` と `tokenType` が残り、レスポンスの `token_type` が束縛の `tokenType` になる。デバイス認可と CIBA は、束縛が `refreshTokenCnf` を持つときだけ、リフレッシュトークンのレコードにもそれを `cnf` として残す。

今はどのパイプラインも Route Handler も `binding` を渡さないので、これらのグラントの応答、発行するアクセストークン、保存するレコードは変わらない。
`client_credentials` とトークン交換のレスポンスは、core が組み立てたレスポンスの `token_type` を上書きする形にしたので、レスポンスのメンバーとその順番も変わらない。
