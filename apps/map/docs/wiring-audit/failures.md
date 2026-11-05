# 作業中に落ちた検査と修正

保存した実行ログから失敗部分を抜粋する。すべて再実行で解消済み。最終結果は report.md に示す。

## Hono の Request Object fixture

旧 fixture がコンテキストへ包んだ resolver を置く前提を持っていた。実際の配線と同じ素の resolver と clientJwksFetch 注入へ直し、共有キャッシュのテスト用 URI も分けた。関連再実行と最終 1,699 テストが通過した。

```text
FAIL  src/oidc-provider/features/request-object/steps/resolve-request-object.test.ts > resolveRequestObject > Request Objects of a client with a jwks_uri > should verify a Request Object with the keys of the jwks_uri of the client
AuthorizationError: the client jwks_uri could not be retrieved
 ❯ resolveRequestObjectParams ../../packages/core/src/authorization-request.ts:1008:13
 FAIL  src/oidc-provider/features/request-object/steps/resolve-request-object.test.ts > resolveRequestObject > Request Objects of a client with a jwks_uri > should fetch the jwks_uri again for the kid of a key the client added
AuthorizationError: the client jwks_uri could not be retrieved
 ❯ resolveRequestObjectParams ../../packages/core/src/authorization-request.ts:1008:13
 FAIL  src/oidc-provider/features/request-object/steps/resolve-request-object.test.ts > resolveRequestObject > Request Objects of a client with a jwks_uri > should reject a Request Object signed with a key the jwks_uri does not publish
AssertionError: expected AuthorizationError: the client jwks_uri c… { …(4) } to match object { …(3) }
(3 matching properties omitted from actual)
 FAIL  src/oidc-provider/features/request-object/steps/resolve-request-object.test.ts > resolveRequestObject > request_object_signing_alg > should accept an ES256 Request Object of a client that registered ES256
AuthorizationError: the client jwks_uri could not be retrieved
 ❯ resolveRequestObjectParams ../../packages/core/src/authorization-request.ts:1008:13
 FAIL  src/oidc-provider/features/request-object/steps/resolve-request-object.test.ts > resolveRequestObject > requestObjectSigningAlgValuesSupported > should accept an ES256 Request Object by default
AuthorizationError: the client jwks_uri could not be retrieved
 ❯ resolveRequestObjectParams ../../packages/core/src/authorization-request.ts:1008:13
 Test Files  1 failed | 62 passed (63)
      Tests  5 failed | 402 passed (407)
```

## Hono の初回 typecheck

背景ブランチを取り込んだ後の experimental の dist が古かったためライブラリを再ビルドした。併せて async 関数の戻り値型を Promise として正しく記述した。最終の全 workspace typecheck は通過した。

```text
src/oidc-provider/features/dynamic-client-registration/endpoints/register/steps/validate-metadata.test.ts(172,66): error TS2339: Property 'jwksUri' does not exist on type 'DynamicallyRegisteredClient'.
src/oidc-provider/features/dynamic-client-registration/endpoints/register/steps/validate-metadata.test.ts(196,62): error TS2339: Property 'requestObjectSigningAlg' does not exist on type 'DynamicallyRegisteredClient'.
src/oidc-provider/features/dynamic-client-registration/endpoints/register/steps/validate-metadata.ts(69,5): error TS2353: Object literal may only specify known properties, and 'acceptJwksUri' does not exist in type 'ValidateClientMetadataOptions'.
src/oidc-provider/features/dynamic-client-registration/store.test.ts(153,26): error TS2353: Object literal may only specify known properties, and 'jwksUri' does not exist in type 'Partial<DynamicallyRegisteredClient>'.
src/oidc-provider/features/dynamic-client-registration/store.ts(110,16): error TS2339: Property 'jwksUri' does not exist on type 'DynamicallyRegisteredClient'.
src/oidc-provider/features/dynamic-client-registration/store.ts(110,63): error TS2339: Property 'jwksUri' does not exist on type 'DynamicallyRegisteredClient'.
src/oidc-provider/features/dynamic-client-registration/store.ts(111,16): error TS2339: Property 'requestObjectSigningAlg' does not exist on type 'DynamicallyRegisteredClient'.
src/oidc-provider/features/dynamic-client-registration/store.ts(111,95): error TS2339: Property 'requestObjectSigningAlg' does not exist on type 'DynamicallyRegisteredClient'.
src/oidc-provider/features/id-jag/config.ts(60,45): error TS1064: The return type of an async function or method must be the global Promise<T> type. Did you mean to write 'Promise<IdJagActor | null>'?
```

## Next.js の初回 typecheck

背景ブランチを取り込んだ後の experimental の dist が古かったためライブラリを再ビルドした。併せて async 関数の戻り値型を Promise として正しく記述した。最終の全 workspace typecheck は通過した。

```text
src/app/(dynamic-client-registration)/register/route.ts(169,7): error TS2353: Object literal may only specify known properties, and 'acceptJwksUri' does not exist in type 'ValidateClientMetadataOptions'.
src/app/_oidc-provider/features/dynamic-client-registration/store.test.ts(153,26): error TS2353: Object literal may only specify known properties, and 'jwksUri' does not exist in type 'Partial<DynamicallyRegisteredClient>'.
src/app/_oidc-provider/features/dynamic-client-registration/store.ts(110,16): error TS2339: Property 'jwksUri' does not exist on type 'DynamicallyRegisteredClient'.
src/app/_oidc-provider/features/dynamic-client-registration/store.ts(110,63): error TS2339: Property 'jwksUri' does not exist on type 'DynamicallyRegisteredClient'.
src/app/_oidc-provider/features/dynamic-client-registration/store.ts(111,16): error TS2339: Property 'requestObjectSigningAlg' does not exist on type 'DynamicallyRegisteredClient'.
src/app/_oidc-provider/features/dynamic-client-registration/store.ts(111,95): error TS2339: Property 'requestObjectSigningAlg' does not exist on type 'DynamicallyRegisteredClient'.
src/app/_oidc-provider/features/id-jag/config.ts(63,45): error TS1064: The return type of an async function or method must be the global Promise<T> type. Did you mean to write 'Promise<IdJagActor | null>'?
```

## google-login のローカル待受け

実行環境で localhost の HTTP サーバーを待受けできず、hook がタイムアウトした。ネットワークが許可された実行に切り替え、テスト自体の期待や待ち時間は緩めずに 130 テストが通過した。

```text
FAIL  src/id-token.test.ts [ src/id-token.test.ts ]
Error: Hook timed out in 10000ms.
If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".
 ❯ src/id-token.test.ts:34:1
 FAIL  src/id-token.test.ts [ src/id-token.test.ts ]
TypeError: Cannot read properties of undefined (reading 'close')
 ❯ src/id-token.test.ts:42:15
     40|
Error: listen EPERM: operation not permitted 127.0.0.1
 ❯ Server.setupListenHandle [as _listen2] node:net:2145:21
 ❯ listenInCluster node:net:2224:12
 ❯ node:net:2448:7
⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
 Test Files  1 failed | 7 passed (8)
      Tests  91 passed | 39 skipped (130)
     Errors  1 error
```

## 配線 scanner の shorthand

名前をそのまま property に置く shorthand の参照を取り出せていなかった。compiler の shorthand symbol API を用いて実装の橋と診断を保持するように直した。

```text
Recorded from the initial targeted test run (before shorthand symbol resolution was repaired):

RUN v5.0.5 /workspace/maronn-openid-connect/packages/map-analysis

FAIL src/__tests__/wiring.test.ts > wiring outside ordinary call paths > should inventory inline, named, and shorthand hooks kept in objects without treating them as startup calls
AssertionError: expected [ Array(1) ] to have a length of 2 but got 1

- Expected
+ Received

- 2
+ 1

src/__tests__/wiring.test.ts:64:73
expect(entries.filter((entry) => entry.target === 'lib:a.ts#hook')).toHaveLength(2);

Test Files 1 failed (1)
Tests 1 failed | 4 passed (5)

Cause: getSymbolAtLocation() on a shorthand property name returns the property's symbol, not the function supplied by that property. Resolver.reference() now asks getShorthandAssignmentValueSymbol() for the source value.
Final targeted verification: wiring + output checks, 13 tests passed; map-analysis typecheck passed.
```

## 診断の順序を固定したテスト

同じ行に親関数と callback がある場合の安定ソート順にだけ依存した期待だった。順序ではなく、必要な各診断の存在を検査する形へ直した。最終解析テストは 135 件すべて通過した。

```text
FAIL  src/__tests__/wiring.test.ts > wiring outside ordinary call paths > should retain native iteration callbacks in class methods and default-export functions without a flow frame
AssertionError: expected [ '(item) => item', …(2) ] to deeply equal [ '(item) => item', …(2) ]

- Expected
+ Received

  [
    "(item) => item",
-   "export default function Page() { return ['x'].map((value) => value); }",
    "(value) => value",
+   "export default function Page() { return ['x'].map((value) => value); }",
  ]

 ❯ src/__tests__/wiring.test.ts:127:93


⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 9 passed (10)
      Tests  1 failed | 131 passed (132)
```

## 全件棚卸しをビルドへ組み込んだ初回実行

実行環境の同期子プロセス制限でファイル列挙の rg、続いて git rev-parse が EPERM になった。列挙は外部コマンドを必要としない filesystem API にし、実行を許可された環境で PR ビルドを完走した。検査を外したり欠落を無視したりしていない。

```text
<ref *1> Error: spawnSync rg EPERM
    at Object.spawnSync (node:internal/child_process:1160:20)
    at spawnSync (node:child_process:928:24)
    at execFileSync (node:child_process:971:15)
    at file:///workspace/maronn-openid-connect/scripts/audit-wiring.mjs:22:44 {
  errno: -1,
  code: 'EPERM',
  syscall: 'spawnSync rg',
```
