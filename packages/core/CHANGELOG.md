# @maronn-oidc/core

## 0.2.0

### Minor Changes

- 14ac754: 発行するアクセストークンに `jti` を付与し、同一秒の再発行がバイト同一トークンになる問題を修正した。

  RS256（RSASSA-PKCS1-v1_5, RFC 8017 §8.2）は決定的な署名方式のため、`buildAccessTokenPayload` の
  出力に発行ごとの可変要素が無いと、`(iss, sub, aud, scope, client_id)` が同じ 2 回の発行が同じ
  壁時計秒に落ちたときにアクセストークン文字列がバイト単位で一致していた。生成 OP は
  アクセストークン文字列をキーにしてメタデータを保存するため、後の発行が先のレコードを
  黙って上書きし、次の実害が出ていた。

  - 先の grant に対する `grantId` 単位の失効（認可コード再利用検知・同意撤回・リフレッシュ
    トークンファミリー失効。OAuth 2.1 §4.1.2 / RFC 9700 §4.13）が対象トークンに届かない
  - refresh 経路の `claims: undefined` が authorization_code 経路で保存済みの `claims` を
    上書きし、UserInfo が無言で縮退する
  - rotation 後のアクセストークンが初回と同一値になり、初回トークンの漏洩をリフレッシュで
    断ち切れない

  Opaque 形式（`accessTokenFormat: 'opaque'`）は元から 256bit の乱数なので影響を受けない。

  ### @maronn-oidc/core

  - `AccessTokenPayload` に `jti?: string` を追加した（RFC 9068 §2.2 の REQUIRED クレーム）
  - `AccessTokenPayloadInput` に `jti?: string` を追加し、`buildAccessTokenPayload` は未指定なら
    128bit の CSPRNG 値を生成するようにした。既存の識別子を再利用したい場合のみ明示的に渡す
  - `AccessTokenIssuer.issue()` の JSDoc に「戻り値は発行ごとに一意でなければならない」という
    契約を明記した。独自 issuer に差し替える利用者向けの前提提示

  ### @maronn-oidc/cli

  - 生成される token route が、core が発行した `jti` をアクセストークンのメタデータとして
    保存するようにした。イントロスペクション（RFC 7662 §2.2）が `jti` を返せるようになる。
    Experimental の token-exchange を有効化した場合の交換後トークンも同様
  - 生成される `conformance.test.ts` に不変条件を追加した: rotation 後のアクセストークンが
    初回と異なること、rotation 後の ID Token が `iss` / `sub` / `aud` / `auth_time` を保持し
    `azp` を増やさないこと、同一秒に発行した 2 つの grant が互いの失効に巻き込まれないこと、
    イントロスペクションが実トークンの `jti` をエコーすること

  ### 移行上の注意

  - 発行される JWT アクセストークンに `jti` クレームが増える。トークンの claim 集合を
    完全一致で固定しているリソースサーバー側のテストは更新が必要
  - `buildAccessTokenPayload` の戻り値を `toEqual` で固定しているテストも同様に更新が必要
  - 既存の API シグネチャに破壊的変更は無い（`jti` は入力・出力とも optional）

## 0.1.0

### Minor Changes

- 45df806: CLI に機能トグル（--enable / --disable）を追加。pkce / refresh-token / introspection / revocation / request-object をデフォルトの全部入り構成から機能単位で増減して生成できるようにし、生成される conformance.test.ts も選択構成に合わせて無効挙動を契約テストとして固定するようにした。

  core は各エンドポイントの処理を機能単位のステップ関数として公開し、CLI 生成コードも合成関数ではなく各ステップを直接呼び出す形にした。

  - 認可リクエスト検証: クライアント解決 / redirect URI / Request Object / response_type / scope / PKCE / prompt / display / max_age / claims
  - `prompt=none`: `resolvePromptNoneSession` / `validatePromptNoneIdTokenHint` / `validatePromptNoneConsent`
  - クライアント認証: `extractClientCredentials` / `validateClientAuthMethod` / `verifyClientSecret`
  - トークンリクエスト検証: grant_type サポート / クライアント解決 / 期限 / redirect URI / PKCE / 再利用検知
  - トークンレスポンス生成: `buildAccessTokenPayload` / `computeAtHash` / `resolveAcrAmr` / `buildIdTokenPayload` / `generateIdToken`
  - UserInfo: `resolveUserInfoAccessToken` / `validateUserInfoTokenExpiration` / `validateUserInfoScope` / `validateUserInfoAudience` / `resolveUserInfoClaims` / `applyRequestedClaims`
  - Introspection: `requireIntrospectionToken` / `requireIntrospectionClient` / `resolveIntrospectionToken` / `isIntrospectionTokenActive` / `buildIntrospectionResponse`
  - Revocation: `requireRevocationToken` / `requireRevocationClient` / `resolveRevocationTarget` / `validateRevocationTokenClient` / `revokeResolvedToken` / `revokeGrantAccessTokens`

  既存の validateAuthorizationRequest / validateTokenRequest / grant 別関数 / authenticateClient / checkPromptNone / generateTokenResponse / handleUserInfoRequest / handleIntrospectionRequest / handleRevocationRequest は後方互換の合成 API として維持する。supportedGrantTypes（OP が提供する grant の制限）と requestObject.supported（OIDC Core 1.0 §6.3 の request_not_supported 拒否）オプションも追加した。既定の実行時挙動は従来と互換。

### Patch Changes

- c89b96d: 公開済みパッケージが利用者の環境で読み込めなかった 2 件を修正した。

  ### `@maronn-oidc/core`: Node の ESM ローダで解決できる形で publish する

  `packages/core` は `"type": "module"` だが、`src` の相対 import に拡張子が無く、
  `tsconfig.json` の `moduleResolution` が `bundler` だったため、`dist` にも拡張子なしの
  specifier がそのまま emit されていた。Node の ESM ローダは拡張子の補完を行わないので、
  公開済みの `@maronn-oidc/core@0.0.1` は `import '@maronn-oidc/core'` した時点で
  `ERR_MODULE_NOT_FOUND: Cannot find module '.../dist/authorization-request'` になり、
  **バンドラを通さない Node 環境では一切読み込めない状態だった**。

  `samples/*` はすべて esbuild でバンドルしてから起動しており、esbuild は拡張子を補完するため
  リポジトリ内の CI・E2E・conformance では発覚しなかった。

  - `packages/core/src` の相対 import / `export ... from` / 型の `import('./x')` すべてに
    `.js` 拡張子を付けた
  - `packages/core` と `packages/experimental` の `tsconfig.json` を
    `module` / `moduleResolution` ともに `NodeNext` へ変更し、拡張子の付け忘れを
    コンパイル時に落とすようにした（`bundler` に戻すと同じ状態を再び publish できてしまう）

  実行時の挙動と公開 API に変更はない。

  ### `@maronn-oidc/experimental`: core の peer range の下限を `>=0.1.0` へ上げる

  `@maronn-oidc/experimental` は core のステップ関数
  （`extractClientCredentials` / `resolveAuthenticatedTokenClient` /
  `validateClientAuthMethod` / `verifyClientSecret`）を import しているが、これらを export する
  core はまだ publish されていなかった。それにもかかわらず peer range の下限が `>=0.0.1` の
  ままだったため、`@maronn-oidc/experimental@0.0.1` と `@maronn-oidc/core@0.0.1` の組み合わせが
  インストールできてしまい、バンドル時に esbuild が次のエラーで落ちていた。

  ```
  ✘ [ERROR] No matching export in "node_modules/@maronn-oidc/core/dist/index.js"
    for import "extractClientCredentials"
  ```

  下限を `>=0.1.0 <1.0.0` へ上げ、これらを export する core 以降とだけ組み合わせられるようにした。
  古い core を使っている場合はインストール時に `unmet peer` として検出できる。

  あわせて、この下限の管理を手運用から CI へ移した。`pnpm run test:release-contract`
  （`.github/scripts/verify-release-contract.mjs`）に、**experimental の peer range の下限が
  「次に publish される core のバージョン」以上であること**を検査する
  `assertExperimentalCorePeerRangeCoversNextCore` を追加した。experimental はモノレポ内の core
  だけを相手にビルド・テストされるため、それより古い core を下限に据えることは「試していない
  組み合わせ」を許可宣言することに等しい。RELEASE.md「peer range は『下限』を宣言する」に
  書かれていた手順を機械化したもので、下限の上げ忘れは CI で止まる。

  ### 利用者への影響

  `@maronn-oidc/core@0.0.1` および `@maronn-oidc/experimental@0.0.1` は上記のとおり
  組み合わせて利用できない。本リリース以降のバージョンへ更新すること。

- 95c9efe: `@maronn-oidc/experimental` の `@maronn-oidc/core` 参照を `dependencies` から `peerDependencies`（`>=0.1.0 <1.0.0`）へ移した。experimental は core の `AuthorizationError` / `TokenError` を `instanceof` で判定し、resolver / store を CLI 生成コードと受け渡しするため、アプリ内の core インスタンスが 1 つである必要がある。`dependencies` のままだと利用者の core とバージョンがずれたときに core が二重インストールされ、`instanceof` 判定が静かに false になって、本来 `invalid_request` を返す場面が 500 になり得た。バージョン番号の一致は要求しない（experimental は core より速く publish される想定）。

  あわせて次を修正した。

  - `packages/experimental` の publish 対象に LICENSE が含まれていなかったため追加
  - 3 パッケージの `exports` を TypeScript の推奨どおり `types` 条件を先頭へ移動
  - `packages/experimental` の `main` / `types` がビルドされない `dist/index.js` を指していたため削除（公開は `./par` の subpath export のみ）
  - core の minor / major リリース時に experimental も同時にリリースすることを CI で強制する `pnpm run test:release-contract` を追加
