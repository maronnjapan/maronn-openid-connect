---
title: JARM (JWT Secured Authorization Response Mode)
description: 認可レスポンスを OP 署名付き JWT で返す JARM の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

通常の認可レスポンスは、`code` / `state` を**平文のクエリパラメータ**でクライアントへ返します。

```text
302 Found
Location: https://client.example.com/cb?code=abc123&state=xyz&iss=https://op.example.com
```

ブラウザを経由するこの経路には署名がありません。途中で `code` や `state` が差し替えられてもクライアントは気づけず、レスポンスがどの OP から来たのかも暗号学的には確認できません。

JARM は、認可レスポンス一式を **OP が署名した JWT 1 つ**に包み、`response` パラメータだけで返します。

```text
302 Found
Location: https://client.example.com/cb?response=eyJhbGciOiJSUzI1NiIsImtpZCI6...
```

クライアントは `jwks_uri` の公開鍵で署名を検証し、`iss` / `aud` / `exp` を確認してから `code` を使います。これで**応答の改竄検知**と**出所の証明**（mix-up 攻撃対策）が同時に得られます。

クライアントが `response_mode` を指定しない限り、応答は従来どおりの平文クエリのままです。`--enable jarm` で生成しただけでは既存クライアントの挙動は変わりません。

## 対応仕様

| 仕様 | 対応範囲 |
|---|---|
| JARM §2.1 | 応答 JWT のクレーム構造（`iss` / `aud` / `exp` ＋ 認可レスポンスパラメータ）・成功 / エラー両方 |
| JARM §2.3.1 | `query.jwt`（`response` パラメータ 1 つだけで運ぶ） |
| JARM §2.3.4 | 省略形 `jwt`（`response_type=code` では `query.jwt` と同義） |
| JARM §3 | 署名アルゴリズムは **RS256 固定**（未登録クライアントの既定値と一致） |
| JARM §4 | Provider Metadata（`response_modes_supported` / `authorization_signing_alg_values_supported`） |
| JARM §2.3.2 | **非対応**（`fragment.jwt`。この OP は `response_type=code` のみ）。指定すると `invalid_request` |
| JARM §2.3.3 | **非対応**（`form_post.jwt`）。指定すると `invalid_request` |
| JARM §2.2（JWE） | **非対応**（署名のみ。`authorization_encrypted_response_alg` / `_enc` は解釈しません） |
| JARM §3（クライアント別 alg） | **非対応**（`authorization_signed_response_alg` の登録は解釈しません） |

## ユースケース

- FAPI 1.0 Advanced / FAPI 2.0 Message Signing への対応可否を、クライアント実装側で検証する
- mix-up 攻撃（RFC 9700 §4.4）対策として、JARM の `iss` クレーム方式と RFC 9207 の `iss` パラメータ方式を比較する
- 認可レスポンスの改竄（`state` 差し替え・`code` 注入）に対する署名保護の効果を、攻撃シナリオ込みで手元で再現する
- 既存クライアントに「JWT 応答も検証できる」実装を足すときの回帰確認

## 前提条件

- 生成 OP を `--enable jarm` で作成していること
- クライアントが JWS（RS256）を検証できること。`jwks_uri` から `kid` で鍵を引ける実装が必要です
- auth transaction store が**未知のフィールドを透過的に保存する**こと（後述の [ストア契約](#ストア契約未知フィールドの保存) 参照）

## 有効化

```bash
maronn-oidc generate hono --enable jarm
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`--enable jarm` を付けなかった場合、JARM に関するコードは一切生成されず、インストール案内にも `@maronn-openid-connect/experimental` は現れません。

`@maronn-openid-connect/core` は `@maronn-openid-connect/experimental` の peerDependency です。experimental は core より速く更新されるので、**バージョン番号が揃っていない状態は正常です**。インストール時に `unmet peer @maronn-openid-connect/core` が出たときだけ core を上げてください。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/jarm.ts` | 設定値 `jarmConfig` と、起動時に範囲を検証する `assertJarmLifetimeSeconds` 呼び出し |
| `routes/authorize.ts` | `response_mode` の解釈、応答 JWT を組む `buildSuccessRedirect` / `buildErrorRedirect`、トランザクションへのモード記録 |
| `routes/consent.ts` | 承認 / 拒否の応答を記録済みモードで返す分岐 |
| `routes/discovery.ts` | `response_modes_supported` の拡張と `authorization_signing_alg_values_supported` の広告 |
| `conformance.test.ts` | JARM の契約テストの追加 |

Next.js では、consent が Server Action（`consent/actions.ts`）としても生成されるため、そちらにも同じ分岐が入ります。

## 設定

`routes/jarm.ts` の `jarmConfig` を編集します。認可エンドポイントと consent エンドポイントの両方がここを参照します。

```typescript
export const jarmConfig = {
  // 応答 JWT の exp までの秒数。JARM §2.1 は最大 10 分を RECOMMENDED としており、
  // 5〜600 秒の範囲外はモジュール読み込み時にエラーで失敗します。
  jarmResponseLifetimeSeconds: 60,
};
```

変更できない項目は次のとおりです。

| 項目 | 値 | 理由 |
|---|---|---|
| 署名アルゴリズム | `RS256` | JARM §3 の未登録クライアント既定値。設定不能にすることで `alg: none` を構造的に生成しません |
| 応答パラメータ名 | `response` | JARM §2.3.1 |
| 対応 `response_mode` | `query.jwt` / `jwt` | この OP は `response_type=code` 専用 |

署名鍵は OP の汎用 `signingKeyProvider` の active key です。ID Token 用に別の鍵を設定している場合でも、JARM 応答は汎用鍵で署名されます（JARM は応答 JWT の鍵用途を分けていません）。公開鍵は `/.well-known/jwks.json` に同じ `kid` で載るため、クライアントは `kid` で検証鍵を解決できます。

## フロー

```text
Client                                             OP
  |--- GET /authorize?...&response_mode=query.jwt -->|
  |                                                  | 通常どおり認可リクエストを検証
  |                                                  | redirect_uri 確定後に response_mode を解釈
  |<-- 302 /login -----------------------------------|
  |            ...ログイン・同意は通常フローと完全に同一...
  |                                                  | code 発行後、応答 JWT を生成（RS256）
  |<-- 302 redirect_uri?response=<JWT> --------------|
  |                                                  |
  |  署名検証 → iss / aud / exp 確認 → code 取り出し   |
  |--- POST /token (code, code_verifier) ----------->|  トークン交換は通常フローと同一
  |<-- 200 {access_token, id_token, ...} ------------|
```

### リクエスト例

```http
GET /authorize?response_type=code&client_id=web-app
  &redirect_uri=https%3A%2F%2Fclient.example.com%2Fcb
  &scope=openid&state=S8NJ7&nonce=n-0S6
  &code_challenge=E9Mel...&code_challenge_method=S256
  &response_mode=query.jwt HTTP/1.1
Host: op.example.com
```

### 応答例

```http
HTTP/1.1 302 Found
Location: https://client.example.com/cb?response=eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0.eyJjb2RlIjoi...
```

JOSE ヘッダー（`typ` は付きません。JARM は規定しておらず §2.3.1 の実例にもありません）:

```json
{ "alg": "RS256", "kid": "key-1" }
```

成功時のペイロード:

```json
{
  "code": "PyyFaux2o7Q0YfXBU32jhw",
  "state": "S8NJ7",
  "iss": "https://op.example.com",
  "aud": "web-app",
  "exp": 1754092860
}
```

エラー時のペイロード:

```json
{
  "error": "access_denied",
  "state": "S8NJ7",
  "iss": "https://op.example.com",
  "aud": "web-app",
  "exp": 1754092860
}
```

**成功・エラーとも `response` 以外のクエリパラメータは付きません。** 素の `code` / `state` / `iss` は消えます。RFC 9207 の `iss` パラメータが担っていた issuer 識別は、JWT の `iss` クレームが引き継ぎます（RFC 9700 §2.1 が JARM を issuer 識別手段として認めています）。

## クライアント側の検証手順

JARM §2.4 と §5.1 が要求する順序です。**鍵を取りに行く前に `iss` を確認する**のが要点で、細工された `iss` が巨大・低速な JWKS URL を指す DoS を防ぎます（§5.1 の MUST）。

1. コールバックの `response` クエリパラメータを取り出す
2. JWT のペイロードをデコードし、**先に** `iss` が期待する OP の issuer と一致することを確認する
3. その OP の `jwks_uri` から公開鍵を取得し、ヘッダーの `kid` で鍵を選ぶ
4. ヘッダーの `alg` が `RS256` であることを確認し、JWS を検証する。`alg: none` は拒否する（§2.4）
5. `aud` が自分の `client_id` と一致し、`exp` が未来であることを確認する
6. `state` を自分のトランザクションと照合し、`code` を取り出す。以降は通常の Authorization Code Flow と同じ

## API 利用例

生成コードを使わず、`@maronn-openid-connect/experimental/jarm` を直接呼ぶ場合の例です。

```typescript
import {
  buildJarmRedirectUrl,
  createJarmResponseJwt,
  resolveJarmResponseMode,
} from '@maronn-openid-connect/experimental/jarm';

// 1. response_mode を分類する（redirect_uri 確定後に呼ぶ）
const resolution = resolveJarmResponseMode(effectiveParams);
if (resolution.kind === 'unsupported-jwt-mode') {
  // fragment.jwt / form_post.jwt などは平文クエリの invalid_request で返す
  throw new AuthorizationError(
    AuthorizationErrorCode.InvalidRequest,
    `response_mode ${resolution.requested} is not supported`,
    redirectUri,
    state,
  );
}

// 2. 応答 JWT を作り、response パラメータだけを付けてリダイレクトする
if (resolution.kind === 'jarm') {
  const responseJwt = await createJarmResponseJwt({
    issuer: 'https://op.example.com',
    clientId: client.clientId,
    parameters: { code, state },          // undefined の値はクレームに入りません
    signingKey,                            // core の SigningKey をそのまま渡す
    lifetimeSeconds: 60,
  });
  return redirect(buildJarmRedirectUrl(redirectUri, responseJwt));
}
```

`resolveJarmResponseMode` が例外ではなく判別共用体を返すのは、非対応モードを検出できる時点（パラメータ解釈時）と、それをリダイレクト可能エラーにできる時点（`redirect_uri` 確定後）が呼び出し側で異なるためです。

### ストア契約（未知フィールドの保存）

JARM モードは auth transaction に `jarmResponseMode: 'query.jwt'` として記録され、ログイン・同意画面を挟んで consent エンドポイントまで store を往復します。

```typescript
import type { JarmAuthTransactionFields } from '@maronn-openid-connect/experimental/jarm';

// 保存側（authorize）
await transactionStore.put(key, { ...transaction, jarmResponseMode: 'query.jwt' }, ttl);

// 読み出し側（consent）
const transaction = (await getAuthTransaction(id, transactionStore)) as
  AuthTransaction & JarmAuthTransactionFields;
```

**store 実装は未知のフィールドを透過的に保存しなければなりません。** オブジェクトを丸ごと JSON 化する通常の実装なら自然に満たされますが、フィールドを列挙してコピーする実装では `jarmResponseMode` が落ち、JARM を要求したクライアントへ**静かに平文クエリで応答してしまいます**。生成された `conformance.test.ts` の全フローテストがこの round-trip を検出します。

なお `prompt=none` と SSO 再利用の応答は authorize ルート内で完結するため、store の往復に依存しません。ストアの取りこぼしが影響するのはログイン・同意画面を挟む経路だけです。

## エラー処理

| 条件 | 応答形式 | 内容 |
|---|---|---|
| 同意拒否・`login_required` など、リダイレクト可能なエラー | **署名付き JWT**（`response` パラメータ） | `error` / `error_description` / `state` をクレームに持つ |
| `response_mode=fragment.jwt` / `form_post.jwt` / その他の `.jwt` 値 | **平文クエリ** | `invalid_request` / `response_mode <値> is not supported` |
| `client_id` 不明・未登録 `redirect_uri` など、リダイレクトできないエラー | 従来どおり（JSON 400 / HTML エラーページ / 内部エラーページへの 303） | JARM は `redirect_uri` が確立した応答の形式なので関与しません |
| 応答 JWT の生成に失敗（署名鍵の取得失敗など） | 平文クエリ | `server_error`。JWT を作れない以上 JARM 形式では返せません |

非対応モードのエラーを平文で返すのは設計判断です。対応できない運搬方法では応答を組めず、JARM もこのケースの応答形式を規定していないためです。

## セキュリティ上の注意

| 論点 | 実装 / 注意点 |
|---|---|
| 応答の改竄 | 全パラメータを RS256 署名付き JWT に内包（JARM §5.2） |
| mix-up 攻撃 | `iss` / `aud` クレームを成功・エラーとも常に含めます（§5.3 / RFC 9700 §4.4） |
| `alg: none` | `alg` はコード上 RS256 固定で設定できません。クライアント側でも `none` を拒否してください（§2.4 の MUST） |
| リプレイ | `exp` は既定 60 秒（上限 600 秒 = §2.1 の 10 分 RECOMMENDED 内）。**JWT は code のリプレイを防ぎません**。code の単回使用と PKCE が引き続き担います（§5.2） |
| `code` の秘匿 | 署名は機密性を与えません。JWT はクエリに載るのでブラウザ履歴・Referer に残ります。これを解決するのは JWE（§5.4）だけで、本実装は**非対応**です。含まれる機密は短命な `code` のみで平文クエリ応答と同等であり、PKCE により漏えいした code 単独では交換できません |
| PII | 応答 JWT に入るのは `iss` / `aud` / `exp` ＋ 認可レスポンスパラメータだけです。ユーザー識別子や属性は含めないでください |
| ログ | 応答 JWT（`code` を含む）・認可コード・署名鍵はログに出さないでください |
| 署名コスト | 応答 JWT の署名が走るのは `client_id` 解決と登録 `redirect_uri` 検証を通過したリクエストだけです。それ以前のエラーは非リダイレクトなので署名しません |
| クライアント側の DoS | §5.1 は**クライアント側**の脅威です。`iss` の確認を鍵取得より先に行ってください（前掲の検証手順 2 → 3 の順序） |

## 既知の制約

- `fragment.jwt` / `form_post.jwt`（§2.3.2 / §2.3.3）は非対応です。指定すると `invalid_request` になります
- 応答 JWT の暗号化（JWE, §2.2）は非対応です。署名のみで、ペイロードは base64url デコードすれば誰でも読めます
- 署名アルゴリズムは RS256 固定です。クライアント別 `authorization_signed_response_alg`（§3）や PS256 / ES256 は非対応です
- `.jwt` 系以外の `response_mode`（`form_post` / `fragment` など）は従来どおり**無視**します。JARM は `.jwt` 系にだけ意味を足す拡張であり、有効化によって他の値の扱いは変わりません
- Dynamic Client Registration がないため、クライアントメタデータによる JARM 設定はできません

## core 機能との違い

| 機能 | 保護対象 | 方向 |
|---|---|---|
| `request-object`（安定機能, JAR） | 認可**リクエスト**の完全性・出所 | クライアント → OP |
| `par`（Experimental, RFC 9126） | 認可**リクエスト**の機密性・事前検証 | クライアント → OP（バックチャネル） |
| **`jarm`（本機能）** | 認可**レスポンス**の完全性・出所 | OP → クライアント |
| ID Token | 認証イベントの表明 | OP → クライアント（Token Endpoint 経由） |

「ID Token があるのに JARM は要るのか」という疑問には注意が必要です。ID Token は code フローではバックチャネルで得られるもので、**フロントチャネルを通るリダイレクト応答そのもの**は守りません。JARM は code がクライアントに届く時点の保護であり、守る場所が違います。

## トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `response_mode=query.jwt` を付けても平文クエリで返る | `--enable jarm` を付けずに生成しています。discovery の `response_modes_supported` に `query.jwt` があるか確認してください |
| ログイン・同意を挟むと平文クエリに戻る（`prompt=none` では JWT になる） | auth transaction store が未知フィールドを落としています。オブジェクトを丸ごと保存する実装へ直してください |
| `Cannot find module '@maronn-openid-connect/experimental/jarm'` | `pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental` を実行してください |
| 起動時に `jarmConfig.jarmResponseLifetimeSeconds must be an integer between 5 and 600 seconds` | 設定値が JARM §2.1 の推奨レンジ外です |
| クライアントで `code` が見つからない | JARM モードでは `code` はクエリではなく JWT のクレームです。`response` をデコードしてください |
| クライアントで `iss` パラメータが無いと言われる | 仕様どおりです。JARM モードでは JWT の `iss` クレームが同じ役割を担います |
| 署名検証に失敗する | `kid` で鍵を選んでいるか確認してください。応答 JWT は ID Token 用の鍵ではなく、汎用 `signingKeyProvider` の active key で署名されます |
| `invalid_request: response_mode fragment.jwt is not supported` | 本実装は `query.jwt` / `jwt` のみ対応です |
| 数分放置してからコールバックを処理すると `exp` 切れになる | 既定 60 秒です。リダイレクトを受けたらすぐ検証してください。延ばす場合も上限は 600 秒です |

## 参考資料

- [JWT Secured Authorization Response Mode for OAuth 2.0 (JARM)](https://openid.net/specs/oauth-v2-jarm-final.html)
- [OAuth 2.0 Multiple Response Type Encoding Practices](https://openid.net/specs/oauth-v2-multiple-response-types-1_0.html)（`response_mode` パラメータの原典）
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://datatracker.ietf.org/doc/html/rfc9700)（§2.1 の issuer 識別 / §4.4 の mix-up 攻撃）
- [RFC 9207: OAuth 2.0 Authorization Server Issuer Identification](https://datatracker.ietf.org/doc/html/rfc9207)（平文応答での issuer 識別）
- [FAPI 2.0 Message Signing](https://openid.net/specs/fapi-message-signing-2_0-final.html)（JARM を要求する上位プロファイル）
