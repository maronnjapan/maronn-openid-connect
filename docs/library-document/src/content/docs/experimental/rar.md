---
title: Rich Authorization Requests (RAR)
description: scope では表現しきれない認可要求を authorization_details の JSON 配列で受け取る OAuth 2.0 Rich Authorization Requests（RFC 9396）の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

`scope` は空白区切りの文字列の集合で、認可の粒度が「API 全体」や「操作の種類」で止まります。
「口座 X から 123.50 ユーロを 1 回だけ送金する」のような要求を表すには、値の中に構造を埋め込む独自規約を発明するしかなく、相互運用できません。

**Rich Authorization Requests（RAR）** は、この構造を `authorization_details` という JSON 配列パラメータとして標準化した仕様です。
各要素は `type` フィールドで意味を宣言するオブジェクトで、金額、口座、操作のような型固有フィールドを持てます。

`--enable rar` で生成した OP は、認可コードフローで次を行います。

1. 認可リクエストの `authorization_details` を検証する（構造と、設定に登録した**型定義**による型固有の検証）
2. 同意画面に、要求された details の表示行を scope と併記する
3. 承認された details をグラントに紐付ける
4. トークンレスポンス（refresh を含む）と introspection の応答に `authorization_details` を含める

```text
GET /authorize?response_type=code&client_id=...&scope=openid
  &authorization_details=%5B%7B%22type%22%3A%22payment_initiation%22%2C...%7D%5D

（ログインと同意のあと）

POST /token
HTTP/1.1 200 OK
{
  "access_token": "...",
  "token_type": "Bearer",
  "authorization_details": [
    {
      "type": "payment_initiation",
      "actions": ["initiate"],
      "instructedAmount": { "currency": "EUR", "amount": "123.50" }
    }
  ]
}
```

`authorization_details` の無いリクエストは、この機能の有効・無効にかかわらず従来とまったく同じに処理されます。

## 対応仕様

- [RFC 9396: OAuth 2.0 Rich Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9396)（§2 の構造、§3 / §3.1 の認可リクエストと同意表示、§5 の未知 type の拒否、§7 のトークンレスポンス、§9.2 の introspection、§10 のメタデータ）

次はスコープ外です。

- トークンリクエストでの `authorization_details` の再指定（§6 の narrowing）。パラメータが来たら `invalid_authorization_details` で明示拒否します
- AS 側での details の拡充（§7.1 の enriched authorization details）
- JWT アクセストークンへの `authorization_details` claim（§9.1、RECOMMENDED）。資源サーバーへの伝達は introspection だけです
- 認可コードフロー以外への適用。device authorization grant と CIBA のエンドポイントは、従来どおりパラメータを無視します
- 部分同意（§3 の Note のサブセット承認）。同意は要求された details 全体への承認か拒否かの二択です
- クライアントメタデータ `authorization_details_types`（§10）によるクライアント単位の型制限

## ユースケース

- 送金額や口座を特定した認可（`payment_initiation` 型など）を試す金融系 PoC
- `scope` の荒い粒度を細分化したい API 提供者が、型定義の設計（必須フィールド、同意文言）を検証する用途
- FAPI 2.0 の推奨構成（PAR + RAR）の組み合わせ検証。PAR 経由で送った `authorization_details` もそのまま受理されます

## 前提条件

- 認可コードフローが動く生成済みの OP（Basic OP の必須機能はどの生成物にもあります）
- introspection への反映を試す場合は、`introspection` 機能が有効であること（既定で有効です）

## 有効化

```bash
maronn-oidc generate hono --enable rar

# 生成コードが必要とする package を追加する
pnpm add @maronn-openid-connect/experimental
```

生成直後の OP は型定義が空なので、`authorization_details` 付きのリクエストをすべて `invalid_authorization_details` で拒否します（fail-closed）。
次の節の型定義を登録してはじめて、その `type` のリクエストが通ります。

## 型定義の書き方

受理する `type` は、**型定義**（`AuthorizationDetailTypeDefinition`）として OP の設定に登録します。
RFC 9396 は type の意味論を API ごとのプロファイルに委ねているため、この OP は構造検証と配管だけを持ち、型固有の検証と同意文言は型定義が決めます。

```typescript
import {
  RarError,
  type AuthorizationDetail,
  type AuthorizationDetailTypeDefinition,
} from '@maronn-openid-connect/experimental/rar';

const paymentInitiation: AuthorizationDetailTypeDefinition = {
  type: 'payment_initiation',
  // 型固有の検証。違反は RarError で投げる（メッセージは固定文言にして、
  // 入力値を含めない）。
  validate(detail: AuthorizationDetail): void {
    const amount = detail['instructedAmount'] as { currency?: unknown; amount?: unknown } | undefined;
    if (typeof amount?.currency !== 'string' || typeof amount?.amount !== 'string') {
      throw new RarError('payment_initiation requires an instructedAmount object');
    }
  },
  // 同意画面の表示行。プレーン文字列だけを返す（エスケープは画面側が行う）。
  // 金額や宛先など、安全上重要なフィールドはすべて文言に含める。
  describe(detail: AuthorizationDetail): readonly string[] {
    const amount = detail['instructedAmount'] as { currency: string; amount: string };
    return [`Initiate a payment of ${amount.currency} ${amount.amount}`];
  },
};
```

登録場所はフレームワークで異なります。

- **Hono / Express / Fastify**: `applyOidc()` に渡す設定（または `config.ts` の既定値）へ `rarTypes: [paymentInitiation]` を加えます
- **Next.js**: `_oidc-provider/provider.ts` の `createProviderConfig({ ... })` へ `rarTypes` を加えます。起動フック（`instrumentation.ts`）から注入したい場合は、`_oidc-provider/features/rar/config.ts` の `rarConfig.types` へ代入します（`config.rarTypes` が設定されていればそちらが優先されます）

型定義を登録すると、discovery が `authorization_details_types_supported` にその `type` 値を公表します。
クライアントは、この member の無い OP へ `authorization_details` を送るべきではありません（RFC 9396 §10）。

## 設定

生成コードの feature ディレクトリの `config.ts` に上限値があります。

| 設定 | 既定値 | 意味 |
|---|---|---|
| `maxAuthorizationDetailsBytes` | 16384 | パラメータ全体の UTF-8 バイト長の上限。長大な要求には PAR の利用を検討してください（RFC 9396 §11.4） |
| `maxAuthorizationDetailsEntries` | 16 | 配列の要素数の上限 |

## フロー

```text
Client                                   OP                                    User
  │ GET /authorize?...&authorization_details=[...]                              │
  │────────────────────────────────────▶│ 検証（構造 + 型定義）                 │
  │                                     │ ログイン                              │
  │                                     │ 同意画面に scope と details を併記    │
  │                                     │◀──────────────承認────────────────────│
  │◀─────────── code ──────────────────│ details をグラントへ紐付け             │
  │ POST /token (authorization_code)    │                                        │
  │◀── 200 {..., authorization_details} │                                        │
  │ POST /token (refresh_token)         │                                        │
  │◀── 200 {..., authorization_details} │ 同じグラントの details を引き継ぐ      │
  │ POST /introspect（資源サーバーから） │ active:true に details を含める        │
```

details を伴うリクエストは、常に同意画面を経由します。
過去の同意の記録は scope 単位で、details の中身を知らないためです。
`prompt=none` 単独のリクエストは `consent_required` になり、それ以外のリクエストには OP が内部的に `prompt=consent` を補って、SSO の同意スキップを塞ぎます。

## エラー処理

| 状況 | 応答 |
|---|---|
| 構造違反、上限超過、未知の `type`、型定義の検証違反（認可リクエスト） | `error=invalid_authorization_details` のエラーリダイレクト |
| details 付きで `prompt=none` 単独 | `error=consent_required` のエラーリダイレクト |
| トークンリクエストに `authorization_details` がある | 400 の `invalid_authorization_details`（JSON） |

`error_description` は固定の文言で、details の内容（金額や `type` 名）を反映しません。
どの要素が拒否されたかは、クライアント側で送った値から再現できます。

## セキュリティ上の注意

- **ログへ出さない**: details は金額、口座、識別子のような機微情報を運びます。アプリケーションのログやエラー通知に `authorization_details` の値を出さないでください（RFC 9396 §13）
- **完全性保護は併用で**: クエリパラメータは利用者が改変できます。パラメータの改ざん対策が要る場合は、署名付き request object か PAR と併用してください（§12）。request object 内の `authorization_details` はクエリ値より優先されます
- **型定義の責任範囲**: `describe` が返す行に、承認の判断に要るフィールドをすべて含めてください。文言に出ないフィールドは、エンドユーザーが見ないまま承認されます
- **保存は in-memory**: 生成されるストアはプロセスのメモリに details を置きます。本番では永続ストアへ差し替え、保存期間を必要な範囲に限定してください

## 既知の制約

- 承認済み details の保持は in-memory で、OP のプロセスを再起動すると消えます（トークンレスポンスと introspection から member が消えるだけで、トークン自体は有効なままです）
- グラントへ紐付けた details は、リフレッシュトークンの絶対寿命（`refreshTokenAbsoluteLifetime`）まで保持します。リフレッシュトークンを発行しないグラントでは、その分の過剰保持になります
- introspection は、グラントに紐づく details を資源サーバーによらずそのまま返します（§9.2 の資源サーバー別フィルタリングは行いません）
- device authorization grant と CIBA では使えません。これらのエンドポイントはパラメータを従来どおり無視します

## core 機能との違い

- **scope**: 粒度の荒い文字列集合で、RAR は構造化オブジェクトです。両者は併存でき、`openid` scope は従来どおり必須です
- **claims パラメータ**（OIDC Core §5.5）: ID Token / UserInfo に載せる「属性」の要求であり、API への「権限」の要求ではありません
- **PAR**: リクエストの渡し方の拡張で、RAR は中身の拡張です。併用できます

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| すべてのリクエストが `invalid_authorization_details` になる | 型定義が未登録です。`rarTypes` に `type` の一致する定義を登録してください |
| discovery に `authorization_details_types_supported` が出ない | 型定義が空です。登録すると公表されます |
| 同意画面に details の行が出ない | 認可リクエストに `authorization_details` が無いか、検証で拒否されています。エラーリダイレクトの `error` を確認してください |
| refresh の応答に details が無い | OP を再起動すると in-memory の保持が消えます。再度認可からやり直してください |
| トークンリクエストが 400 になる | トークンリクエストに `authorization_details` を載せています。この OP は §6 の narrowing に対応しません |

## 参考資料

- [RFC 9396: OAuth 2.0 Rich Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9396)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-security-profile-2_0-final.html)（`scope` で表現しきれない認可に RAR の使用を推奨する非規範ノート）
- [IANA OAuth Authorization Details Types レジストリ](https://www.iana.org/assignments/oauth-parameters/oauth-parameters.xhtml)
