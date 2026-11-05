# Rich Authorization Requests（RFC 9396）を取り下げる

PR #179 で足した experimental の rar 機能を取り下げる。
rar は一度も publish していない（`.changeset/cli-rar.md` は Version Packages PR に入る前だった）ので、利用者に届いた振る舞いは変わらない。
同じ PR に入っていた地図の検査の修正（関数の閉じかっこの行を関数の行として数える）と、その後に入ったクライアントの `jwks_uri` の扱いは残す。

## introspection <!-- endpoint:introspection -->

rar の取り下げで、`active: true` の応答へ承認済みの `authorization_details` を足すステップを消した。
応答を後から書き換えるステップが無くなったので、応答を受ける変数を `let` から `const` に戻した。

## token <!-- endpoint:token -->

トークンリクエストの `authorization_details` を `invalid_authorization_details` で拒否するステップと、承認済みの details を応答へ足すステップを消した。
rar を入れる前と同じく、トークンリクエストの `authorization_details` は読まずに無視する。
応答を後から書き換えるステップが無くなったので、応答を受ける変数を `let` から `const` に戻した。

## processAuthorizationRequest <!-- hono:oidc-provider/endpoints/authorize/pipeline.ts#processAuthorizationRequest -->

認可リクエストの `authorization_details` を検証して同意を必須にするステップと、トランザクションへ保持するステップを消した。
details 付きのリクエストで `prompt=consent` を補うことも無くなり、同意のスキップは rar を入れる前の判定に戻る。

## prepareConsent <!-- hono:oidc-provider/endpoints/consent/pipeline.ts#prepareConsent -->

同意画面に出す authorization details の表示行を作るステップを消し、`describeConsentScreen()` の呼び出しを rar を入れる前の形に戻した。
同意画面に渡すのは scope などの従来の項目だけになる。

## submitConsent <!-- hono:oidc-provider/endpoints/consent/pipeline.ts#submitConsent -->

承認された authorization details をグラントへ紐付けるステップを消した。
details の保存先（in-memory のストア）も rar と一緒に消している。

## defaultConsentPage <!-- hono:oidc-provider/views.tsx#defaultConsentPage -->

authorization details の表示行を scope の隣に出す部分を消し、rar を入れる前の同意画面に戻した。

## introspect <!-- nextjs:app/(introspection)/introspect/route.ts#introspect -->

Hono の introspection と同じく、承認済みの `authorization_details` を応答へ足すステップを消した。

## authorize <!-- nextjs:app/authorize/route.ts#authorize -->

Hono の `processAuthorizationRequest` と同じく、`authorization_details` の検証と保持のステップを消した。
`prompt` を補う必要が無くなったので、`validatePromptParameter()` の結果を受ける変数を `let` から `const` に戻した。

## POST <!-- nextjs:app/consent/decision/route.ts#POST -->

Hono の `submitConsent` と同じく、承認された authorization details をグラントへ紐付けるステップを消した。

## token <!-- nextjs:app/token/route.ts#token -->

Hono の token と同じく、トークンリクエストの `authorization_details` の拒否と、承認済みの details を応答へ足すステップを消した。
応答を後から書き換えないので、`tokenResponse` を `let` から `const` に戻した。
