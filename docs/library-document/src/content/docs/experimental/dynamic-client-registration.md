---
title: Dynamic Client Registration
description: クライアントが実行時に自分を登録して client_id の払い出しを受ける OAuth 2.0 Dynamic Client Registration（RFC 7591）の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

この OP でクライアントを増やす方法は、既定の生成物では静的な登録簿の編集しかありません。
`config.ts` の Map か、`--db` で生成した場合はクライアント表へエントリを足し、ビルドと再起動を経てはじめて新しいクライアントが使えます。

Dynamic Client Registration は、クライアントが実行時に自分のメタデータを送って登録を受ける**クライアント登録エンドポイント**を定義します。
`--enable dynamic-client-registration` で生成した OP は `POST /register` を提供し、discovery に `registration_endpoint` を公表します。

```text
POST /register HTTP/1.1
Content-Type: application/json

{"redirect_uris": ["https://app.example.com/cb"], "client_name": "My Test App"}

HTTP/1.1 201 Created
Content-Type: application/json
Cache-Control: no-store

{
  "client_id": "dcr-Zx8kFh3mQW9pTnB2VcGy0A",
  "client_secret": "（43 文字の乱数）",
  "client_id_issued_at": 1790812800,
  "client_secret_expires_at": 0,
  "redirect_uris": ["https://app.example.com/cb"],
  "token_endpoint_auth_method": "client_secret_basic",
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "client_name": "My Test App"
}
```

発行された `client_id` と `client_secret` は、そのまま `/authorize` と `/token` で使えます。
登録されたクライアントへの検証（PKCE、`redirect_uri` の完全一致、クライアント認証）は静的登録のクライアントと同一です。
`client_secret_expires_at: 0` は「無期限」を意味する仕様上の値で、即時失効ではありません。

## 対応仕様

- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591)
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)（`redirect_uris` を必須にする制約を採用）

次はスコープ外です。

- RFC 7592（登録後の参照・更新・削除）。`registration_access_token` と `registration_client_uri` は、両方返すか両方返さないかの MUST に従い、どちらも返しません
- `software_statement`（未知フィールドとして無視します）
- initial access token の発行・管理（照合のみ提供します）
- OIDC 固有メタデータの解釈（`jwks_uri` や `logo_uri` など。未知フィールドとして無視します）

## ユースケース

- OIDF Conformance Suite の動的登録前提のテストプランを、この OP に向けて実行する
- MCP（Model Context Protocol）クライアントのように、接続時に DCR で自分を登録するエコシステムのクライアント実装を手元の OP で受け止める
- 複数のテストアプリを静的設定の編集なしに素早く繋ぐ
- `token_endpoint_auth_method` や `grant_types` の既定値がどう適用されるかなど、RFC 7591 の素の挙動を確認する

## 前提条件

追加の前提はありません。
登録されたクライアントの解決は、どのビルドでも常に生成されるクライアント解決の経路に載ります。

## 有効化

```bash
maronn-oidc generate hono --enable dynamic-client-registration
pnpm add hono @maronn-openid-connect/core @maronn-openid-connect/experimental
```

有効にすると `POST /register` が生成され、discovery に `registration_endpoint` が公表されます。
有効にしない場合、生成コードは従来と変わらず、`/register` は存在しません（404）。

## 設定

設定は生成された `routes/register.ts` の `dynamicClientRegistrationConfig` にあります。

| 設定 | 既定値 | 意味 |
|---|---|---|
| `initialAccessToken` | `undefined` | 設定すると `POST /register` に `Authorization: Bearer <値>` の提示を要求します。未設定ならオープン登録（RFC 7591 §3.1 の SHOULD） |
| `maxRegisteredClients` | `100` | 動的登録クライアントの総数上限。超過時は `429` |
| `maxRegistrationBodyBytes` | `16384` | リクエストボディの上限（UTF-8 バイト長） |

Hono / Express / Fastify では、生成ファイルを編集せずに `applyOidc` のオプションからも上書きできます。

```typescript
applyOidc(app, {
  // ...
  dynamicClientRegistration: {
    initialAccessToken: process.env.OIDC_DCR_INITIAL_ACCESS_TOKEN,
    maxRegisteredClients: 10,
  },
});
```

initial access token は生成コードの設定に置く固定文字列 1 つで、発行 API やローテーションはありません。
PoC の検証用と割り切り、本番の審査付き登録には使わないでください。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/register.ts`（Next.js は `register/route.ts` と `register/config.ts`） | 登録エンドポイントと設定オブジェクト `dynamicClientRegistrationConfig` |
| `store.ts`（追記） | 動的登録クライアントの in-memory ストアと、設定済みのクライアント解決へ合成する `withDynamicallyRegisteredClients()` |
| `apply.ts` / `app.ts`（追記） | `/register` のマウントと、クライアント解決への合成 |
| `routes/discovery.ts`（追記） | `registration_endpoint` メタデータ |

## 受理するメタデータ

理解するフィールドは次の 6 つで、それ以外は RFC 7591 §2 のとおり黙って無視します（登録はエラーになりません）。

| フィールド | 扱い |
|---|---|
| `redirect_uris` | 必須（OIDC Dynamic Client Registration 1.0 §2）。静的クライアントと同一の規則で検査します（フラグメント禁止、`javascript:` などの危険スキーム拒否、非ループバックの平文 `http://` 拒否） |
| `token_endpoint_auth_method` | `client_secret_basic`（既定）/ `client_secret_post` / `none` のみ |
| `grant_types` | `authorization_code`（既定）と `refresh_token` のみ。`refresh_token` 単独は不整合として拒否します |
| `response_types` | `["code"]`（既定）のみ |
| `client_name` | 128 文字以内の表示名。制御文字は拒否します。画面への表示統合はしません |
| `scope` | このクライアントが要求してよい scope のスペース区切り文字列（RFC 7591 §2）。登録するとクライアント単位の許可一覧になり、一覧外の scope 要求は `invalid_scope` で拒否されます。省略すると制限を掛けずに登録します |

`token_endpoint_auth_method: "none"` で登録したクライアントは public client になり、`client_secret` は発行されません。
`grant_types` に Token Exchange や CIBA などの URN は登録できません。
それらの experimental grant を使うクライアントは、静的な登録簿に書いてください。

`scope` の構文は RFC 6749 §3.3（スペース 1 つ区切り）で検査し、重複する値は 1 つに正規化します。
`--scope` でカスタムスコープを宣言した構成では、OP が受理する一覧（`scopes.ts` の `SUPPORTED_SCOPES`）に無い値の登録を `invalid_client_metadata` で拒否します。
登録した値は 201 応答の `scope` にスペース区切りでそのまま返るので、登録結果をクライアント側から確認できます。

## エラー処理

| 応答 | 条件 |
|---|---|
| `400` + `invalid_redirect_uri` | `redirect_uris` の欠落・空・非文字列要素・URI 規則違反 |
| `400` + `invalid_client_metadata` | `Content-Type` が `application/json` でない、ボディが JSON オブジェクトでない、ボディ長超過、理解するフィールドの不正値 |
| `401` + `WWW-Authenticate: Bearer` | initial access token を要求する構成で `Authorization` ヘッダが無い（RFC 6750 §3.1 に従いエラーコードは付きません） |
| `401` + `WWW-Authenticate: Bearer error="invalid_token"` | ヘッダはあるがトークンが一致しない |
| `429` + `too_many_registrations` | `maxRegisteredClients` 超過。メタデータの不備ではないため `invalid_client_metadata` は使いません |

`error_description` は固定の ASCII 文言で、送られた URI やメタデータの値を反映しません。

## セキュリティ上の注意

オープン登録の脅威モデルの中心は「未認証で書き込めるエンドポイント」であることです。

- **登録できたことは信頼ではありません**。201 は「メタデータが形式的に妥当」以上の意味を持たず、認可判断はすべて以降のフローの検証（PKCE、`redirect_uri` 完全一致、クライアント認証）が担います
- 在庫の上限（`maxRegisteredClients`）とボディ長上限で、メモリ消費に天井を付けています。IP 単位の流量制御は持たないので、公開するならリバースプロキシや PaaS 側でレート制限を掛けてください（RFC 7591 §5）
- `client_id` は `dcr-` プレフィックス付きの乱数で、リクエストから指定できません。人間が命名する静的クライアントと名前空間が分かれ、上書きは構造的に起きません
- `client_secret` は 256 ビットの乱数で、201 応答に一度だけ現れます。応答には `Cache-Control: no-store` が付き、ログには出力されません
- initial access token の照合は定数時間比較で行い、期待トークンの情報（長さ、部分一致）は応答に現れません
- URL を参照しにいくメタデータ（`jwks_uri` など）を受理しないため、登録処理が外部へリクエストを発行する経路はありません（SSRF の面が開きません）

## 既知の制約

- 動的登録クライアントは in-memory ストアにだけ入り、**プロセス再起動で消えます**。`--db` で生成しても同じで、クライアント表に入る静的クライアントと違い永続化されません（PAR や Device の experimental ストアと同じ割り切りです）
- RFC 7592 を実装しないため、登録の参照・更新・削除はできません。失効の手段は再起動だけです
- initial access token は単一の固定文字列で、発行・ローテーション・複数管理はありません
- 受理するメタデータは上記の 6 フィールドだけです

## core の静的登録との違い

静的登録は設定（`config.ts` の Map、または `--db` のクライアント表）の編集と再起動を要し、動的登録は API 呼び出し 1 回で済みます。
登録後の扱いは同一で、クライアント解決が「設定済みの解決 → 動的ストア」の順に引くだけの違いです。
同じ `client_id` が両方にあることは起きません（動的側は常に `dcr-` プレフィックス付きの乱数です）。

## トラブルシューティング

- **`/register` が 404**：`--enable dynamic-client-registration` を付けて生成したかを discovery の `registration_endpoint` で確認してください
- **401 が返る**：`dynamicClientRegistrationConfig.initialAccessToken` が設定されています。`Authorization: Bearer <値>` を付けるか、オープン登録に戻してください
- **登録したクライアントが再起動後に消えた**：既知の制約のとおり in-memory です。恒久的なクライアントは静的な登録簿に書いてください
- **`text/plain` で送った JSON が 400 になる**：RFC 7591 §3.1 のとおり `Content-Type: application/json` だけを受理します

## 参考資料

- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591)
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- [OpenID Connect Discovery 1.0 §3](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata)（`registration_endpoint`）
- [RFC 6750 §3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1)（initial access token 構成時の 401 応答）
