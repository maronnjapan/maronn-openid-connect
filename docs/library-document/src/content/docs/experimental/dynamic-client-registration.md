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
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)（`redirect_uris` を必須にする制約、`application_type` ごとの `redirect_uris` の制約、`default_max_age` と `*_signed_response_alg`、`request_uris` と `request_object_signing_alg`）

次はスコープ外です。

- RFC 7592（登録後の参照・更新・削除）。`registration_access_token` と `registration_client_uri` は、両方返すか両方返さないかの MUST に従い、どちらも返しません
- initial access token と software statement の発行と検証。どちらも、設定に渡した関数が判定します。関数を渡さない既定ではオープン登録で、`software_statement` は無視します（RFC 7591 §3.1.1）
- `sector_identifier_uri` のように登録時に URL を参照しに行く必要のあるメタデータの解釈（未知フィールドとして無視します）。`request_uris` と `jwks_uri` は URL の形だけを検査して登録し、取得は OP が要るとき（`request_uri` が使われた認可リクエスト、鍵が要る検証）に行います

## ユースケース

- OIDF Conformance Suite の動的登録前提のテストプラン（Basic OP に加え、Implicit OP と Hybrid OP の `client_registration=dynamic_client`）を、この OP に向けて実行する。Suite は module ごとに `POST /register` でクライアントを登録し、`jwks` と `request_uris` を使って Request Object の module（`request` と `request_uri`）も走らせる（`tests/conformance/README.md` の「Dynamic client registration で実行する」）
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
| `maxRegisteredClients` | `100` | 動的登録クライアントの総数上限。超過時は `429` |
| `maxRegistrationBodyBytes` | `16384` | リクエストボディの上限（UTF-8 バイト長） |
| `tokenEndpointAuthMethods` | `client_secret_basic` / `client_secret_post` / `none` | 登録できる `token_endpoint_auth_method`。トークンエンドポイントに `private_key_jwt` などの認証を足したら、ここにも足します |
| `grantTypes` | `authorization_code` / `refresh_token` / `implicit` | 登録できる `grant_type`。OP が答える grant（`authorization_code`、生成した機能の grant、implicit-flow があるときの `implicit`）に絞られます。Token Exchange や CIBA の URN を足すと、動的登録クライアントにもその grant を許します |
| `jwksPurposes` | `request_object` / `private_key_jwt` / `dpop` | 登録された `jwks` の鍵、または `jwks_uri` から取得した鍵を `ClientKeyResolver` のどの用途に置くか |
| `allowJwksUri` | `true` | `jwks_uri` の登録を受け付けるか。`false` にすると `invalid_client_metadata` で拒否し、鍵は `jwks` でだけ登録できます（OP が登録者の URL を取得しに行く経路を閉じたいとき） |
| `jwksUriCacheTtlSeconds` | `300` | `jwks_uri` から取得した JWK Set を覚えておく秒数。この間は取得し直しません（OIDC Core 1.0 §10.1.1 の鍵のローテーションは、この時間の範囲で追います）。取得に失敗した URL は 30 秒後に取得し直します |
| `jwksUriFetch` | `undefined` | `jwks_uri` の取得に使う fetch。未設定なら `globalThis.fetch`。独自の信頼設定やプロキシ、テストでの記録に差し替えます |
| `verifyInitialAccessToken` | `undefined` | 設定すると `POST /register` に Bearer トークンの提示を要求し、関数がそのトークンで登録の可否を決めます。未設定ならオープン登録（RFC 7591 §3.1 の SHOULD） |
| `verifySoftwareStatement` | `undefined` | 設定すると `POST /register` に `software_statement` を要求し、関数が検証して主張するメタデータを返します。未設定なら `software_statement` を無視します（RFC 7591 §3.1.1） |
| `customClientMetadata` | `{}` | 標準外のメタデータの検証関数の表（次節） |

Hono / Express / Fastify では、生成ファイルを編集せずに `applyOidc` のオプションから設定を足せます。
一覧（`tokenEndpointAuthMethods`、`grantTypes`、`jwksPurposes`）とカスタムメタデータの表は、渡した値が生成コードの既定に**追加**されます。
生成コードが許す値を書き写す必要はありません。
数値の設定と判定関数は置き換わり、渡さなかった項目は既定のままです。
既定の一覧から値を外すときは `config.ts` を編集します。

```typescript
applyOidc(app, {
  // ...
  dynamicClientRegistration: {
    maxRegisteredClients: 10,
    // 既定の authorization_code / refresh_token / implicit に加わる
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code'],
    // トークンエンドポイントに private_key_jwt の検証を足したうえで
    tokenEndpointAuthMethods: ['private_key_jwt'],
    // 登録に initial access token を要求し、可否は自分の関数で決める
    verifyInitialAccessToken: async (token) => await registrationTickets.isValid(token),
    // software statement を要求し、自分の関数で検証して主張を返す
    verifySoftwareStatement: async (statement) => ({ metadata: await publisherRegistry.verify(statement) }),
    customClientMetadata: { tenant_id: validateTenantId },
  },
});
```

Next.js では、アプリの起動時（`instrumentation.ts`）に `config.ts` の `extendDynamicClientRegistrationConfig()` を呼びます。
引数と追加の意味は `applyOidc` のオプションと同じです。

```typescript
import { extendDynamicClientRegistrationConfig } from './app/_oidc-provider/features/dynamic-client-registration/config';

extendDynamicClientRegistrationConfig({
  verifyInitialAccessToken: async (token) => await registrationTickets.isValid(token),
  verifySoftwareStatement: async (statement) => ({ metadata: await publisherRegistry.verify(statement) }),
});
```

生成コードは、initial access token も software statement も自分では検証しません。
要求するかどうかと、何を正しいとするかは、渡した関数だけが決めます。

## 登録の判定を渡す

誰が登録できるか、software statement をどう検証するか、標準外のどのメタデータを受理するかは、`dynamicClientRegistrationConfig` の 3 つの設定が決めます。
`config.ts` に書くか、同じ形の値を `dynamicClientRegistration` オプション（Next.js は `extendDynamicClientRegistrationConfig()`）で渡します。
生成コードは判定の既定実装を持ちません。
関数を渡さない項目は、要求も検証もしません。

| 設定 | 未設定（既定） | 設定したとき |
|---|---|---|
| `verifyInitialAccessToken(token, config)` | オープン登録。`Authorization` ヘッダは読みません | Bearer トークン（RFC 6750 §2.1）の無い登録は `401` + `WWW-Authenticate: Bearer`。トークンがあれば関数に渡し、`false` なら `401` + `error="invalid_token"`。トークンの形式、発行、照合はすべて関数の責務です |
| `verifySoftwareStatement(softwareStatement, config)` | `software_statement` を無視し、平文の値だけで登録します（RFC 7591 §3.1.1） | `software_statement` の無い登録は `400` + `invalid_client_metadata`。あれば JWT 文字列をそのまま関数に渡し、返った `metadata` を平文の値に優先して適用します。拒否は `ClientRegistrationError` を `invalid_software_statement` か `unapproved_software_statement` で投げます |
| `customClientMetadata` | 空。標準外のフィールドはすべて無視 | 標準にない項目（テナント ID など）を検証して登録し、応答に返します |

`verifyInitialAccessToken` が受け取るのは `Authorization: Bearer <token>` の `<token>` だけです。
ヘッダの解析（RFC 6750 §2.1 の形式、スキーム名の大文字小文字）は生成コードが行い、形式に合わないヘッダは「トークンの提示なし」として扱います。

`verifySoftwareStatement` の例として、承認した発行者の公開鍵で署名を検証し、ペイロードをそのまま主張として返す関数を示します。
core の `parseRequestObject` は compact JWS を解析し、渡した JWK Set で署名を検証して、ペイロードを返します。
検証前に読む `iss` は鍵を選ぶためだけに使い、返す値は検証後のペイロードから取ります。

```typescript
import { parseRequestObject } from '@maronn-openid-connect/core';
import { ClientRegistrationError } from '@maronn-openid-connect/experimental/dynamic-client-registration';

const publishers = new Map([['https://publisher.example.com', publisherJwks]]);

const verifySoftwareStatement = async (statement: string) => {
  const jwks = publishers.get(unverifiedIssuerOf(statement) ?? '');
  if (jwks === undefined) {
    throw new ClientRegistrationError('unapproved_software_statement', 'the issuer is not approved');
  }
  try {
    const claims = await parseRequestObject(statement, { jwks, supportedSigningAlgs: ['RS256'], allowUnsigned: false });
    return { metadata: claims };
  } catch {
    throw new ClientRegistrationError('invalid_software_statement', 'the signature could not be verified');
  }
};
```

関数が返した `metadata` は平文のメタデータと同じ検査を通ります。
理解しないクレーム（`iss` や `exp` などの JWT 標準クレームを含む）は無視するので、取り除く必要はありません。
RFC 7591 が statement の中身に定める必須項目は `iss` だけで（§2.3）、生成コードは中身を検査しません。

`customClientMetadata` はメタデータ名をキーに検証関数を置く表です。
関数はリクエストの値（無ければ `undefined`）とリクエスト全体を受け取り、登録する値を返します。
`undefined` を返した項目は登録せず、拒否するときは `ClientRegistrationError` を `invalid_client_metadata` で投げます。
登録した値は 201 応答に現れ、`RegisteredClient.registrationMetadata` からも読めます。
`config.ts` に書いた表に、`dynamicClientRegistration` オプション（Next.js は `extendDynamicClientRegistrationConfig()`）で渡した表が追加されます。

```typescript
customClientMetadata: {
  tenant_id: (value) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value)) {
      throw new ClientRegistrationError('invalid_client_metadata', 'tenant_id must be a lowercase identifier');
    }
    return value;
  },
},
```

## 生成されるもの

Hono / Express / Fastify では、この機能のコードはすべて `features/dynamic-client-registration/` にあります。

| ファイル | 内容 |
|---|---|
| `features/dynamic-client-registration/endpoints/register/` | 登録エンドポイント（`POST /register`）。`pipeline.ts` がステップ（`steps/`）を順に呼ぶ |
| `features/dynamic-client-registration/config.ts` | 設定オブジェクト `dynamicClientRegistrationConfig`、オプションを既定へ足す `extendDynamicClientRegistrationConfig()`、`createApp` / `applyOidc` に足す `dynamicClientRegistration` オプション、`RegisteredClient.registrationMetadata` の宣言 |
| `features/dynamic-client-registration/store.ts` | 動的登録クライアントの in-memory ストア、保存するレコードの組み立て、設定済みのクライアント解決と鍵解決へ合成する `withDynamicallyRegisteredClients()` / `withDynamicallyRegisteredClientKeys()` |
| `features/dynamic-client-registration/feature.ts` | `/register` のルート、`registration_endpoint` メタデータ、リクエストのコンテキストでのクライアント解決と鍵解決への合成 |

Next.js では、`(dynamic-client-registration)/register/route.ts` がエンドポイントで、設定とストアは `_oidc-provider/features/dynamic-client-registration/` にあります。

## 受理するメタデータ

理解するフィールドは次のとおりで、それ以外は RFC 7591 §2 のとおり黙って無視します（登録はエラーになりません）。
既定値を適用した値と、OP が補った値（`jwks` の `alg` / `use`）は、201 応答にそのまま現れます（OIDC Registration 1.0 §3.2 は、AS が適用した既定値を応答に含めることを求めます）。

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
| `application_type` | `web` か `native`、既定 `web`。`native` は `redirect_uris` をカスタムスキームとループバックの http に限り、`web` で `implicit` を使う登録は https かつ `localhost` 以外に限ります（OIDC Registration 1.0 §2）。省略時も `web` として検査し、`application_type: "web"` を登録して返します |
| `default_max_age` | 非負整数（秒） |
| `id_token_signed_response_alg` / `userinfo_signed_response_alg` | OP の署名鍵の alg（discovery の `*_signing_alg_values_supported`）のみ。`id_token_signed_response_alg` は既定 `RS256` で、省略時も登録して返します。`userinfo_signed_response_alg` に既定は無く、省略すると UserInfo は署名しない JSON です |
| `jwks` | RSA（RS256 / RS384 / RS512）か EC（P-256 / P-384 / P-521）の署名用公開鍵、1 〜 16 件。秘密鍵パラメータを含む鍵は拒否します。`alg` と `use` が無い鍵には既定を補います。`jwks_uri` との併記は拒否します |
| `jwks_uri` | クライアントの JWK Set 文書の URL（https。ループバックの http は開発用に可。2048 文字以内の表示可能 ASCII。資格情報無し）。登録時には取得せず、署名付き Request Object の検証などで鍵が要るときに OP が GET して、`jwksPurposes` の用途の鍵にします。取得した文書は `jwksUriCacheTtlSeconds` の間覚えておきます。秘密鍵か対称鍵を含む文書は全体を拒否し、署名に使えない鍵（`use: enc`、未対応の `kty` / `alg`）は落とします。`allowJwksUri: false` の OP は登録を拒否します |
| `request_uris` | 認可リクエストの `request_uri`（OIDC Core 1.0 §6.2）に使う URL、1 〜 32 件。https（ループバックの http は開発用に可）、512 文字以内の表示可能 ASCII、資格情報無し。フラグメントは値の一部として登録します。登録時には取得しに行かず、`/authorize` が `request_uri` をこの一覧と完全一致で照合してから GET します（`requireRequestUriRegistration`。[Features](../../reference/features/) を参照） |
| `request_object_signing_alg` | このクライアントの Request Object に必須の JWS alg。OP が discovery の `request_object_signing_alg_values_supported` に広告する値（`RS256`。`allowUnsignedRequestObject` のときは `none` も）のみ。登録すると、その alg で署名されていない Request Object を `/authorize` が拒否します |
| `software_statement` | 次節 |

`grant_types` に Token Exchange や CIBA などの URN を登録できるのは、`grantTypes` に足した場合だけです。
足していない OP では、それらの experimental grant を使うクライアントは静的な登録簿に書いてください。

## software statement

`software_statement`（RFC 7591 §2.3）は、ソフトウェアの発行者が署名した JWT で、クライアントメタデータの集合をまとめて主張します。
どの発行者を信頼し、どう署名を確かめるかは RFC 7591 の対象外で、この OP は statement を自分では検証しません。

- `verifySoftwareStatement` が未設定（既定）の OP は、`software_statement` を無視して平文の値だけで登録します。RFC 7591 §3.1.1 が対応しない AS に許す挙動で、応答に `software_statement` は現れません
- 設定した OP は、すべての登録に `software_statement` を要求し（無ければ `invalid_client_metadata`）、関数が検証して返したメタデータを平文の値に優先して適用します（§3.1.1）。登録に使った statement は 201 応答の `software_statement` にそのまま返し、statement から使った要素もトップレベルの値として返します（§3.2.1）
- 関数は `ClientRegistrationError` を `invalid_software_statement`（検証できない）か `unapproved_software_statement`（発行者を承認しない）で投げて拒否します（§3.2.2）

```text
POST /register
{
  "redirect_uris": ["https://app.example.com/cb"],
  "client_name": "Plain Name",
  "software_statement": "eyJhbGciOiJSUzI1NiIsImtpZCI6InB1Yi0xIn0..."
}
（statement の中身: {"iss": "https://publisher.example.com", "client_name": "Published App", "software_id": "4NRB1-0XZABZI9E6-5SM3R"}）

201 Created（verifySoftwareStatement を設定した OP）
{ ..., "client_name": "Published App", "software_id": "4NRB1-0XZABZI9E6-5SM3R", "software_statement": "eyJhbGciOi..." }
```

statement の中のクレームに、RFC 7591 が定める必須項目は `iss` だけです（§2.3）。
§2 のクライアントメタデータはどれもクレームとして送れるので、OP は中身に許可リストを置かず、関数が返したメタデータを平文と同じ検査に通します。

## エラー処理

| 応答 | 条件 |
|---|---|
| `400` + `invalid_redirect_uri` | `redirect_uris` の欠落・空・非文字列要素・URI 規則違反 |
| `400` + `invalid_client_metadata` | `Content-Type` が `application/json` でない、ボディが JSON オブジェクトでない、ボディ長超過、理解するフィールドの不正値、`grant_types` と `response_types` の不整合、`application_type` の制約違反、カスタムメタデータの検証失敗、`verifySoftwareStatement` を設定した OP で `software_statement` が無い |
| `400` + `invalid_software_statement` | `software_statement` が文字列でない。または `verifySoftwareStatement` がこのコードで拒否した |
| `400` + `unapproved_software_statement` | `verifySoftwareStatement` がこのコードで拒否した |
| `401` + `WWW-Authenticate: Bearer` | `verifyInitialAccessToken` を設定した OP で、Bearer トークンが無い（`Authorization` ヘッダが無いか、Bearer 以外のスキーム。RFC 6750 §3.1 に従いエラーコードは付きません） |
| `401` + `WWW-Authenticate: Bearer error="invalid_token"` | `verifyInitialAccessToken` が Bearer トークンを拒否した |
| `429` + `too_many_registrations` | `maxRegisteredClients` 超過。メタデータの不備ではないため `invalid_client_metadata` は使いません |

`error_description` は固定の ASCII 文言で、送られた URI やメタデータの値、JWT のヘッダ値を反映しません。
許可一覧を示す文言（`token_endpoint_auth_method must be one of ...` など）は設定由来の値だけを含みます。
渡した関数が投げる `ClientRegistrationError` の文言も、同じ方針で書くことを推奨します。

## セキュリティ上の注意

オープン登録の脅威モデルの中心は「未認証で書き込めるエンドポイント」であることです。

- **登録できたことは信頼ではありません**。201 は「メタデータが形式的に妥当」以上の意味を持たず、認可判断はすべて以降のフローの検証（PKCE、`redirect_uri` 完全一致、クライアント認証、登録 scope の照合）が担います
- 在庫の上限（`maxRegisteredClients`）とボディ長上限で、メモリ消費に天井を付けています。IP 単位の流量制御は持たないので、公開するならリバースプロキシや PaaS 側でレート制限を掛けてください（RFC 7591 §5）
- `client_id` は `dcr-` プレフィックス付きの乱数で、リクエストから指定できません。人間が命名する静的クライアントと名前空間が分かれ、上書きは構造的に起きません
- `client_secret` は 256 ビットの乱数で、201 応答に一度だけ現れます。応答には `Cache-Control: no-store` が付き、ログには出力されません。ストアにはハッシュだけを保存します
- initial access token と software statement の検証は、渡した関数の責務です。生成コードが応答に反映するのは、Bearer トークンの有無と関数の返り値だけです。関数を書くときは、トークンの比較を定数時間で行い、statement の署名を `iss` で選んだ鍵と許したアルゴリズムだけで検証し、`alg: none` を受理しないでください
- 登録処理が外部へリクエストを発行する経路はありません。`logo_uri` などの表示用 URL は構文だけを検査し、取得しません。`request_uris` と `jwks_uri` も登録時には取得せず、OP が要るとき（`request_uri` を登録した値と完全一致で照合したあとの GET、そのクライアントの署名を検証するときの JWK Set の GET）に取得します。どちらも https に限り、リダイレクトに従わず、上限とタイムアウトを持ち、取得した内容は登録者に返りません。それでも、未認証の登録者が OP に自分の選んだ URL を GET させられること（blind SSRF）は残ります。OP から到達できる内部サービスを守りたい環境では、`allowJwksUri: false` で `jwks_uri` を閉じ、`requireRequestUriRegistration` は `true` のままにしてください
- `grantTypes` に experimental grant の URN を足すのは、未認証の登録者にその grant を開くことだと意識してください。CIBA のように利用者へ働きかける grant は、initial access token と組み合わせるか、静的登録に留めるのが安全です

## 既知の制約

- 動的登録クライアントは in-memory ストアにだけ入り、**プロセス再起動で消えます**。`--db` で生成しても同じで、クライアント表に入る静的クライアントと違い永続化されません（PAR や Device の experimental ストアと同じ割り切りです）
- RFC 7592 を実装しないため、登録の参照・更新・削除はできません。失効の手段は再起動だけです
- initial access token と software statement の検証は生成コードに含まれません。関数を渡さない既定ではオープン登録で、`software_statement` は無視します
- `sector_identifier_uri` と暗号化系のメタデータは理解せず、無視します
- `jwks_uri` から取得した鍵は、`kid` の一致しない署名を受け取っても取得し直しません。鍵のローテーションは `jwksUriCacheTtlSeconds`（既定 5 分）の範囲で追います。取得先はプロセスの中の `jwksUriCache` に覚えるので、複数インスタンスでは各インスタンスが取得します

## core の静的登録との違い

静的登録は運用者が `registerClient()`（または `--db sql` のクライアント表への `INSERT`）を実行する必要があり、動的登録は API 呼び出し 1 回で済みます。
登録後の扱いは同一で、クライアント解決と鍵解決が「設定済みの解決 → 動的ストア」の順に引くだけの違いです。
同じ `client_id` が両方にあることは起きません（動的側は常に `dcr-` プレフィックス付きの乱数です）。
動的登録のレコードは、静的登録には無い `registrationMetadata`（登録した全メタデータ）を持ちます。

## トラブルシューティング

- **`/register` が 404**：`--enable dynamic-client-registration` を付けて生成したかを discovery の `registration_endpoint` で確認してください
- **401 が返る**：`verifyInitialAccessToken` が設定されています。`Authorization: Bearer <トークン>` を付けるか、関数を外してオープン登録に戻してください
- **`software_statement is required` が返る**：`verifySoftwareStatement` を設定した OP は、すべての登録に `software_statement` を要求します
- **`software_statement` を送ったのに応答に無い**：`verifySoftwareStatement` が未設定の OP は statement を無視します（RFC 7591 §3.1.1）。受け付けるには関数を設定してください
- **`jwks_uri` を登録したのに Request Object が `invalid_request_object`（`no JWKS registered ...`）になる**：OP がその URL を取得できていません（https 以外、リダイレクト、200 以外、JSON でない、秘密鍵を含む、など）。取得に失敗した URL は 30 秒間は取得し直さないので、直してから少し待ってください。独自の証明書を使う環境では `jwksUriFetch` に信頼設定を持つ fetch を渡します
- **`response_types` が拒否される**：`implicit-flow` / `hybrid-flow` を生成していない OP は `code` しか答えません。discovery の `response_types_supported` を確認してください
- **登録したクライアントが再起動後に消えた**：既知の制約のとおり in-memory です。恒久的なクライアントは `registerClient()` で静的に登録してください（再起動をまたいで残るのは `--db sql` / `--db kv` で生成した `db/` への登録だけです）
- **`text/plain` で送った JSON が 400 になる**：RFC 7591 §3.1 のとおり `Content-Type: application/json` だけを受理します

## 参考資料

- [RFC 7591: OAuth 2.0 Dynamic Client Registration Protocol](https://datatracker.ietf.org/doc/html/rfc7591)
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- [OpenID Connect Discovery 1.0 §3](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata)（`registration_endpoint`）
- [RFC 6750 §3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1)（initial access token 構成時の 401 応答）
- [RFC 7515](https://datatracker.ietf.org/doc/html/rfc7515)（software statement の JWS）
