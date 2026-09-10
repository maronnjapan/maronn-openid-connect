---
title: CIBA (Client-Initiated Backchannel Authentication)
description: クライアント起点のバックチャネル認証を Poll モードで検証できる CIBA Core 1.0 の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

コールセンターのオペレーター画面・店頭端末・スマートスピーカーのように、ユーザー本人が操作していないデバイスからログインを始めるためのフローです。

デバイス（consumption device）はユーザーの識別子（`login_hint`）だけを添えて OP にバックチャネルで認証を依頼し、実際の認証と承認は**ユーザーが自分の手元のブラウザ**で行います。デバイスはその間トークンエンドポイントをポーリングし、承認された瞬間にトークンを受け取ります。

```text
[オペレーター画面]                      [ユーザーのブラウザ]

  電話番号を入力して「認証を依頼」
  依頼を送信しました        ─────────>  op.example.com/ciba にアクセス
                                       ログイン → 自分宛の依頼を確認 → 承認
  (裏でポーリング中...)     <─────────  承認完了。
  認証されました
```

Device Authorization Grant と部品はよく似ていますが、起点が逆です。Device Flow は「ユーザーが `user_code` を書き写して自ら OP に来る」のに対し、CIBA は「クライアントがユーザーを名指しし、OP がユーザー側の承認を待つ」フローです。このフローにも `redirect_uri` は登場しないため、リダイレクト起点の攻撃面は増えません。

本実装は CIBA Core 1.0 の 3 つの token delivery モードのうち **Poll モードのみ**を提供します。Ping / Push モード（OP からクライアントへの通知）は対象外です。

## 対応仕様

| 仕様 | 対応範囲 |
|---|---|
| CIBA Core 1.0 §7.1 / §7.2 / §7.3 | バックチャネル認証エンドポイント（クライアント認証・ヒント規則・`binding_message`・`requested_expiry`・応答 3 フィールド） |
| CIBA Core 1.0 §10.1 / §11 | トークンエンドポイントの grant 分岐と状態機械（`authorization_pending` / `slow_down` の +5 秒 / `expired_token` / `access_denied`） |
| CIBA Core 1.0 §13 | エラー語彙（`unknown_user_id` / `invalid_binding_message` を含む） |
| CIBA Core 1.0 §4 | Provider Metadata（`backchannel_token_delivery_modes_supported: ["poll"]` / `backchannel_authentication_endpoint`） |
| Ping / Push モード（§10.2 / §10.3） | **非対応**（Poll のみ。`poll` 以外を登録したクライアントは `unauthorized_client`） |
| `id_token_hint` / `login_hint_token`（§7.1） | **非対応**（ヒントは `login_hint` のみ。単独提示は `invalid_request`） |
| 署名付き認証リクエスト（§7.1.1） | **非対応**（`request` パラメータは `invalid_request`） |
| `user_code` パラメータ（§7.1.2） | **非対応**（送られてきても無視。後述の「セキュリティ上の注意」参照） |
| 認証デバイスへの到達手段（§7.1 で仕様の対象外） | OP がホストするブラウザ UI（`/ciba`）として実装 |

## ユースケース

- コールセンターで「オペレーターがユーザーの識別子を入力し、ユーザーのスマホで承認」という UX が自分の要件で成立するかを検証する
- 店頭端末や音声デバイスなど、ユーザー入力が制約されるデバイスからの認可を PoC する
- FAPI-CIBA の導入を見据えて、まず素の CIBA Core のフローを手元で理解する

## 前提条件

- 生成 OP を `--enable ciba` で作成していること
- クライアントの登録 `grantTypes` に `urn:openid:params:grant-type:ciba` が含まれていること
- クライアントが confidential client であること（public client は `unauthorized_client`。CIBA §7.1 がクライアント認証を必須とするため）
- 実運用では、in-memory ストアを atomic な永続ストアへ差し替えること

## 有効化

```bash
maronn-oidc generate hono --enable ciba
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`--enable ciba` を付けなかった場合、この機能のコードは一切生成されず、インストール案内にも `@maronn-openid-connect/experimental` は現れません。`/backchannel_authentication` と `/ciba` は 404、`grant_type=urn:openid:params:grant-type:ciba` は従来どおり `unsupported_grant_type` のままです。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/backchannel-authentication.ts` | バックチャネル認証エンドポイント（`POST /backchannel_authentication`）と設定値 `cibaConfig` |
| `routes/ciba-verification.ts` | 認証デバイス UI（`GET /ciba`・`POST /ciba/login`・`POST /ciba/approve`） |
| `views.ts` | `cibaLoginPage` / `cibaPendingRequestsPage` / `cibaCompletedPage` の追加 |
| `store.ts` | CIBA ストアのシングルトン（実体は experimental の in-memory 実装）とログイン用バインディング Cookie ヘルパーの追加 |
| `config.ts` | `RegisteredClient` への `backchannelTokenDeliveryMode` の追加とサンプルクライアントへの grant URN 登録 |
| `routes/token.ts` | CIBA grant の分岐と CIBA §11 エラーの catch 分岐の追加 |
| `routes/discovery.ts` | `backchannel_authentication_endpoint` / `backchannel_token_delivery_modes_supported` / grant URN の広告 |
| `app.ts` / `apply.ts` | 4 エンドポイントのマウント・CORS・許可メソッド・`login_hint` リゾルバの配線 |
| `conformance.test.ts` | CIBA フローの契約テストの追加 |

## 設定

`routes/backchannel-authentication.ts` の `cibaConfig` を編集します。認証デバイス UI とトークンルートもここを参照します。範囲外の値はモジュール読み込み時にエラーになります。

```typescript
export const cibaConfig = {
  // §7.3 expires_in（秒、30–600）。ユーザーが承認するまでの待ち時間の上限。
  authReqIdExpiresIn: 120,
  // §7.3 interval（秒、1–60）。slow_down のたびにレコード側の間隔が +5 される。
  pollingInterval: 5,
  // 1 ユーザーあたりの保留中リクエスト数の上限（1–100）。承認画面の flood 対策。
  maxPendingPerSubject: 10,
  // ログイントランザクション単位のログイン失敗上限。超過するとそのフォームは使えなくなる。
  maxLoginAttempts: 5,
};
```

`login_hint` からユーザーを解決する方法は差し替えられます。既定はヒントをユーザーストアのユーザー名として引く実装で、`createApp` の `cibaUserResolver` オプションでメールアドレスや電話番号による解決に置き換えられます。

```typescript
createApp({
  signingKeyProvider,
  // login_hint を自分のユーザーストアの検索キーとして解決する
  cibaUserResolver: async (loginHint) => {
    const user = await findUserByPhoneNumber(loginHint);
    return user ? { subject: user.id } : null;
  },
});
```

## フロー

```text
Client (consumption device)     OP                            User's Browser
  |                              |                                 |
  |-- POST /backchannel_authentication                             |
  |   client_id=..&scope=openid  |  クライアント認証・grant 登録検証  |
  |   &login_hint=user1 -------->|  ヒント検証・login_hint 解決      |
  |<- 200 {auth_req_id,          |  auth_req_id 発行（pending）     |
  |   expires_in, interval} -----|                                 |
  |                              |<-- GET /ciba --------------------|
  |-- POST /token (polling) ---->|    ログインフォーム               |
  |<- 400 authorization_pending -|<-- POST /ciba/login -------------|
  |                              |    OPセッション確立 → 保留一覧     |
  |                              |<-- POST /ciba/approve -----------|
  |-- POST /token (再ポーリング) ->|    レコードを approved に        |
  |<- 200 {access_token,id_token}|    auth_req_id を consume        |
```

### リクエスト例（curl）

```bash
# 1. クライアント側: 認証を依頼する
curl -sS -X POST http://localhost:3000/backchannel_authentication \
  -d client_id=cc-console -d client_secret=s3cret \
  -d scope=openid -d login_hint=testuser -d binding_message=AB-123
```

```json
{
  "auth_req_id": "GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eSuw",
  "expires_in": 120,
  "interval": 5
}
```

```bash
# 2. ブラウザ側: ログインは cookie jar が必須（後述のバインディング参照）
curl -sS -c jar.txt http://localhost:3000/ciba
# ↑ 応答 HTML の login_transaction_id と csrf_token を控える

curl -sS -b jar.txt -c jar.txt -X POST http://localhost:3000/ciba/login \
  -d login_transaction_id=<控えた値> -d csrf_token=<控えた値> \
  -d username=testuser -d password=password
# ↑ 応答 HTML（保留中リクエスト一覧）の auth_req_id と csrf_token を控える

curl -sS -b jar.txt -X POST http://localhost:3000/ciba/approve \
  -d auth_req_id=<控えた値> -d csrf_token=<控えた値> -d decision=approve
```

```bash
# 3. クライアント側: ポーリングする
curl -sS -X POST http://localhost:3000/token \
  -d grant_type=urn:openid:params:grant-type:ciba \
  -d auth_req_id=GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eSuw \
  -d client_id=cc-console -d client_secret=s3cret
```

`interval` より速くポーリングすると `slow_down` が返り、以後の要求間隔が 5 秒ずつ長くなります（CIBA §11。サーバー側も新しい間隔を強制します）。

## API 利用例

生成コードは `@maronn-openid-connect/experimental/ciba` の関数を呼び出して組み立てられています。生成コードを書き換えるときは、次の公開 API を直接使えます。

```typescript
import {
  CIBA_GRANT_TYPE,
  processBackchannelAuthenticationRequest,
  processCibaGrant,
  approveCibaRequest,
  denyCibaRequest,
  listPendingCibaRequests,
  createInMemoryCibaAuthenticationRequestStore,
} from '@maronn-openid-connect/experimental/ciba';

// バックチャネル認証エンドポイントの処理（クライアント認証済みが前提）
const response = await processBackchannelAuthenticationRequest({
  params,               // フォームボディ
  client,               // 認証済みクライアント
  store,                // CibaAuthenticationRequestStore
  config: cibaConfig,
  refreshTokenFeatureEnabled: true,
  resolveUser: async (loginHint) => ({ subject: loginHint }),
});

// トークンエンドポイントの CIBA 分岐（approved のときだけ発行データが返る）
const grant = await processCibaGrant({ params, client, store });
```

承認 UI を独自の画面（スマホアプリへのプッシュ通知など）に載せ替える場合は、`listPendingCibaRequests` / `approveCibaRequest` / `denyCibaRequest` を自分のエンドポイントから呼び出します。承認の束縛は「レコードの subject と承認操作者の subject の一致」と「一覧表示時に発行されるレコード単位の CSRF トークン」なので、独自 UI でも同じ 2 点を渡す構造を保ってください。

ストアは `CibaAuthenticationRequestStore` と `CibaLoginTransactionStore` の 2 契約です。`consume(authReqId)` は取得と削除を atomic に行う必要があります（単回使用の強制）。

## エラー処理

バックチャネル認証エンドポイント（CIBA §13）:

| error | 発生条件 |
|---|---|
| `invalid_request` | ヒントが 0 個または 2 個以上 / 非対応ヒント種別 / `request` 提示 / `scope` 欠落 / `requested_expiry` 不正 / 保留数超過 |
| `invalid_scope` | `openid` を含まない scope |
| `unknown_user_id` | `login_hint` からユーザーを特定できない（不存在と解決失敗は同じ文言） |
| `unauthorized_client` | CIBA grant 未登録 / public client / `poll` 以外の delivery mode 登録 |
| `invalid_binding_message` | `binding_message` の長さ（1〜100 文字）・制御文字違反 |
| `invalid_client`（401） | クライアント認証失敗 |

トークンエンドポイント（CIBA §11、すべて 400）:

| error | 発生条件 |
|---|---|
| `authorization_pending` | ユーザーがまだ決定していない |
| `slow_down` | `interval` より速いポーリング（以後の間隔が +5 秒される） |
| `expired_token` | `auth_req_id` の期限切れ（レコードは削除される） |
| `access_denied` | ユーザーが拒否した（レコードは削除され、再ポーリングは `invalid_grant`） |
| `invalid_grant` | `auth_req_id` が不明・使用済み・別クライアント宛て（すべて同じ文言） |

## セキュリティ上の注意

**`auth_req_id` 単独では何もできません。** トークン取得にはクライアント認証と発行先クライアントの一致が必要で、承認操作には認証済み OP セッションの subject 一致が必要です。値が漏れても、それだけでフローを進められる相手はいません。

**ログインフォームはバインディング Cookie で守られています。** `/ciba` のログイン成功は OP セッションという CIBA 外にも及ぶ状態（SSO・`prompt=none`）を作ります。攻撃者は自分で `/ciba` を開けば有効なフォーム値一式を入手できるため、hidden フィールドの CSRF トークンだけでは偽造 POST を止められません。フォーム表示時に発行されるバインディング Cookie（生値はブラウザのみ、レコードには SHA-256 ハッシュ）が、被害者ブラウザへ攻撃者のセッションを植え付けるログイン CSRF を遮断します。curl で UI を叩くときに cookie jar が要るのはこのためです。

**未承諾リクエストはユーザーの明示的な拒否に依存します。** CIBA §7.1.2 の `user_code`（ユーザーごとの秘密で未承諾依頼を抑止する仕組み）は実装していません。代わりに (1) クライアント認証必須（匿名からは依頼できない）、(2) `maxPendingPerSubject` による保留数の上限、(3) プッシュ通知のない pull 型 UI（割り込みが発生しない）、(4) 承認画面でのクライアント名・scope・`binding_message` の表示と同等の視認性の拒否ボタン、で構成しています。正規登録クライアントが侵害された場合の最後の防衛線はユーザーの拒否操作です。

**`binding_message` は取引の照合手段です。** 承認画面に表示されるので、クライアント側は「いま目の前のデバイスに出ている値」をそのまま送ってください。ユーザーが画面間で見比べることが、別トランザクションの承認（取り違え）への対策になります（表示時は HTML エスケープされます）。

**`login_hint` は PII です。** メールアドレスや電話番号そのものなので、ログへ出さないでください（生成コードは出しません）。また `unknown_user_id` は登録クライアントに対してユーザーの存在確認を許します（仕様上の語彙です）。PoC を超えて運用する場合は、リゾルバ側でのレート制限を検討してください。

**エンドポイント全体のレート制限はデプロイ層の責務です。** 共有メモリのないランタイム（Cloudflare Workers など）ではプロセス内カウンタが機能しないため、リバースプロキシやプラットフォーム側で設定してください。

## 既知の制約

- Poll モードのみです。Ping / Push（クライアント通知エンドポイントへの callback）は生成されません
- ヒントは `login_hint` のみです。`id_token_hint`（期限切れ ID トークンによる再認証ヒント）は将来拡張として記録されています
- `scope` は必須で、`openid` を含む必要があります（本 OP 全体のプロファイル制限）
- 認証デバイス UI は pull 型です。実運用の CIBA で典型的なスマホへのプッシュ通知は、通知基盤ごと UI を差し替えて実現してください（前節の API 利用例参照）
- ログイン失敗の計数はログイントランザクション単位です。ユーザー（subject）単位のスロットリングは別途デプロイ層で行ってください

## core 機能との違い

| | Authorization Code Flow（core） | Device Flow（experimental） | CIBA（この機能） |
|---|---|---|---|
| 起点 | ユーザーのブラウザ | デバイス（ユーザー操作あり） | クライアント（ユーザー操作なし） |
| ユーザーの識別 | ブラウザでのログイン | `user_code` の書き写し | `login_hint` による名指し |
| トークンの受け取り | リダイレクト + code 交換 | ポーリング | ポーリング |
| `redirect_uri` | あり | なし | なし |

## トラブルシューティング

**`/ciba/login` が必ず 403 になる**：バインディング Cookie を送っていません。ブラウザならそのまま動きます。curl なら `-c` / `-b` で cookie jar を使い、`GET /ciba` から同じ jar でやり直してください。

**`unauthorized_client` が返る**：クライアントの `grantTypes` に `urn:openid:params:grant-type:ciba` を登録したか、`backchannelTokenDeliveryMode` に `poll` 以外を設定していないか、public client（`tokenEndpointAuthMethod: 'none'`）になっていないかを確認してください。

**承認したのにトークンが出ない**：ポーリングのクライアントが依頼時と同じ `client_id` か、`interval` を守っているか（`slow_down` 後は +5 秒）を確認してください。`expires_in`（既定 120 秒）を過ぎたレコードは `expired_token` になります。

**一覧に依頼が出ない**：ログインしたユーザーが `login_hint` の解決先と同じ subject かを確認してください。一覧に出るのは自分宛ての保留中リクエストだけです。

## 参考資料

- [OpenID Connect Client-Initiated Backchannel Authentication Flow - Core 1.0](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html)
- [RFC 6749 - The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749)
- [RFC 8628 - OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)（ポーリング状態機械の先例）
