---
title: Device Authorization Grant (RFC 8628)
description: ブラウザを持たないデバイスを別デバイスのブラウザで認可する RFC 8628 の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

スマート TV・CLI ツール・IoT 機器のように、ブラウザを持たない、あるいは文字入力が困難なデバイスにログインさせるためのグラントです。

デバイスは短いコードを画面に出すだけで、実際の認証と承認は**ユーザーが手元のスマートフォンや PC のブラウザ**で行います。デバイスはその間トークンエンドポイントをポーリングし、承認された瞬間にトークンを受け取ります。

```text
[デバイス画面]                       [ユーザーのブラウザ]

  op.example.com/device
  コード: WDJB-MJHT      ─────────>  コードを入力 → ログイン → 承認

  (裏でポーリング中...)  <─────────  承認完了。デバイスに戻る
  ログインしました
```

このフローには `redirect_uri` が登場しません。そのためリダイレクト起点の攻撃（open redirect・認可コード横取り）が構造的に存在せず、既存の Authorization Code Flow と綺麗に直交します。

## 対応仕様

| 仕様 | 対応範囲 |
|---|---|
| RFC 8628 §3.1 / §3.2 | デバイス認可エンドポイント（クライアント認証・応答 6 フィールド） |
| RFC 8628 §3.3 / §3.3.1 | 検証 UI（コード入力・ログイン・承認 / 拒否）と `verification_uri_complete` |
| RFC 8628 §3.4 / §3.5 | トークンエンドポイントの grant 分岐と状態機械（4 エラーコード・`slow_down` の +5 秒） |
| RFC 8628 §4 | Provider Metadata（`device_authorization_endpoint` / `grant_types_supported`） |
| RFC 8628 §6.1 | base-20 文字種 `BCDFGHJKLMNPQRSTVWXZ` × 8 文字の `user_code` |
| RFC 8628 §3.1 の `scope` 省略 | **非対応**（本 OP は `scope` 必須かつ `openid` 必須。後述の「既知の制約」参照） |
| RFC 8628 §5.1 のレート制限 | **非実装**（デプロイ層の責務。後述の「セキュリティ上の注意」参照） |

## ユースケース

- `gh auth login` 型の CLI ログイン UX が自分の要件で成立するかを検証する
- スマート TV / セットトップボックス向けアプリの認可 UX を PoC する
- 入力デバイスを持たない IoT 機器のプロビジョニングフローを検証する

## 前提条件

- 生成 OP を `--enable device-authorization-grant` で作成していること
- クライアントの登録 `grantTypes` に `urn:ietf:params:oauth:grant-type:device_code` が含まれていること
- 実運用では、in-memory ストアを atomic な永続ストアへ差し替えること

public client でも利用できます。クライアント認証規則は Token Endpoint と同一なので、public client は `client_id` の提示のみです（RFC 8628 §3.1）。

## 有効化

```bash
maronn-oidc generate hono --enable device-authorization-grant
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`--enable device-authorization-grant` を付けなかった場合、この機能のコードは一切生成されず、インストール案内にも `@maronn-openid-connect/experimental` は現れません。`/device_authorization` は 404、`grant_type=urn:ietf:params:oauth:grant-type:device_code` は従来どおり `unsupported_grant_type` のままです。

`@maronn-openid-connect/core` は `@maronn-openid-connect/experimental` の peerDependency です。experimental は core のエラークラスを `instanceof` で判定するため、アプリ内の core インスタンスが 1 つでないと判定が静かに失敗します。experimental は core より速く更新されるので、**バージョン番号が揃っていない状態は正常です**。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/device-authorization.ts` | デバイス認可エンドポイント（`POST /device_authorization`）と設定値 `deviceAuthorizationConfig` |
| `routes/device.ts` | 検証 UI（`GET/POST /device`・`POST /device/login`・`POST /device/approve`） |
| `views.ts` | `deviceVerificationPage` / `deviceLoginPage` / `deviceApprovalPage` / `deviceCompletedPage` の追加 |
| `store.ts` | `InMemoryDeviceAuthorizationStore`・`deviceAuthorizationStore` シングルトン・バインディング Cookie ヘルパーの追加 |
| `routes/token.ts` | `device_code` grant の分岐と RFC 8628 §3.5 エラーの catch 分岐の追加 |
| `routes/discovery.ts` | `device_authorization_endpoint` と grant URN の広告 |
| `app.ts` / `apply.ts` | 4 エンドポイントのマウント・CORS・許可メソッドの追加 |
| `conformance.test.ts` | デバイスフローの契約テストの追加 |

## 設定

`routes/device-authorization.ts` の `deviceAuthorizationConfig` を編集します。検証 UI と discovery もここを参照します。

```typescript
export const deviceAuthorizationConfig = {
  // §3.2 expires_in（秒）。user_code が推測・フィッシングされ得る窓なので短く保つ。
  deviceCodeExpiresIn: 600,
  // §3.2 interval（秒）。slow_down のたびにレコード側の間隔が +5 される。
  pollInterval: 5,
  // レコード単位のログイン失敗上限。超過するとそのレコードは denied になる。
  maxLoginAttempts: 5,
};
```

`user_code` の文字種（base-20）と長さ（8 文字）は**設定値ではありません**。この 2 つがエントロピーの根拠なので、設定ミスで弱められないよう experimental 側の定数にしてあります。

## フロー

```text
Device                          OP                          User's Browser
  |                              |                                 |
  |-- POST /device_authorization>|  クライアント認証                 |
  |   client_id=..&scope=openid  |  grantTypes 検証・scope 検証      |
  |<- 200 {device_code,user_code,|  device_code / user_code 発行     |
  |   verification_uri, ...} ----|                                 |
  |                              |<-- GET /device?user_code=XXXX ---|
  |-- POST /token (polling) ---->|    コード入力フォーム（事前入力）   |
  |<- 400 authorization_pending -|<-- POST /device (user_code) -----|
  |                              |    照合成功 → バインディング Cookie 発行
  |                              |<-- POST /device/login -----------|
  |                              |    OPセッション確立 → 承認画面     |
  |                              |<-- POST /device/approve ---------|
  |-- POST /token (再ポーリング) ->|    レコードを approved に        |
  |<- 200 {access_token,id_token}|    device_code を consume        |
```

### リクエスト例（curl）

```bash
# 1. デバイス側: コードを取得する
curl -sS -X POST http://localhost:3000/device_authorization \
  -d client_id=tv-app -d client_secret=s3cret -d scope=openid
```

```json
{
  "device_code": "GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS",
  "user_code": "WDJB-MJHT",
  "verification_uri": "http://localhost:3000/device",
  "verification_uri_complete": "http://localhost:3000/device?user_code=WDJB-MJHT",
  "expires_in": 600,
  "interval": 5
}
```

```bash
# 2. ブラウザ側: 検証 UI の 3 ステップは cookie jar が必須（後述のバインディング参照）
curl -sS -c jar.txt -X POST http://localhost:3000/device \
  -d user_code=WDJB-MJHT
# ↑ 応答 HTML の csrf_token を控える

curl -sS -b jar.txt -c jar.txt -X POST http://localhost:3000/device/login \
  -d user_code=WDJB-MJHT -d csrf_token=<控えた値> \
  -d username=testuser -d password=password
# ↑ 応答 HTML の csrf_token を控える（承認画面のもの）

curl -sS -b jar.txt -X POST http://localhost:3000/device/approve \
  -d user_code=WDJB-MJHT -d csrf_token=<控えた値> -d decision=approve
```

```bash
# 3. デバイス側: ポーリングする
curl -sS -X POST http://localhost:3000/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code=GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS \
  -d client_id=tv-app -d client_secret=s3cret
```

`-c` / `-b`（cookie jar）を省くと `/device/login` と `/device/approve` は 403 になります。これは設定ミスではなく設計です（次節）。

## API 利用例

生成コードを使わず core / experimental を直接組み込む場合は、合成関数かステップ関数を呼び出します。

```typescript
import {
  processDeviceAuthorizationRequest,
  processDeviceCodeGrant,
  findPendingRecordByUserCode,
  issueVerificationBinding,
  validateVerificationBinding,
  approveDeviceAuthorization,
  type DeviceAuthorizationStore,
} from '@maronn-openid-connect/experimental/device-authorization-grant';

// デバイス認可エンドポイント（クライアント認証は呼び出し側で済ませて渡す）
const response = await processDeviceAuthorizationRequest({
  params,                        // フォームボディ（Record<string, string>）
  client,                        // { clientId, grantTypes }
  issuer: 'https://op.example',
  expiresIn: 600,
  interval: 5,
  refreshTokenFeatureEnabled: true,
  store,
});
// => { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }

// トークンエンドポイントの分岐（承認済みのときだけ返り、他状態は throw）
const grant = await processDeviceCodeGrant({ params, client, store });
// => { subject, clientId, scope, authTime, grantId }
```

ステップ関数（`validateDeviceGrantAllowed` / `validateDeviceAuthorizationScope` / `applyOfflineAccessPolicy` / `createDeviceAuthorizationRecord` / `buildDeviceAuthorizationResponse`、および `resolveDeviceCodeRecord` / `evaluateDeviceCodeState`）を個別に呼べば、検証の差し替えや削除ができます。

### ストアの差し替え

```typescript
import type { DeviceAuthorizationStore } from '@maronn-openid-connect/experimental/device-authorization-grant';

const redisDeviceStore: DeviceAuthorizationStore = {
  async save(record) { /* deviceCode と userCode の両方から引けるように保存する */ },
  async findByDeviceCode(deviceCode) { /* ... */ },
  async findByUserCode(userCode) { /* 正規化済みキー（'WDJBMJHT'）で引く */ },
  async update(record) { /* ... */ },
  async delete(deviceCode) { /* ... */ },
  async consume(deviceCode) {
    // 取得と削除は atomic に行うこと。分けて実装すると同一 device_code の
    // 並行リデンプションを許してしまいます。
    const raw = await redis.getDel(key(deviceCode));
    return raw === null ? null : deserialize(raw);
  },
};
```

- `deviceCode` / `userCode` はいずれも外部入力由来です。キーとして使うときはクエリ文字列に埋め込まず、必ずパラメータ化してください
- ポーリングを止めたデバイスのレコードは期限切れのまま残ります。`expiresAt` から TTL 程度の猶予を置いて自主的に破棄して構いません。破棄後のポーリングは `expired_token` ではなく `invalid_grant` になりますが、クライアントはどちらでもフローを終了するため相互運用上の問題はありません

## エラー処理

### デバイス認可エンドポイント

| 条件 | HTTP | error |
|---|---|---|
| クライアント認証失敗 | 401 | `invalid_client`（`WWW-Authenticate: Basic` 付き） |
| `grantTypes` に URN 未登録 | 400 | `unauthorized_client` |
| `scope` 欠落 | 400 | `invalid_request` |
| `openid` scope 欠落 | 400 | `invalid_scope` |
| form-urlencoded でない / パラメータ重複 | 400 | `invalid_request` |
| POST 以外のメソッド | 405 | — |

### トークンエンドポイント（RFC 8628 §3.5）

判定は上から順に評価され、最初に該当したものが返ります。すべて HTTP 400 です。

| 状態 | error | レコードの扱い |
|---|---|---|
| 期限切れ | `expired_token` | 削除 |
| `interval` 未満での再ポーリング | `slow_down` | `interval` を +5 して保存 |
| 未承認 | `authorization_pending` | 保持（`lastPolledAt` 更新） |
| 拒否済み | `access_denied` | 削除 |
| 承認済み | — （トークン発行） | `consume`（単回使用） |
| `device_code` 欠落 | `invalid_request` | — |
| 未知の `device_code` / 別クライアントの `device_code` | `invalid_grant` | — |

未知のコードと別クライアントのコードは**同一の `error_description`** を返します。応答差から他クライアントのコードの実在を判別できないようにするためです。

### 検証 UI

| 条件 | HTTP | 応答 |
|---|---|---|
| 未知・期限切れ・使用済みの `user_code` | 400 | 同一文言（`The code is invalid or has expired`）でフォーム再表示 |
| バインディング Cookie 不在・不一致 | 403 | エラーページ |
| `csrf_token` 不一致 | 403 | エラーページ |
| 資格情報が誤り | 200 | ログインフォーム再表示（残り試行回数付き） |
| ログイン失敗が上限超過 | 429 | エラーページ（レコードは `denied` へ遷移） |
| `/device/approve` に OP セッションなし | 401 | エラーページ |

## セキュリティ上の注意

### ブラウザバインディングが CSRF 防御の主役

**device フローでは、CSRF トークンだけでは防げません。**

`user_code` はフローを開始した主体（＝攻撃者になり得る主体）が設計上必ず知っている識別子です。したがってレコードに紐づけただけの CSRF トークンは、攻撃者自身が `POST /device` を叩けば取得できてしまいます。その結果、

- **承認強要**: 被害者のブラウザに `POST /device/approve` をフォージし、攻撃者のデバイスへトークンを流出させる
- **ログイン CSRF**: `POST /device/login` をフォージし、被害者のブラウザに攻撃者のセッションを確立する

のどちらも、トークンを秘匿しても止まりません。

そこで `POST /device` の照合成功時に bindingSecret を発行し、**生値はそのブラウザだけが持つ HttpOnly Cookie に、SHA-256 ハッシュのみをレコードに保存**します。`/device/login` と `/device/approve` は Cookie の生値がレコードのハッシュと一致しない限り実行されません。フォージされたクロスサイト POST は被害者ブラウザの Cookie を運べず（`SameSite=Lax`）、そもそも被害者ブラウザはそのレコードの Cookie を持っていないため、遮断されます。ストアが漏洩しても、保存されているのはハッシュだけなので Cookie は再構成できません。

optional 機能の `transaction-binding` が opt-in なのに対し、**このバインディングは常時有効**です。authorize フローの `transaction_id` は通常秘匿されるためバインディングは追加ハードニングで足りますが、device フローの `user_code` は開始者に既知であることが前提のため、これがベースライン要件になります。代償として、curl での手動フロー実行には cookie jar（`-c` / `-b`）が必要です。

hidden の `csrf_token` は多層防御として維持していますが、単独の防御としては扱っていません。

### そのほかの論点

| 論点 | 実装 / 注意点 |
|---|---|
| `user_code` 総当たり（§5.1） | エントロピーは 20^8 ≈ 2.6×10^10。TTL 600 秒・レコードの一方向遷移・成功/失敗を区別しない応答文言と組み合わせて非現実化しています |
| レート制限（§5.1） | **実装していません。** デプロイ基盤（リバースプロキシ / Cloudflare 等）の責務です。Cloudflare Workers のようにインスタンス間で共有メモリを持たない環境ではアプリ内カウンタが成立せず、置いても偽の安心になるためです |
| `device_code` の機密性（§5.2） | 256 ビットの暗号論的乱数。認可コードと同等の機密として扱い、ログに出力しないでください |
| リプレイ | `consume` による atomic な単回使用。2 回目の引き換えは `invalid_grant` |
| リモートフィッシング（§5.4） | 承認画面に `user_code` を再表示し、デバイス画面との突き合わせを促します。プロトコル上完全には防げないため、短い TTL が併用の緩和策です |
| セッション盗み見（§5.5） | `user_code` はワンタイム。承認 / 拒否は一方向遷移で、完了後は同じコードで再操作できません |
| public client（§5.6） | 認証しないクライアントの `client_id` は自己申告にすぎません。なりすましは検証 UI にクライアント名として現れるだけで、**トークンはユーザーの明示的な承認操作なしには出ません** |
| 資格情報の総当たり | レコード単位の `maxLoginAttempts` はありますが、device grant を許可されたクライアントを持つ攻撃者はレコードを無制限に発行できるため、集計上の試行回数は無制限です。これは既存の `/login` と同一の残存面です |
| ログ禁止情報 | `device_code` / `user_code`（有効期間中）/ CSRF トークン / bindingSecret / 資格情報。`error_description` にも含めないでください |
| `verification_uri_complete` の履歴残留 | `user_code` が URL クエリに載るため、ブラウザ履歴や中間プロキシのログに残り得ます。ワンタイムかつ短命で、承認操作をした本人以外には価値を持ちません |

## 既知の制約

- **`scope` が必須で、`openid` を含む必要があります。** RFC 8628 §3.1 では `scope` は OPTIONAL ですが、本 OP は認可エンドポイントと同じプロファイル制限をデバイス認可にも課しています。OAuth 単体（OIDC なし）のデバイス認可には対応していません
- **`nonce` / `prompt` / `max_age` / `login_hint` などの OIDC 認可リクエストパラメータは受け付けません。** RFC 8628 のデバイス認可リクエストは `client_id` / `scope` のみを定義しているためです。発行される ID Token に `nonce` は含まれません（`c_hash` も、認可コードが存在しないため含まれません）
- **`resource` / `audience`（RFC 8707）は受け付けません。** 指定されても未知パラメータとして無視されます
- **`user_code` の再発行・延長はできません。** 期限切れの場合はデバイスが最初からやり直します
- **同じ `user_code` を別ブラウザから `POST /device` すると、先のブラウザのバインディングが無効になります**（last-writer-wins）。`user_code` を知る者がレコードの承認 / 拒否を左右できるのは RFC 8628 のモデルどおりです
- **承認画面で scope の部分承認はできません。** 承認 / 拒否の二択です
- レート制限（§5.1）は実装していません

## core 機能との違い

- **Authorization Code Flow との違い**: デバイスフローには `redirect_uri` も認可コードも state もありません。認可の結果はデバイスのポーリングでのみ伝わります。したがって PKCE も使いません（横取りすべきコードがリダイレクトを流れないため）
- **CIBA との違い**: CIBA は認証デバイスへ**通知を送る**モデルです。デバイスフローは**ユーザーが自らコードを入力する**モデルで、通知チャネルを必要としません
- **同意の記録**: 承認時に既存の `consentStore` へ同意が記録されるため、以後の Authorization Code Flow で同意画面がスキップされる既存挙動がそのまま成立します
- **revocation**: 承認時に発行される `grantId` を access token / refresh token が引き継ぐため、grant 単位の失効が既存機構のまま効きます

## トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `/device_authorization` が 404 | `--enable device-authorization-grant` を付けずに生成しています。再生成してください |
| `Cannot find module '@maronn-openid-connect/experimental/device-authorization-grant'` | `pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental` を実行してください |
| `unauthorized_client` になる | クライアント登録の `grantTypes` に `urn:ietf:params:oauth:grant-type:device_code` を追加してください |
| `invalid_request: Missing required parameter: scope` | 本 OP は `scope` 必須です。`scope=openid` を付けてください |
| curl で `/device/login` が 403 | cookie jar を使っていません。`POST /device` を `-c jar.txt` で実行し、以降を `-b jar.txt` で送ってください |
| ブラウザで 403 になる | 別のタブ / ブラウザで同じ `user_code` を再投入し、バインディングが回転しています。`/device` からやり直してください |
| ポーリングがずっと `slow_down` | `interval` を守っていません。`slow_down` を受けたら 5 秒足してから次を送ってください（RFC 8628 §3.5） |
| 10 分経つと `expired_token` | 有効期限切れです。`deviceAuthorizationConfig.deviceCodeExpiresIn` を延ばすか、フローをやり直してください |
| トークン取得後の再ポーリングが `invalid_grant` | 仕様どおりの挙動です（単回使用） |
| refresh token が発行されない | `refresh-token` feature が有効で、クライアントが `refresh_token` grant を登録し、`scope` に `offline_access` を含めている必要があります |
| 複数プロセス構成でランダムに `invalid_grant` | in-memory ストアはプロセスをまたげません。永続ストアへ差し替えてください |

## 参考資料

- [RFC 8628: OAuth 2.0 Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
- [RFC 6749: The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)（クライアント認証・エラー形式・トークン応答）
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)（ID Token のクレーム規則・§11 offline_access）
- [RFC 8414: OAuth 2.0 Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)（`device_authorization_endpoint` の登録先）
