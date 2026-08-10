---
title: Token Exchange (RFC 8693)
description: 手元のアクセストークンを、権限を絞った別のアクセストークンへ交換する RFC 8693 の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

サービス間連携で「受け取ったトークンをそのまま下流へ横流しする」構成には 2 つの問題があります。

1. **過剰権限の伝播**: フロント API が受けたトークンはユーザーの全 scope を持ちます。これを内部サービスへそのまま渡すと、内部サービスが必要以上の権限を持つトークンを扱うことになります
2. **audience 検証の形骸化**: トークンの `aud` がフロント API 向けのままだと、内部サービスは「自分宛でないトークン」を受け入れるか、拒否して連携できなくなるかの二択になります

Token Exchange は、トークンエンドポイントに新しい grant type を追加し、**手元のトークンを、必要最小限の scope・正しい audience を持つ新しいトークンへ交換する**標準手段を提供します。

```text
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
```

交換で権限は**単調に狭まります**。scope は元トークンの部分集合、audience は許可リスト内、有効期限は元トークンの残存期間以下、`sub` は変更不可です。

## 対応仕様

| 仕様 | 対応範囲 |
|---|---|
| RFC 8693 §2.1 | 交換リクエスト（`subject_token` / `subject_token_type` / `scope` / `audience` / `resource` / `requested_token_type`） |
| RFC 8693 §2.2.1 | 成功レスポンス（`access_token` / `issued_token_type` / `token_type` / `expires_in` / `scope`） |
| RFC 8693 §2.2.2 | エラーレスポンス（`invalid_target` を含む） |
| RFC 8693 §3 | token type identifier（`urn:ietf:params:oauth:token-type:access_token` のみ） |
| RFC 8693 §1.1 | impersonation のみ。**delegation は非対応** |
| RFC 8693 §4 | **非対応**（`act` / `may_act` claim） |
| RFC 8693 §2.1（複数指定） | **非対応**（`audience` / `resource` の複数出現） |

## ユースケース

- API ゲートウェイが受けたユーザートークンを、内部サービス専用の audience 制限付きトークンへ交換する構成を検証する
- 「scope を落としたトークンを下流に配る」（least privilege）設計が自分のクライアント実装で成立するか確認する
- 交換ポリシー（対象許可リスト・クライアント許可）の設計を、IdaaS 導入前に手元で試す

## 前提条件

- 生成 OP を `--enable token-exchange` で作成していること
- 交換を行うクライアントが **confidential client** であること（public client は拒否されます）
- そのクライアントの `grantTypes` に交換 URN が登録されていること
- `subject_token` が**この OP 自身が発行したアクセストークン**であること（外部 IdP 発行トークンは非対応）

## 有効化

```bash
maronn-oidc generate hono --enable token-exchange
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`--enable token-exchange` を付けなかった場合、Token Exchange に関するコードは一切生成されず、インストール案内にも `@maronn-openid-connect/experimental` は現れません。付けずに生成した出力は、この機能が存在しなかった頃と**バイト単位で同一**です。

`@maronn-openid-connect/core` は `@maronn-openid-connect/experimental` の peerDependency です。experimental は core のエラークラスを `instanceof` で判定するため、アプリ内の core インスタンスが 1 つでないと判定が静かに失敗します。experimental は core より速く更新されるので、**バージョン番号が揃っていない状態は正常です**。インストール時に `unmet peer @maronn-openid-connect/core` が出たときだけ core を上げてください。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/token.ts` | 交換 grant の分岐、設定値 `tokenExchangeConfig`、`TokenExchangeError` の catch 分岐 |
| `routes/discovery.ts` | `grant_types_supported` への交換 URN の追加 |
| `config.ts` | サンプルクライアントの `grantTypes` への交換 URN の追加 |
| `conformance.test.ts` | Token Exchange の契約テストの追加 |

**新しいエンドポイントは増えません。** 既存のトークンエンドポイントに分岐が 1 つ加わるだけです。

## 設定

有効化した直後は、**対象指定付きの交換はすべて拒否されます**。`allowedTargets` が空だからです（安全側デフォルト）。下流サービスの識別子を明示的に追加してください。

```typescript
// routes/token.ts
export const tokenExchangeConfig = {
  allowedTargets: [] as string[],
};
```

```typescript
// 内部サービス 2 つへの交換を許可する例
export const tokenExchangeConfig = {
  allowedTargets: [
    'internal-billing-api',
    'https://internal.example.com/orders',
  ],
};
```

`audience`（論理名）と `resource`（URI）は同じ許可リストで検証されます。リストが空でも、**scope 縮小・期限短縮だけの交換は成立します**（対象は元トークンの audience を継承）。

交換を許可するクライアントは `config.ts` 側で明示します。

```typescript
grantTypes: [
  'authorization_code',
  'urn:ietf:params:oauth:grant-type:token-exchange',
],
```

発行トークンの有効期間に専用設定はありません。`config.accessTokenExpiresIn` と `subject_token` の残存秒数の**小さい方**になります。

## フロー

```text
Client (confidential)                          OP
  |  （事前に Authorization Code Flow 等で         |
  |    subject_token = アクセストークンを取得）     |
  |                                              |
  |--- POST /token ----------------------------->|  クライアント認証（通常のトークン
  |    grant_type=...:token-exchange             |  リクエストと同じ規則）
  |    subject_token=<access token>              |  交換 grant の登録確認
  |    subject_token_type=...:access_token       |  パラメータ検証
  |    [scope=...] [audience=... | resource=...] |  subject_token の有効性検証
  |                                              |  scope 縮小・対象許可リストの検証
  |                                              |  新トークン発行（期限は残存期間で cap）
  |<-- 200 {access_token, issued_token_type, ----|
  |         token_type, expires_in, scope}       |
  |                                              |
  |--- 交換後トークンで下流 API / userinfo ------->|  既存の検証経路がそのまま通る
```

### リクエスト例

```http
POST /token HTTP/1.1
Host: op.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange
&subject_token=2YotnFZFEjr1zCsicMWpAA
&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token
&scope=openid%20profile
&audience=internal-billing-api
&client_id=gateway&client_secret=s3cret
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
Pragma: no-cache

{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "openid profile"
}
```

`expires_in: 300` は「設定値は 3600 秒だが `subject_token` の残存が 300 秒しかない」ケースです。交換でトークンの寿命は伸びません。

`scope` は要求と同一でも常に含まれます。`refresh_token` は発行されません。

## API 利用例

生成コードを使わず core / experimental を直接組み込む場合は、合成関数かステップ関数を呼び出します。トークンの**発行と保存はこのモジュールでは行いません**。RFC 8693 固有の検証・導出だけを担当し、発行は core の既存部品と組み合わせます。

```typescript
import {
  TOKEN_EXCHANGE_GRANT_TYPE,
  processTokenExchangeRequest,
  buildTokenExchangeResponse,
} from '@maronn-openid-connect/experimental/token-exchange';
import { buildAccessTokenAudience, buildAccessTokenPayload } from '@maronn-openid-connect/core';

// 1. 検証と発行素材の導出
const grant = await processTokenExchangeRequest({
  params,                  // フォームボディ（Record<string, string>）
  client: tokenClient,     // 認証済みクライアント（core の TokenClientInfo）
  accessTokenResolver,     // core の AccessTokenResolver
  allowedTargets: ['internal-billing-api'],
  configuredExpiresIn: 3600,
});
// => { subject, clientId, scope, requestedAudience, expiresIn, grantId }

// 2. 発行と保存は core の既存パイプラインで行う
const audience = buildAccessTokenAudience({
  userInfoEndpoint: `${issuer}/userinfo`,
  requested: grant.requestedAudience,
  issuer,
});
const token = await accessTokenIssuer.issue({
  payload: buildAccessTokenPayload({ issuer, subject: grant.subject, /* ... */ }),
  privateKey,
  keyId,
});

// 3. RFC 8693 §2.2.1 のレスポンスボディ
return buildTokenExchangeResponse({
  accessToken: token,
  expiresIn: grant.expiresIn,
  scope: grant.scope,
});
```

ステップ関数（`authorizeTokenExchangeClient` / `parseTokenExchangeParams` / `resolveSubjectToken` / `validateExchangeScope` / `resolveExchangeTarget` / `computeExchangedTokenLifetime`）を個別に呼べば、検証の差し替えや削除ができます。`processTokenExchangeRequest` はこれらを仕様順に合成しただけの関数です。

### 分岐の位置

生成コードは、交換 grant を**クライアント認証の直後・core の `validateGrantTypeSupported` より前**で分岐させます。core はこの URN を知らないため、後ろに置くと `unsupported_grant_type` で拒否されて分岐に到達しません。自分で組み込む場合も同じ順序にしてください。

## エラー処理

すべて JSON です（既存のトークンエンドポイントと同一形式、`Cache-Control: no-store` / `Pragma: no-cache` 付き）。**リダイレクトは発生しません**。

| 条件 | HTTP | error |
|---|---|---|
| クライアント認証失敗 | 401 | `invalid_client` |
| クライアントの `grantTypes` に交換 URN が未登録 | 400 | `unauthorized_client` |
| public client からの交換要求 | 400 | `unauthorized_client` |
| `subject_token` / `subject_token_type` 欠落 | 400 | `invalid_request` |
| `subject_token_type` / `requested_token_type` が非対応値 | 400 | `invalid_request` |
| `actor_token` / `actor_token_type` の存在（delegation 要求） | 400 | `invalid_request` |
| `resource` が絶対 URI でない・fragment を含む | 400 | `invalid_request` |
| `subject_token` が無効（不存在・期限切れ・失効済み・nbf 未来） | 400 | `invalid_request` |
| 要求 scope が `subject_token` の scope を超過 | 400 | `invalid_scope` |
| `audience` / `resource` が `allowedTargets` 外 | 400 | `invalid_target` |

:::note[`invalid_grant` ではありません]
無効な `subject_token` は **`invalid_request`** です。RFC 8693 §2.2.2 がそう定めています。authorization_code / refresh_token grant の感覚で `invalid_grant` を期待するとテストを誤ります。
:::

`subject_token` の解決に失敗したときの `error_description` は、失敗の種別によらず同一です（`The provided subject_token is not valid`）。応答差から「そのトークンが存在したか・失効したか」を判別できないようにするためです。`invalid_target` の `error_description` も固定で、`allowedTargets` の内容を露出しません。

## セキュリティ上の注意

| 論点 | 実装 / 注意点 |
|---|---|
| 窃取トークンの増幅 | RFC 8693 §2.1 は「クライアント認証を省くと、窃取されたトークンを STS 経由で別のトークンへ増幅できる」と注記しています。本実装はクライアント認証必須に加え、**public client を拒否**し、クライアント単位で交換 URN の明示登録を要求します |
| 権限昇格 | 要求 scope は `subject_token` の部分集合のみ。省略時も継承であり拡大しません |
| 対象の不正拡大 | `allowedTargets` 許可リスト（既定は空）外は `invalid_target`。`sub` は変更されません |
| トークン寿命の洗浄 | `expires_in = min(設定値, subject の残存秒数)`。交換を連鎖しても寿命は単調減少します |
| 失効の回避 | 交換後トークンは `subject_token` の `grantId` を継承して保存されるため、grant 単位の失効（認可コード再利用検知など）が交換後トークンにも波及します |
| 存在確認オラクル | 解決失敗の `error` / `error_description` を失敗種別で区別しません |
| リプレイ | `subject_token` は**消費されません**。RFC 8693 は単回使用を要求しておらず、有効期間内の再交換は正当な利用形態です |
| ログ | `subject_token`・発行したアクセストークン・`client_secret`・Authorization ヘッダを**ログに出力しないでください**。出してよいのは `client_id`・`jti`・エラーコードです |

`allowedTargets` を広げるほど、交換を許可したクライアントが到達できる下流サービスが増えます。**必要な対象だけを列挙してください**。

## 既知の制約

- **delegation 非対応**: `actor_token` / `actor_token_type` を含むリクエストは `invalid_request` で拒否されます。`act` / `may_act` claim（RFC 8693 §4）も未実装です
- **`audience` / `resource` は単一値のみ**: RFC 8693 §2.1 は複数出現を許容しますが、生成 OP のトークンエンドポイントは RFC 6749 §3.2 に基づき重複パラメータを 400 で拒否します。意図的な制限です
- **`subject_token` はこの OP 発行のアクセストークンのみ**: id_token / refresh_token / JWT / SAML アサーションや、外部 IdP が発行したトークンは受け付けません
- **発行できるのはアクセストークンのみ**: 交換で ID Token や refresh token は発行されません。`openid` scope が残っていても ID Token は返りません（UserInfo へのアクセスは可能なままです）
- **`claims` パラメータは継承されません**: 認可時に `claims`（OIDC Core 1.0 §5.5）で要求した個別クレームは交換後トークンへ伝播しません。交換後トークンで UserInfo を呼ぶと scope ベースのクレームだけが返ります。認可時の同意対象を交換経由で下流へ広げないための設計です
- **`allowedTargets` はグローバル設定のみ**: クライアント単位の対象許可は非対応です

## core 機能との違い

- **refresh_token grant との違い**: refresh は「同一クライアント・同一権限のトークンを更新する」機構で、寿命は延びます。exchange は「別 audience・縮小 scope のトークンを新規に作る」機構で、寿命はむしろ短くなります。両者は代替関係にありません
- **introspection との違い**: introspection はトークンの状態を照会するだけで新しいトークンを作りません。exchange は内部で同等の検証を行った上で発行まで進みます
- **PAR との違い**: PAR は認可リクエストの受け渡し方法（authorize 前段）、exchange はトークン発行の新 grant（token 分岐）です。挿入点も設定も独立しており、両方同時に有効化できます

## トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `unsupported_grant_type` が返る | `--enable token-exchange` を付けずに生成しています。再生成してください（discovery の `grant_types_supported` で確認できます） |
| `Cannot find module '@maronn-openid-connect/experimental/token-exchange'` | `pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental` を実行してください |
| `unauthorized_client: The client is not authorized to use the token-exchange grant type` | クライアントの `grantTypes` に交換 URN が入っていません。`config.ts`（または実際のクライアント登録元）に追加してください |
| `unauthorized_client: Public clients are not allowed...` | public client からの交換は仕様上の設計判断で拒否しています。confidential client を使ってください |
| `invalid_target` が返る | `tokenExchangeConfig.allowedTargets` に対象が入っていません。既定は空です |
| `invalid_request: The provided subject_token is not valid` | `subject_token` が不存在・期限切れ・失効済み・nbf 未来のいずれかです。種別は意図的に区別されません |
| 交換後トークンで UserInfo が 401 | `aud` 検証で落ちている可能性があります。OP の UserInfo エンドポイントは常に `aud` の恒久メンバとして含まれるので、生成コードの `buildAccessTokenAudience` 呼び出しを消していないか確認してください |
| 交換後トークンの UserInfo に個別クレームが出ない | 仕様どおりです。`claims` パラメータは継承されません（既知の制約を参照） |
| `expires_in` が設定値より小さい | 仕様どおりです。`subject_token` の残存期間で cap されています |
| `invalid_request: Parameter "resource" must not be repeated` | `resource` / `audience` は単一値のみ対応です（既知の制約を参照） |
| 交換のエラーが 500 になる | core が二重にインストールされ、`instanceof` 判定が失敗している可能性があります。`pnpm why @maronn-openid-connect/core` で単一バージョンに解決されているか確認してください |

## 参考資料

- [RFC 8693: OAuth 2.0 Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
- [RFC 6749: The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)（クライアント認証・エラー形式）
- [RFC 9068: JWT Profile for OAuth 2.0 Access Tokens](https://datatracker.ietf.org/doc/html/rfc9068)（`aud` の非空要件）
- [RFC 8707: Resource Indicators for OAuth 2.0](https://datatracker.ietf.org/doc/html/rfc8707)（`resource` パラメータの背景）
