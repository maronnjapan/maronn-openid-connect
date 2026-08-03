---
'@maronn-oidc/core': minor
'@maronn-oidc/cli': minor
---

発行するアクセストークンに `jti` を付与し、同一秒の再発行がバイト同一トークンになる問題を修正した。

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
