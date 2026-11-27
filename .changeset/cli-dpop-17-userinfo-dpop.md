---
'@maronn-openid-connect/cli': minor
---

`--enable dpop` で生成した UserInfo エンドポイントが、DPoP（RFC 9449）の認証スキームで提示したアクセストークンを受け付け、DPoP の鍵に束縛したアクセストークンを Bearer としては受け付けないようにする。

- `Authorization: DPoP <アクセストークン>` と、`DPoP` ヘッダーの DPoP proof を送ったリクエストでは、DPoP proof を検査し（`htm` はリクエストのメソッド、`htu` は issuer の `/userinfo`、`ath` はそのアクセストークンのハッシュ。RFC 9449 §4.3 / §7）、アクセストークンがその鍵に束縛されている（保存したレコードの `cnf.jkt` が DPoP proof の鍵の JWK Thumbprint と同じ）ときだけクレームを返す（RFC 9449 §7.1）。
- DPoP proof が無いか受け付けないときは 401 の `invalid_dpop_proof`、アクセストークンが DPoP proof の鍵に束縛されていない（束縛が無い、別の鍵）ときは 401 の `invalid_token` で応答する。`Authorization: DPoP` の値が一つの token68 でない（`DPoP` だけ、空白やコンマを含む値）ときと、フォームのボディの `access_token` も送ったときは 400 の `invalid_request` で応答する（RFC 9449 §7.1、RFC 6750 §2 / §3.1）。どれも理由を書いた `error_description` 付きで、キャッシュさせない。
- DPoP スキームで提示したリクエストの失敗には、`WWW-Authenticate` の `Bearer realm="UserInfo"` の後ろに、受け付ける alg を並べた DPoP のチャレンジ（`DPoP algs="ES256 …"`）を足し、エラーの情報はそのチャレンジに入れる（RFC 9449 §7.1 / §7.2）。期限切れのトークンや `openid` スコープの無いトークンなど、トークンを取得した後の失敗も同じである。`algs` は、`dpopSigningAlgValuesSupported` のうち検査できる alg で、Discovery の `dpop_signing_alg_values_supported` と同じである。
- DPoP の鍵に束縛したアクセストークンを Bearer（`Authorization: Bearer` か、フォームのボディの `access_token`）で提示したリクエストは、401 の `invalid_token` で拒否する（RFC 9449 §7.2 の MUST）。Bearer で提示したので、エラーの情報は Bearer のチャレンジに入る。
- 束縛の無いアクセストークンを Bearer で提示したリクエストと、`Authorization: DPoP` を送らないリクエストへの答えは、`WWW-Authenticate` が `Bearer realm="UserInfo"` だけなのも含めて、これまでと同じである。
- 生成コードには、Hono（Express、Fastify を含む）の UserInfo エンドポイントのパイプラインに `[read-dpop-access-token]`（`features/dpop/steps/read-dpop-access-token.ts` の `readDpopUserInfoRequest(c, challenges)`）と `[verify-dpop-access-token]`（`features/dpop/steps/verify-dpop-access-token.ts` の `verifyDpopUserInfoAccess(tokenInfo, dpopJkt)`）のステップが、Next.js の `userinfo/route.ts` に同じ名前のブロック（`_oidc-provider/features/dpop/userinfo.ts` の `readDpopUserInfoRequest(request, challenges)` と `verifyDpopUserInfoAccess(tokenInfo, dpopJkt)`）が加わる。どちらも、保護されたリソースの検査を集めた `features/dpop/resource.ts` を呼ぶ。DPoP の検査のエラーコード（`DpopErrorCode`）に `invalid_token` と `invalid_request` が加わる。

この段階で止めたリリースは、RFC 9449 の MUST のうち、認可コードの鍵への束縛をまだ満たさない。認可リクエストの `dpop_jkt` を読まないので、トークンリクエストの DPoP proof の鍵がそれと違っても拒否しない（§10）。`par` と一緒に有効にしても、PAR の `dpop_jkt` と `DPoP` ヘッダーを受け付けない（§10.1）。どちらも後のリリースで加える。`dpop_bound_access_tokens`（§5.2）、サーバーが発行する nonce（§8 / §9）、認証情報の無いリクエストと Bearer のトークンの失敗にも DPoP のチャレンジを並べること（§7.2 の RECOMMENDED）も後のリリースである。

`dpop` を有効にしない生成物は、UserInfo エンドポイントの `[parse-access-token]` の前に `const dpopAccessToken = undefined;` が入り、アクセストークンを `dpopAccessToken ?? (await …)` で決めるようになる（答えは変わらない）。UserInfo エンドポイントのパイプライン（Hono、Express、Fastify の `endpoints/userinfo/pipeline.ts`）か Next.js の `userinfo/route.ts` に手を加えている場合は、生成し直したあと、その変更を新しい形に移す。
