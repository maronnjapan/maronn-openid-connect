# イントロスペクションが、鍵に束縛したトークンの確認と token_type を返すようにする（DPoP の段 9）

DPoP（RFC 9449）を生成 OP に入れる段の 9 つ目で、イントロスペクションエンドポイントが、鍵に束縛したアクセストークンを、保存したレコードの `cnf`（確認）と `token_type` を付けて報告するようにする。
RFC 9449 §6.2 は、DPoP で束縛したアクセストークンをイントロスペクションで報告するとき、その鍵の JWK SHA-256 Thumbprint をトップレベルの `cnf.jkt` で返し、`token_type` を返すなら `DPoP` にするとしている。
不透明な文字列のトークンを受け取るリソースサーバーは、イントロスペクションの答えからしか、提示された DPoP proof の鍵とトークンの鍵を照らし合わせられないためである。
段 7 と段 8 で、束縛したトークンのレコードには `cnf` と `tokenType` が残るようにしたので、この段ではそれを読んでレスポンスに加える関数を `token-binding.ts` に足し、Hono と Next.js のイントロスペクションから呼ぶ。
この段では、まだどのパイプラインも Route Handler もトークンを束縛しないので、イントロスペクションの答えは変わらない。`cnf` の無いレコードには、前と同じレスポンスをそのまま返す。

## withTokenBinding, confirmationOf <!-- hono:oidc-provider/token-binding.ts#withTokenBinding hono:oidc-provider/token-binding.ts#confirmationOf nextjs:app/_oidc-provider/token-binding.ts#withTokenBinding nextjs:app/_oidc-provider/token-binding.ts#confirmationOf -->

有効なアクセストークンのレスポンスに、保存したレコードの `cnf` と `token_type` を加える関数と、レコードの `cnf` を読む関数を足した（Hono と Next.js で同じ中身）。
本体は DPoP の機能を読み込めないので、段 7 の `token-binding.ts` と同じく、束縛を「レコードの `cnf` と `tokenType`」としてだけ扱う。

- `confirmationOf()` は、`cnf` が JSON のオブジェクトのときだけ返す。SQL と KV のレコードの `cnf` は `payload` の JSON から読んだ値で、独自のコードが書いたレコードもあるので、型を信じずに形を確かめる
- レコードに `tokenType` が無くても、`cnf` が `jkt` を持てば `token_type` を `DPoP` にした。`jkt` は RFC 9449 §6.1 が定める DPoP の確認のメソッドで、§6.2 は DPoP で束縛したトークンの `token_type` を返すなら `DPoP` でなければならないとしているためである。PR #205 はこのとき core の `Bearer` をそのまま返していた
- `jkt` 以外の確認（mTLS の `x5t#S256` など）で `tokenType` の無いレコードは、`cnf` だけを加えて `token_type` は変えない。RFC 8705 の束縛したトークンは `Bearer` のままだからである
- `cnf` はレスポンスの最後のメンバーとして加え、ほかのメンバーとその順番は core の組み立てたままにした
- core の `IntrospectionResponse` は `token_type` に `Bearer` と `refresh_token` しか認めず、`cnf` も持たないので、core は変えずに、返す値の型だけを広げた。core の公開 API を変えると、experimental と google-login のリリースまで要るためである
- `jwt-introspection-response` 機能の署名付きの応答（RFC 9701）は同じレスポンスに署名するので、`token_introspection` にも `cnf` が入る。Hono と Next.js のテストで確かめた

## describeIntrospectedToken <!-- hono:oidc-provider/features/introspection/endpoints/introspection/steps/build-response.ts#describeIntrospectedToken -->

有効なアクセストークンのレスポンスを `withTokenBinding()` に通すようにした。
`cnf` を返すのはアクセストークンだけで、リフレッシュトークンは束縛していても前と同じレスポンスにした。RFC 9449 §6.2 が定めるのはアクセストークンのイントロスペクションで、リソースサーバーがリフレッシュトークンを受け取ることは無いためである。

- PR #205 の三項演算子の `return` を、`if` の早期 `return` と `return response` に分けた。地図の流れの図で、束縛を加えて返す出口と、そのまま返す出口が別の箱として名前を持つようにするためである
- 地図の E2E（`apps/map/e2e/edit.spec.ts`）は、有効なトークンの側の箱を「有効なトークンのレスポンスを組み立てて返す」で探すように変えた。この箱は `return` の出口から、レスポンスを組み立てる呼び出しの箱に変わったためである

## introspect <!-- nextjs:app/(introspection)/introspect/route.ts#introspect -->

`[build-response]` のブロックで、有効なアクセストークンのレスポンスを `withTokenBinding()` に通すようにした。理由と、リフレッシュトークンに `cnf` を返さない理由は Hono の `describeIntrospectedToken()` と同じである。
Next.js にはイントロスペクションの Route Handler のテストが無かったので、`route.test.ts` を足し、束縛の無いトークン、束縛したトークン（JSON と署名付きの JWT）、束縛したリフレッシュトークン、知らないトークンの答えを確かめた。
束縛したレコードは、テストの中で段 7 の `accessTokenRecordOf()` と `refreshTokenRecordOf()` から組み立てて、ストアに入れた。
