---
title: PAR (Pushed Authorization Requests)
description: 認可リクエストをバックチャネルで事前に預ける RFC 9126 の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

通常の認可リクエストは、パラメータをブラウザのクエリ文字列（フロントチャネル）で OP に渡します。

```text
GET /authorize?client_id=web-app&response_type=code&redirect_uri=...&scope=openid&code_challenge=...
```

PAR は、この内容を**先にバックチャネルで OP へ POST し、引き換えに短命な参照値（`request_uri`）を受け取る**方式です。ブラウザには参照値だけが乗ります。

```text
GET /authorize?client_id=web-app&request_uri=urn:ietf:params:oauth:request_uri:<参照値>
```

## 対応仕様

| 仕様 | 対応範囲 |
|---|---|
| RFC 9126 §2 | PAR エンドポイント（クライアント認証・事前検証・201 レスポンス・エラー） |
| RFC 9126 §4 | 認可エンドポイントでの `request_uri` 解決（単回使用・期限・クライアント紐付け） |
| RFC 9126 §5 | Provider Metadata（`pushed_authorization_request_endpoint` / `require_pushed_authorization_requests`） |
| RFC 9126 §3 | **非対応**（PAR ボディへの `request` パラメータ、JAR との併用） |
| RFC 9126 §6 | **非対応**（クライアント単位の `require_pushed_authorization_requests`） |
| OIDC Core 1.0 §6.2 | **非対応**（URL 形式の `request_uri`。従来どおり `request_uri_not_supported` で拒否） |

## ユースケース

- FAPI 2.0 など PAR を必須とするプロファイルへの対応可否を、クライアント実装側で検証する
- `claims` パラメータや長い `scope` で URL 長制限に当たる構成を試す
- 認可リクエストの内容（`login_hint` などの PII を含む）をブラウザ履歴・Referer・アクセスログに残さない構成を試す
- PAR を必須にしたとき、既存クライアントがどう壊れるかを安全に確認する

## 前提条件

- 生成 OP を `--enable par` で作成していること
- クライアントが PAR エンドポイントへ POST できること（バックチャネル）
- 実運用では、in-memory ストアを atomic な永続ストアへ差し替えること

public client でも利用できます。クライアント認証規則は Token Endpoint と同一なので、public client は `client_id` の提示のみです（RFC 9126 §2.1）。

## 有効化

```bash
maronn-oidc generate hono --enable par
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`--enable par` を付けなかった場合、PAR に関するコードは一切生成されず、インストール案内にも `@maronn-openid-connect/experimental` は現れません。

`@maronn-openid-connect/core` は `@maronn-openid-connect/experimental` の peerDependency です。experimental は core のエラークラスを `instanceof` で判定するため、アプリ内の core インスタンスが 1 つでないと判定が静かに失敗します。experimental は core より速く更新されるので、**バージョン番号が揃っていない状態は正常です**（`core 0.1.0` + `experimental 0.5.0` など）。インストール時に `unmet peer @maronn-openid-connect/core` が出たときだけ core を上げてください。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/par.ts` | PAR エンドポイント（`POST /par`）と設定値 `parConfig` |
| `store.ts` | `InMemoryPushedAuthorizationRequestStore` と `parStore` シングルトンの追加 |
| `routes/authorize.ts` | `request_uri` を展開する前段フックと、解決失敗を描画する catch 分岐の追加 |
| `routes/discovery.ts` | `pushed_authorization_request_endpoint` の広告 |
| `app.ts` / `apply.ts` | `/par` のマウント・CORS・許可メソッド（POST のみ）の追加 |
| `conformance.test.ts` | PAR の契約テストの追加 |

## 設定

`routes/par.ts` の `parConfig` を編集します。認可エンドポイントもここを参照します。

```typescript
export const parConfig = {
  // request_uri の有効期間（秒）。RFC 9126 §2.2 の推奨レンジは 5〜600。
  // 範囲外の値はモジュール読み込み時に RangeError で失敗します。
  expiresInSeconds: 60,
  // true にすると、PAR を経由しない認可リクエストを invalid_request で拒否します（RFC 9126 §5）。
  requirePushedAuthorizationRequests: false,
};
```

## フロー

```text
Client                                             OP
  |--- POST /par (client 認証 + 認可パラメータ一式) --->|
  |                                                   | クライアント認証
  |                                                   | 認可リクエストとして事前検証
  |                                                   | 参照値を生成しストアへ保存
  |<-- 201 {request_uri, expires_in} ------------------|
  |                                                   |
  |--- GET /authorize?client_id=...&request_uri=... -->|  (ブラウザ)
  |                                                   | ストアから単回使用で取得
  |                                                   | 期限・client_id を検証しパラメータへ展開
  |<-- 302 /login ------------------------------------|
  |            ...以降は通常の Authorization Code Flow...
```

### リクエスト例

```http
POST /par HTTP/1.1
Host: op.example.com
Content-Type: application/x-www-form-urlencoded

response_type=code&client_id=web-app&client_secret=s3cret
&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&scope=openid%20profile
&state=af0ifjsldkj&nonce=n-0S6_WzA2Mj
&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256
```

```http
HTTP/1.1 201 Created
Content-Type: application/json
Cache-Control: no-cache, no-store

{
  "request_uri": "urn:ietf:params:oauth:request_uri:QVXQ4Zq2...",
  "expires_in": 60
}
```

`client_id` は認可リクエストの必須パラメータなので、`client_secret_basic` を使う場合でもボディに含めます（RFC 9126 §2.1）。ボディの `client_id` が認証済みクライアントと一致しない場合は `invalid_request` で拒否されます。

## API 利用例

生成コードを使わず core / experimental を直接組み込む場合は、合成関数かステップ関数を呼び出します。

```typescript
import {
  handlePushedAuthorizationRequest,
  resolvePushedRequestUri,
  type PushedAuthorizationRequestStore,
} from '@maronn-openid-connect/experimental/par';

// PAR エンドポイント
const response = await handlePushedAuthorizationRequest({
  params,                 // フォームボディ（Record<string, string>）
  authorizationHeader,    // client_secret_basic 用
  clientResolver,         // core の ClientResolver & TokenClientResolver
  store,                  // PushedAuthorizationRequestStore
  validationOptions: {},  // core の ValidateAuthorizationRequestOptions
});
// => { requestUri: 'urn:ietf:params:oauth:request_uri:...', expiresIn: 60 }

// 認可エンドポイントの前段
const pushedParams = await resolvePushedRequestUri({ params: queryParams, store });
// URN 形式でなければ null。展開できた場合は request_uri を除いたパラメータ。
```

ステップ関数（`rejectForbiddenParParams` / `authenticateParClient` / `validatePushedAuthorizationParams` / `createPushedAuthorizationRecord` / `buildPushedAuthorizationResponse`）を個別に呼べば、検証の差し替えや削除ができます。

### ストアの差し替え

契約は 2 メソッドだけです。`get` がないのは意図的で、「読むだけ」の操作を排除して単回使用を型で強制するためです。

```typescript
import type { PushedAuthorizationRequestStore } from '@maronn-openid-connect/experimental/par';

const redisParStore: PushedAuthorizationRequestStore = {
  async save(record) {
    const ttl = Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000);
    await redis.set(key(record.requestUri), JSON.stringify(record), { EX: ttl });
  },
  async consume(requestUri) {
    // 取得と削除は atomic に行うこと。分けて実装すると同一 request_uri の
    // 並行使用（リプレイ）を許してしまいます。
    const raw = await redis.getDel(key(requestUri));
    return raw === null ? null : deserialize(raw);
  },
};
```

`requestUri` は認可エンドポイントのクエリ由来の外部入力です。キーとして使うときはクエリ文字列に埋め込まず、必ずパラメータ化してください。

## エラー処理

### PAR エンドポイント

Token Endpoint と同じ JSON エラー形式です。**リダイレクトは発生しません**。

| 条件 | HTTP | error |
|---|---|---|
| クライアント認証失敗 | 401 | `invalid_client`（`WWW-Authenticate: Basic` 付き） |
| ボディに `request_uri` | 400 | `invalid_request` |
| ボディに `request` | 400 | `invalid_request` |
| 認可リクエストとして不正（未登録 redirect_uri など） | 400 | `invalid_request` / `invalid_scope` / `unauthorized_client` / `unsupported_response_type` |
| POST 以外のメソッド | 405 | — |

未登録の `redirect_uri` などがここで失敗するのが PAR の利点です。**ユーザーが画面を見る前に失敗が確定します**。

### 認可エンドポイント

`request_uri` の解決に失敗した場合（不存在・使用済み・期限切れ・他クライアントの参照値）は、`invalid_request_uri` を返します。

- **リダイレクトしません。** 検証済みの `redirect_uri` が確立していないため、RFC 6749 §4.1.2.1 の「Redirection URI を検証できない場合は MUST NOT redirect」に従います
- 失敗の種別によらず、応答は同一です（コード・`error_description` とも）。応答差から「その `request_uri` が存在したか」を判別できないようにするためです
- 描画は既存の非リダイレクトエラー経路と同じです。`Accept: application/json` なら JSON 400、`authorizationErrorRedirectPath` 設定時は OP 内部パスへ 303、それ以外は HTML エラーページです

## セキュリティ上の注意

| 論点 | 実装 / 注意点 |
|---|---|
| 参照値の推測 | 256 ビットの暗号論的乱数（RFC 9126 §2.2 MUST） |
| リプレイ | `consume` による単回使用。RFC 上は SHOULD ですが本実装は必須運用です |
| 有効期限 | 既定 60 秒。設定は 5〜600 秒に制限され、範囲外は起動時に失敗します |
| クライアント紐付け | 認可エンドポイントのクエリ `client_id` と保存済み `client_id` の一致を検証（RFC 9126 §2.2 の MUST の実現） |
| SSRF | `request_uri` を**一切フェッチしません**（URN のみ）。OIDC Core §6.2 の URL 方式にある SSRF が構造的に存在しません |
| クライアント認証情報 | `client_secret` などはストアに保存されません。ログにも出力しないでください |
| PII | 保存されるパラメータには `login_hint` などが含まれ得ます。ログにパラメータ本体を出さず、永続ストアには TTL を設定してください |
| レート制限・サイズ上限 | RFC 9126 §2.3 の 413 / 429 は**実装していません**。デプロイ層（リバースプロキシ等）で設定してください |

PAR は state / nonce / PKCE を**置き換えません**。認可レスポンス側の攻撃（コード横取り等）への対策は引き続き PKCE が担います（RFC 9126 §7.5）。

## 既知の制約

- PAR と Request Object（JAR）の併用（RFC 9126 §3）は非対応です。PAR ボディに `request` を含めると `invalid_request` になります
- `require_pushed_authorization_requests` はグローバル設定のみです。クライアント単位の設定（RFC 9126 §6）は非対応です
- 単回使用が厳格なため、認可 URL をブラウザでリロードすると `invalid_request_uri` になります。RFC 9126 §4 が MAY で許す「ユーザーエージェントのリロード起因の重複許容」は採用していません
- レート制限・リクエストサイズ上限（413 / 429）は実装していません

## core 機能との違い

- **`request-object`（安定機能）との違い**: `request-object` は「パラメータを署名付き JWT にして by value で送る」方式です（完全性・否認防止）。PAR は「パラメータをバックチャネルで預ける」方式です（完全性・機密性・事前クライアント認証）。両者は直交します
- **core の `request_uri` 拒否との関係**: core の拒否ロジックは変更されていません。URN 形式でない `request_uri`（URL 形式など）は前段フックが素通しし、従来どおり core が `request_uri_not_supported` で拒否します

## トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `/par` が 404 | `--enable par` を付けずに生成しています。再生成してください |
| `Cannot find module '@maronn-openid-connect/experimental/par'` | `pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental` を実行してください |
| インストール時に `unmet peer @maronn-openid-connect/core` の警告 | この experimental が要求する core の下限を満たしていません。`@maronn-openid-connect/core` を更新してください（バージョン番号を experimental と揃える必要はありません） |
| PAR のエラーが期待どおりのレスポンスにならず 500 になる | core が二重にインストールされ、`instanceof` 判定が失敗している可能性があります。`pnpm why @maronn-openid-connect/core` で単一バージョンに解決されているか確認してください |
| 認可エンドポイントが `request_uri_not_supported` を返す | `request_uri` が URN 形式（`urn:ietf:params:oauth:request_uri:`）になっていません。PAR が返した値をそのまま渡してください |
| ブラウザバック / リロードで `invalid_request_uri` | 仕様どおりの挙動です（単回使用）。クライアント側で PAR からやり直してください |
| 60 秒以上経つと `invalid_request_uri` | 有効期限切れです。`parConfig.expiresInSeconds` を延ばすか、PAR 直後に認可エンドポイントへ遷移してください |
| 起動時に `expiresInSeconds must be an integer between 5 and 600` | `parConfig.expiresInSeconds` が RFC 9126 §2.2 の推奨レンジ外です |
| `invalid_request: client_id does not match the authenticated client` | ボディの `client_id` と認証したクライアントが違います |
| 複数プロセス構成でランダムに `invalid_request_uri` | in-memory ストアはプロセスをまたげません。永続ストアへ差し替えてください |

## 参考資料

- [RFC 9126: OAuth 2.0 Pushed Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9126)
- [RFC 6749: The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)（クライアント認証・エラー形式）
- [OpenID Connect Core 1.0 §3.1.2.6](https://openid.net/specs/openid-connect-core-1_0.html#AuthError)（`invalid_request_uri` の定義）
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-security-profile-2_0-final.html)（PAR を必須とする上位プロファイル）
