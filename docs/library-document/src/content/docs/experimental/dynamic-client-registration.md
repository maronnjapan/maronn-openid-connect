---
title: Dynamic Client Registration
description: クライアントが実行時に自分を登録して client_id の払い出しを受ける OAuth 2.0 Dynamic Client Registration（RFC 7591）の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

この OP でクライアントを増やす方法は、既定の生成物では運用者による静的な登録しかありません。
`db/` の `registerClient()`（`--db sql` なら `INSERT` 文でも可）でクライアントを足し、その登録を実行してはじめて新しいクライアントが使えます。
`--db` を付けない生成物は OP のプロセスのメモリにデータを置くので、`registerClient()` は OP のプロセスの中（起動時の処理など）で呼びます。管理用のスクリプトや `INSERT` 文で足せるのは、`--db sql` / `--db kv` のときだけです。

Dynamic Client Registration は、クライアントが実行時に自分のメタデータを送って登録を受ける**クライアント登録エンドポイント**を定義します。
`--enable dynamic-client-registration` で生成した OP は `POST /register` を提供し、discovery に `registration_endpoint` を公表します。

```text
POST /register HTTP/1.1
Content-Type: application/json

{"redirect_uris": ["https://app.example.com/cb"], "client_name": "My Test App", "scope": "openid profile"}

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
  "client_name": "My Test App",
  "scope": "openid profile"
}
```

発行された `client_id` と `client_secret` は、そのまま `/authorize` と `/token` で使えます。
登録されたクライアントへの検証（PKCE、`redirect_uri` の完全一致、クライアント認証、登録した `scope` の範囲）は静的登録のクライアントと同一です。
`client_secret_expires_at: 0` は「無期限」を意味する仕様上の値で、即時失効ではありません。

## 対応仕様

- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591)（§2 のメタデータ、§2.1 の grant と response の対応、§2.3 / §3.1.1 の software statement、§3.2.2 のエラーコード 4 種）
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)（`redirect_uris` を必須にする制約、`application_type` ごとの `redirect_uris` の制約、`default_max_age` と `*_signed_response_alg`）

次はスコープ外です。

- RFC 7592（登録後の参照・更新・削除）。`registration_access_token` と `registration_client_uri` は、両方返すか両方返さないかの MUST に従い、どちらも返しません
- initial access token と software statement の発行。どちらも照合だけを提供します
- URL を参照しに行くメタデータの解釈（`jwks_uri`、`sector_identifier_uri`、`request_uris` など。未知フィールドとして無視します）

## ユースケース

- OIDF Conformance Suite の動的登録前提のテストプラン（Basic OP に加え、Implicit OP と Hybrid OP）を、この OP に向けて実行する
- MCP（Model Context Protocol）クライアントのように、接続時に DCR で自分を登録するエコシステムのクライアント実装を手元の OP で受け止める
- 複数のテストアプリを静的設定の編集なしに素早く繋ぐ
- `token_endpoint_auth_method` や `grant_types` の既定値がどう適用されるか、software statement のメタデータが平文の値にどう優先するかなど、RFC 7591 の素の挙動を確認する

## 前提条件

追加の前提はありません。
登録されたクライアントの解決は、どのビルドでも常に生成されるクライアント解決の経路に載ります。
Implicit Flow や Hybrid Flow の response_type を登録できるのは、`implicit-flow` / `hybrid-flow` を生成した OP だけです（既定では両方とも生成されます）。

## 有効化

```bash
maronn-oidc generate hono --enable dynamic-client-registration
pnpm add hono @maronn-openid-connect/core @maronn-openid-connect/experimental
```

有効にすると `POST /register` が生成され、discovery に `registration_endpoint` が公表されます。
有効にしない場合、生成コードは従来と変わらず、`/register` は存在しません（404）。

## 設定

設定は生成された `features/dynamic-client-registration/config.ts`（Next.js は `_oidc-provider/features/dynamic-client-registration/config.ts`）の `dynamicClientRegistrationConfig` にあります。

| 設定 | 既定値 | 意味 |
|---|---|---|
| `initialAccessToken` | `undefined` | 設定すると `POST /register` に `Authorization: Bearer <値>` の提示を要求します。未設定ならオープン登録（RFC 7591 §3.1 の SHOULD） |
| `maxRegisteredClients` | `100` | 動的登録クライアントの総数上限。超過時は `429` |
| `maxRegistrationBodyBytes` | `16384` | リクエストボディの上限（UTF-8 バイト長） |
| `tokenEndpointAuthMethods` | `client_secret_basic` / `client_secret_post` / `none` | 登録できる `token_endpoint_auth_method`。トークンエンドポイントに `private_key_jwt` などの認証を足したら、ここにも足します |
| `grantTypes` | `authorization_code` / `refresh_token` / `implicit` | 登録できる `grant_type`。OP が答える grant（`authorization_code`、生成した機能の grant、implicit-flow があるときの `implicit`）に絞られます。Token Exchange や CIBA の URN を足すと、動的登録クライアントにもその grant を許します |
| `jwksPurposes` | `request_object` / `private_key_jwt` / `dpop` | 登録された `jwks` の鍵を `ClientKeyResolver` のどの用途に置くか |
| `trustedSoftwarePublishers` | `[]` | software statement を受け入れる発行者（`issuer` と公開鍵の `jwks`）。空なら、`software_statement` を送る登録はすべて `unapproved_software_statement` になります |
| `verifyInitialAccessToken` / `verifySoftwareStatement` / `customClientMetadata` | `policy.ts` の関数 | 登録の判定（次節） |

Hono / Express / Fastify では、生成ファイルを編集せずに `applyOidc` のオプションからも上書きできます。
関数の設定も同じオプションで差し込めます。

```typescript
applyOidc(app, {
  // ...
  dynamicClientRegistration: {
    initialAccessToken: process.env.OIDC_DCR_INITIAL_ACCESS_TOKEN,
    maxRegisteredClients: 10,
    grantTypes: ['authorization_code', 'refresh_token', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code'],
    trustedSoftwarePublishers: [{ issuer: 'https://publisher.example.com', jwks: publisherJwks }],
  },
});
```

Next.js では、アプリの起動時（`instrumentation.ts`）に `dynamicClientRegistrationConfig` へ代入します。

initial access token は生成コードの設定に置く固定文字列 1 つで、発行 API やローテーションはありません。
PoC の検証用と割り切り、本番の審査付き登録には使わないでください。

## 登録の判定を変える

誰が登録できるか、どの software statement を信頼するか、標準外のどのメタデータを受理するかは、生成された `features/dynamic-client-registration/policy.ts`（Next.js は `_oidc-provider/features/dynamic-client-registration/policy.ts`）の 3 つの export が決めます。
関数の本体を書き換えるか、同じ形の関数を `dynamicClientRegistration` オプションで差し込みます。

| export | 既定の判定 | 差し替える場面 |
|---|---|---|
| `verifyRegistrationInitialAccessToken(authorization, config)` | `initialAccessToken` が未設定なら許可。設定時は `Authorization: Bearer` の値と定数時間比較 | 自分で発行した JWT や使い捨てトークンをストアで照合する |
| `verifyRegistrationSoftwareStatement(softwareStatement, config)` | `trustedSoftwarePublishers` の鍵で署名を検証し（RS256 / ES256）、`iss` の一致と `exp` / `nbf` を確かめて、主張されたメタデータを返す | 発行者をデータベースやフェデレーションから引く |
| `customClientMetadata` | 空。標準外のフィールドはすべて無視 | 標準にない項目（テナント ID など）を検証して登録し、応答に返す |

`customClientMetadata` はメタデータ名をキーに検証関数を置く表です。
関数はリクエストの値（無ければ `undefined`）とリクエスト全体を受け取り、登録する値を返します。
`undefined` を返した項目は登録せず、拒否するときは `ClientRegistrationError` を `invalid_client_metadata` で投げます。
登録した値は 201 応答に現れ、`RegisteredClient.registrationMetadata` からも読めます。

```typescript
export const customClientMetadata: Record<string, CustomClientMetadataValidator> = {
  tenant_id: (value) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value)) {
      throw new ClientRegistrationError('invalid_client_metadata', 'tenant_id must be a lowercase identifier');
    }
    return value;
  },
};
```

## 生成されるもの

Hono / Express / Fastify では、この機能のコードはすべて `features/dynamic-client-registration/` にあります。

| ファイル | 内容 |
|---|---|
| `features/dynamic-client-registration/endpoints/register/` | 登録エンドポイント（`POST /register`）。`pipeline.ts` がステップ（`steps/`）を順に呼ぶ |
| `features/dynamic-client-registration/config.ts` | 設定オブジェクト `dynamicClientRegistrationConfig` と、`createApp` / `applyOidc` に足す `dynamicClientRegistration` オプション、`RegisteredClient.registrationMetadata` の宣言 |
| `features/dynamic-client-registration/policy.ts` | 登録の判定（initial access token、software statement、カスタムメタデータ） |
| `features/dynamic-client-registration/store.ts` | 動的登録クライアントの in-memory ストア、保存するレコードの組み立て、設定済みのクライアント解決と鍵解決へ合成する `withDynamicallyRegisteredClients()` / `withDynamicallyRegisteredClientKeys()` |
| `features/dynamic-client-registration/feature.ts` | `/register` のルート、`registration_endpoint` メタデータ、リクエストのコンテキストでのクライアント解決と鍵解決への合成 |

Next.js では、`(dynamic-client-registration)/register/route.ts` がエンドポイントで、設定・判定・ストアは `_oidc-provider/features/dynamic-client-registration/` にあります。

## 受理するメタデータ

理解するフィールドは次のとおりで、それ以外は RFC 7591 §2 のとおり黙って無視します（登録はエラーになりません）。
既定値を適用した値と、OP が補った値（`jwks` の `alg` / `use`）は、201 応答にそのまま現れます。

| フィールド | 扱い |
|---|---|
| `redirect_uris` | 必須（OIDC Dynamic Client Registration 1.0 §2）。静的クライアントと同一の規則で検査します（フラグメント禁止、`javascript:` などの危険スキーム拒否、非ループバックの平文 `http://` 拒否） |
| `token_endpoint_auth_method` | 既定 `client_secret_basic`。`tokenEndpointAuthMethods` の値のみ。`none` は public client、`client_secret_*` 以外の方式は `client_secret` を持たない confidential client になります |
| `grant_types` | 既定 `["authorization_code"]`。`grantTypes` のうち OP が答える値のみ |
| `response_types` | 既定 `["code"]`。discovery の `response_types_supported` の値のみ。`code` を含む値は `authorization_code`、`token` / `id_token` を含む値は `implicit` の grant を要し、逆も同じです（RFC 7591 §2.1）。値の順序は正規化して返します |
| `scope` | RFC 6749 §3.3 の構文で検査し、重複を除いて登録します。登録したクライアントの許可 scope 一覧になり、一覧外の要求は `/authorize` が `invalid_scope` で拒否します。`--scope` を宣言した OP では標準スコープと宣言したスコープだけ登録できます |
| `client_name` | 128 文字以内の表示名。制御文字と見えない文字は拒否します |
| `client_uri` / `logo_uri` / `tos_uri` / `policy_uri` | 絶対 URL（http / https）。取得しに行かず、保持して返すだけです |
| `contacts` | 1 〜 32 件の文字列の配列 |
| `software_id` / `software_version` | 128 / 64 文字以内の文字列 |
| `application_type` | `web` か `native`。`native` は `redirect_uris` をカスタムスキームとループバックの http に限り、`web` で `implicit` を使う登録は https かつ `localhost` 以外に限ります（OIDC Registration 1.0 §2）。省略時はこれらの制約を掛けません |
| `default_max_age` | 非負整数（秒） |
| `id_token_signed_response_alg` / `userinfo_signed_response_alg` | OP の署名鍵の alg（discovery の `*_signing_alg_values_supported`）のみ |
| `jwks` | RSA（RS256 / RS384 / RS512）か EC（P-256 / P-384 / P-521）の署名用公開鍵、1 〜 16 件。秘密鍵パラメータを含む鍵は拒否します。`alg` と `use` が無い鍵には既定を補います。`jwks_uri` との併記は拒否します |
| `software_statement` | 次節 |

`grant_types` に Token Exchange や CIBA などの URN を登録できるのは、`grantTypes` に足した場合だけです。
足していない OP では、それらの experimental grant を使うクライアントは静的な登録簿に書いてください。

## software statement

`software_statement`（RFC 7591 §2.3）は、ソフトウェアの発行者が署名した JWT で、クライアントメタデータの集合をまとめて主張します。
OP は `trustedSoftwarePublishers` に置いた発行者の公開鍵で署名を検証し、`iss` が一致し `exp` / `nbf` の範囲内であれば、主張されたメタデータを平文の値に優先して適用します（§3.1.1）。
登録に使った statement は、201 応答の `software_statement` にそのまま返します（§3.2.1）。

```text
POST /register
{
  "redirect_uris": ["https://app.example.com/cb"],
  "client_name": "Plain Name",
  "software_statement": "eyJhbGciOiJSUzI1NiIsImtpZCI6InB1Yi0xIn0..."
}
（statement の中身: {"iss": "https://publisher.example.com", "client_name": "Published App", "software_id": "4NRB1-0XZABZI9E6-5SM3R"}）

201 Created
{ ..., "client_name": "Published App", "software_id": "4NRB1-0XZABZI9E6-5SM3R", "software_statement": "eyJhbGciOi..." }
```

発行者を 1 つも承認していない OP（既定）では、`software_statement` を送る登録は `unapproved_software_statement` になります。
RFC 7591 §3.1.1 は software statement に対応しない OP がそれを無視することも許していますが、この OP は検証の機構を持つため、検証できない statement を黙って通しません。
無視する挙動が必要なら `verifyRegistrationSoftwareStatement` を書き換えます。

## エラー処理

| 応答 | 条件 |
|---|---|
| `400` + `invalid_redirect_uri` | `redirect_uris` の欠落・空・非文字列要素・URI 規則違反 |
| `400` + `invalid_client_metadata` | `Content-Type` が `application/json` でない、ボディが JSON オブジェクトでない、ボディ長超過、理解するフィールドの不正値、`grant_types` と `response_types` の不整合、`application_type` の制約違反、カスタムメタデータの検証失敗 |
| `400` + `invalid_software_statement` | `software_statement` が compact JWS でない、`iss` が無い、署名が検証できない、`exp` / `nbf` の範囲外 |
| `400` + `unapproved_software_statement` | `software_statement` の発行者が `trustedSoftwarePublishers` に無い |
| `401` + `WWW-Authenticate: Bearer` | 登録の判定が拒否し、`Authorization` ヘッダが無い（RFC 6750 §3.1 に従いエラーコードは付きません） |
| `401` + `WWW-Authenticate: Bearer error="invalid_token"` | 登録の判定が拒否し、ヘッダはある |
| `429` + `too_many_registrations` | `maxRegisteredClients` 超過。メタデータの不備ではないため `invalid_client_metadata` は使いません |

`error_description` は固定の ASCII 文言で、送られた URI やメタデータの値、JWT のヘッダ値を反映しません。
許可一覧を示す文言（`token_endpoint_auth_method must be one of ...` など）は設定由来の値だけを含みます。

## セキュリティ上の注意

オープン登録の脅威モデルの中心は「未認証で書き込めるエンドポイント」であることです。

- **登録できたことは信頼ではありません**。201 は「メタデータが形式的に妥当」以上の意味を持たず、認可判断はすべて以降のフローの検証（PKCE、`redirect_uri` 完全一致、クライアント認証、登録 scope の照合）が担います
- 在庫の上限（`maxRegisteredClients`）とボディ長上限で、メモリ消費に天井を付けています。IP 単位の流量制御は持たないので、公開するならリバースプロキシや PaaS 側でレート制限を掛けてください（RFC 7591 §5）
- `client_id` は `dcr-` プレフィックス付きの乱数で、リクエストから指定できません。人間が命名する静的クライアントと名前空間が分かれ、上書きは構造的に起きません
- `client_secret` は 256 ビットの乱数で、201 応答に一度だけ現れます。応答には `Cache-Control: no-store` が付き、ログには出力されません。ストアにはハッシュだけを保存します
- initial access token の照合は定数時間比較で行い、期待トークンの情報（長さ、部分一致）は応答に現れません
- software statement の署名検証は、`iss` で選んだ発行者の鍵と、その発行者に許したアルゴリズムだけで行います。`alg: none` は受理せず、鍵の選択を statement のヘッダに任せません
- URL を参照しにいくメタデータ（`jwks_uri` など）を受理しないため、登録処理が外部へリクエストを発行する経路はありません（SSRF の面が開きません）。`logo_uri` などの表示用 URL は構文だけを検査し、取得しません
- `grantTypes` に experimental grant の URN を足すのは、未認証の登録者にその grant を開くことだと意識してください。CIBA のように利用者へ働きかける grant は、initial access token と組み合わせるか、静的登録に留めるのが安全です

## 既知の制約

- 動的登録クライアントは in-memory ストアにだけ入り、**プロセス再起動で消えます**。`--db` で生成しても同じで、クライアント表に入る静的クライアントと違い永続化されません（PAR や Device の experimental ストアと同じ割り切りです）
- RFC 7592 を実装しないため、登録の参照・更新・削除はできません。失効の手段は再起動だけです
- initial access token は単一の固定文字列で、発行・ローテーション・複数管理はありません。別の方式は `verifyRegistrationInitialAccessToken` を書き換えて実装します
- `jwks_uri`、`sector_identifier_uri`、`request_uris`、暗号化系のメタデータは理解せず、無視します
- `application_type` を省略した登録には、OIDC Registration 1.0 §2 の `application_type` ごとの制約を掛けません（core の `redirect_uris` の規則だけが掛かります）

## core の静的登録との違い

静的登録は運用者が `registerClient()`（または `--db sql` のクライアント表への `INSERT`）を実行する必要があり、動的登録は API 呼び出し 1 回で済みます。
登録後の扱いは同一で、クライアント解決と鍵解決が「設定済みの解決 → 動的ストア」の順に引くだけの違いです。
同じ `client_id` が両方にあることは起きません（動的側は常に `dcr-` プレフィックス付きの乱数です）。
動的登録のレコードは、静的登録には無い `registrationMetadata`（登録した全メタデータ）を持ちます。

## トラブルシューティング

- **`/register` が 404**：`--enable dynamic-client-registration` を付けて生成したかを discovery の `registration_endpoint` で確認してください
- **401 が返る**：`dynamicClientRegistrationConfig.initialAccessToken` が設定されています。`Authorization: Bearer <値>` を付けるか、オープン登録に戻してください
- **`unapproved_software_statement` が返る**：`trustedSoftwarePublishers` に statement の `iss` と公開鍵を登録してください。RSA の公開鍵には `alg`（`RS256` など）が要ります
- **`response_types` が拒否される**：`implicit-flow` / `hybrid-flow` を生成していない OP は `code` しか答えません。discovery の `response_types_supported` を確認してください
- **登録したクライアントが再起動後に消えた**：既知の制約のとおり in-memory です。恒久的なクライアントは `registerClient()` で静的に登録してください（再起動をまたいで残るのは `--db sql` / `--db kv` で生成した `db/` への登録だけです）
- **`text/plain` で送った JSON が 400 になる**：RFC 7591 §3.1 のとおり `Content-Type: application/json` だけを受理します

## 参考資料

- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591)
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- [OpenID Connect Discovery 1.0 §3](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata)（`registration_endpoint`）
- [RFC 6750 §3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1)（initial access token 構成時の 401 応答）
- [RFC 7515](https://datatracker.ietf.org/doc/html/rfc7515)（software statement の JWS）
