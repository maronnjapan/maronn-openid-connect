---
title: JWT Introspection Response (RFC 9701)
description: トークンイントロスペクションの結果を OP 署名付き JWT で返す RFC 9701 の試験実装。
---

:::caution[Experimental]
この機能は**試験実装**です。API・設定・生成コードの構造は予告なく変更されることがあります。
`@maronn-openid-connect/experimental` のバージョンを固定して使ってください。詳細は [Experimental機能とは](../) を参照してください。
:::

## 概要

通常のトークンイントロスペクション（RFC 7662）は、トークンの状態を**平文の JSON** で返します。

```text
200 OK
Content-Type: application/json

{"active": true, "client_id": "rs-client", "sub": "testuser", ...}
```

TLS を終端したあとの経路（多段ゲートウェイやサービスメッシュ）では、この JSON が改ざんされてもリソースサーバーは気づけず、応答がどの Authorization Server から来たのかも暗号学的には確認できません。

RFC 9701 は、イントロスペクション応答一式を **OP が署名した JWT** として返します。
リソースサーバーがリクエストの `Accept` ヘッダに `application/token-introspection+jwt` を指定したときだけ、応答が署名付き JWT になります。

```text
200 OK
Content-Type: application/token-introspection+jwt

eyJ0eXAiOiJ0b2tlbi1pbnRyb3NwZWN0aW9uK2p3dCIsImFsZyI6IlJTMjU2Iiwia2lkIjoi...
```

リソースサーバーは `jwks_uri` の公開鍵で署名を検証し、`typ` / `iss` / `aud` を確認してから `token_introspection` クレームの中身を使います。
これで**応答の改ざん検知**と**出所の証明**が得られ、イントロスペクション結果に依拠する判断（RFC 9701 §1 が挙げる、検証済みデータへの法的な依拠など）の根拠を残せます。

`Accept` でこのメディアタイプを明示しないリクエストへの応答は、従来の RFC 7662 JSON から一切変わりません。
`--enable jwt-introspection-response` で生成しただけでは既存の呼び出し元の挙動は変わりません。

## 対応仕様

| 仕様 | 対応範囲 |
|---|---|
| RFC 9701 §4 | `Accept: application/token-introspection+jwt` による応答形式の要求 |
| RFC 9701 §5 | 応答 JWT の構造（`typ: token-introspection+jwt`・トップレベル `iss` / `aud` / `iat`・`token_introspection` クレームへの封入・トップレベル `sub` / `exp` なし） |
| RFC 9701 §3 / §5 | 呼び出し元 audience 制限（発行先本人または `aud` 記載先以外には `{"active": false}`） |
| RFC 9701 §7 | Provider Metadata（`introspection_signing_alg_values_supported`） |
| RFC 9701 §6（署名 alg ネゴシエーション） | **非対応**。クライアントメタデータ `introspection_signed_response_alg` は解釈せず、**RS256 固定**（省略時の既定値と一致） |
| RFC 9701 §6（暗号化） | **非対応**（署名のみ。Nested JWT / JWE は生成しません） |
| RFC 9701 §4（アクセストークンによる RS 認証） | **非対応**。イントロスペクションの呼び出しは従来どおりクライアント認証（`client_secret_basic` / `client_secret_post`）のみで、リソースサーバーはクライアントとして登録します |

## ユースケース

- マイクロサービス間や TLS 終端が多段の構成で、イントロスペクション結果の改ざん耐性と出所検証を要件に持つ設計を PoC する
- FAPI 系・高保証 API を見据え、署名付きイントロスペクションの RS 側検証チェーン（JWKS 解決 → 署名検証 → `typ` 確認 → クレーム利用）を手元で確認する
- `typ` 検証を怠った RS 実装に対する cross-JWT confusion（イントロスペクション JWT のアクセストークンへの流用）が、どの検証で止まるかを再現する

## 前提条件

- 生成 OP を `--enable jwt-introspection-response` で作成していること（`introspection` 機能が必要です。`--disable introspection` との併用は生成時にエラーになります）
- リソースサーバーが JWS（RS256）を検証できること。`jwks_uri` から `kid` で鍵を引ける実装が必要です
- リソースサーバーがクライアントとして登録されていること（イントロスペクションの呼び出しにはクライアント認証が必要です）

## 有効化

```bash
maronn-oidc generate hono --enable jwt-introspection-response
pnpm add @maronn-openid-connect/core @maronn-openid-connect/experimental
```

`--enable jwt-introspection-response` を付けなかった場合、この機能に関するコードは一切生成されず、生成出力は機能が存在しなかった頃とバイト単位で同一です。

## 生成されるもの

| ファイル | 内容 |
|---|---|
| `routes/introspection.ts` | 応答構築後の `Accept` 判定と、JWT 応答への分岐（audience 制限 → RS256 鍵の選択 → 署名） |
| `routes/discovery.ts` | `introspection_signing_alg_values_supported: ['RS256']` の広告 |
| `conformance.test.ts` | RFC 9701 の契約テストの追加 |

新しいエンドポイント・画面・ストア契約はありません。
設定値もありません（署名 alg は RS256 固定、応答 JWT は `exp` を持たないため寿命設定も不要です）。

## フロー

```text
Resource Server（クライアントとして登録済み）        OP
  |-- POST /introspect ------------------------------->|
  |   Accept: application/token-introspection+jwt      | (1) クライアント認証（従来どおり）
  |   token=...                                        | (2) token 解決・active 判定（従来どおり）
  |                                                    | (3) Accept 判定: JWT 要求あり
  |                                                    | (4) audience 制限（下記）
  |                                                    | (5) token_introspection クレームに封入し
  |                                                    |     iss / aud / iat を付けて RS256 署名
  |<- 200 application/token-introspection+jwt ---------|
  |   <compact JWS>                                    |
  |
  |   RS 側の検証: jwks_uri から kid で鍵解決 → 署名検証
  |   → typ が token-introspection+jwt であること
  |   → iss が OP、aud が自分の client_id であること
  |   → token_introspection.active を確認して利用
```

応答 JWT のペイロードは次の形です。

```json
{
  "iss": "http://localhost:3000",
  "aud": "rs-client",
  "iat": 1787529600,
  "token_introspection": {
    "active": true,
    "scope": "openid",
    "client_id": "issued-to-client",
    "token_type": "Bearer",
    "sub": "testuser",
    "exp": 1787533200
  }
}
```

トップレベルに `sub` / `exp` は置きません（RFC 9701 §5 SHOULD NOT）。
これは応答 JWT がアクセストークンとして流用される余地（§8.1 の cross-JWT confusion）を構造的に減らすためで、RS 側でも `typ` の確認を必ず実装してください。

## audience 制限

JWT 応答の経路では、呼び出し元が次のどちらかに該当する場合だけトークンの属性を開示します（RFC 9701 §3 / §5）。

- 呼び出し元の client_id が、トークンの**発行先**（`client_id` メンバー）と一致する
- 呼び出し元の client_id が、トークンの **`aud` メンバー**（`audience` 値として発行されたもの）に含まれる

どちらにも該当しない呼び出し元には `"token_introspection": {"active": false}` を返します。
存在しないトークンへの応答と区別できないため、登録済みクライアントが他クライアント宛トークンの属性を収集する経路にはなりません。

この OP のアクセストークンの `aud` は既定で「UserInfo エンドポイント URL＋認可リクエストの `audience` パラメータ等で要求されたリソース値」で構成され、client_id は含まれません。
発行先以外のリソースサーバーへ JWT 応答で属性を開示したい場合は、**その RS の client_id を `audience` 値としてトークンに入れて発行してください**（クライアントが認可リクエストの `audience` パラメータで要求するか、Token Exchange の `allowedTargets` に載せます）。

**JSON 応答の経路にはこの制限を適用しません。**
`Accept` を指定しない従来のイントロスペクションは、登録クライアントの認証だけで従来どおりの応答を返します。
既存の呼び出し元の互換をこの機能が壊さないための線引きです。

## エラー処理

エラー応答（クライアント認証失敗・`token` 欠落・Content-Type 不正など）は、`Accept` の指定によらず従来どおり RFC 7662 の JSON で返ります。
RFC 9701 が JWT 化を定めているのはイントロスペクション応答本体だけです。

一点、仕様との相違があります。
RFC 9701 §5 は「準拠する AS は未認証のイントロスペクションリクエストを HTTP **400** で拒否しなければならない」としますが、この OP は RFC 7662 系の既存挙動（RFC 6749 §5.2 の `invalid_client`・HTTP **401**）を維持します。
この MUST の実質は「認証なしにトークンデータを開示しない」ことにあり、認証必須の既存パイプラインがそれを満たしています。
`Accept` ヘッダの値で認証エラーの形が変わる API は不自然なため、ステータスコードは変えていません。

## セキュリティ上の注意

- **`typ` の検証を省略しない**: RS 側で `typ: token-introspection+jwt` を確認しないと、この JWT を別用途の JWT と取り違える余地が残ります（RFC 9701 §8.1）
- **TLS は利用者責務**: 署名は改ざん検知と出所証明であり、盗聴対策ではありません。応答には `sub` などの PII が含まれるため、経路は TLS で保護してください（§8.2 / §9）。このライブラリは検証用であり、デプロイ時の TLS 構成は利用者の責任です
- **イントロスペクションの呼び出し自体が情報**: RS がいつ問い合わせたかは OP に伝わります（§9）。この構造的性質は JSON 応答でも同じです

## 既知の制約

- 署名 alg は RS256 固定です。クライアントごとの `introspection_signed_response_alg` 登録は解釈しません
- 応答 JWT の暗号化（JWE）には対応していません。属性の機密性は TLS で確保してください
- `Accept` の q 値・ワイルドカードによる選好解決は行いません。`*/*` や `application/*` は JWT 応答の要求と解釈せず、`application/token-introspection+jwt` をメディアタイプとして明示した場合だけ JWT で応答します（汎用 HTTP クライアントの既定 `Accept: */*` で応答形式が変わると RFC 7662 の後方互換が壊れるためです）
- 応答 JWT に `exp` はありません（§5 SHOULD NOT）。鮮度の判断は `iat` を基にした RS 側の責務です

## core 機能との違い

| | イントロスペクション（core） | 本機能 |
|---|---|---|
| 応答形式 | RFC 7662 JSON | `Accept` 明示時のみ署名付き JWT |
| 呼び出し元による開示制限 | なし（認証済みクライアントに応答） | JWT 経路のみ audience 制限 |
| 署名検証 | 不可 | JWKS の RS256 鍵で検証可能 |

UserInfo の署名付き応答（`userinfo_signed_response_alg`）と似ていますが、対象が異なります。
UserInfo はエンドユーザーのクレームをクライアントへ返す口で、本機能はトークンの状態をリソースサーバーへ返す口です。

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| JWT を要求したのに JSON が返る | `Accept` の値がメディアタイプとして完全一致していません。`application/token-introspection+jwt` を（q 値やワイルドカードではなく）そのまま指定してください。機能を有効にせず生成した OP も JSON のまま返します |
| `token_introspection` が `{"active": false}` になる | トークンが無効か、呼び出し元が発行先でも `aud` 記載先でもありません。第三者 RS へ開示するには、その RS の client_id を `audience` 値としてトークンを発行してください |
| 500 `server_error` が返る | 署名鍵セットに RS256 鍵がありません。`signingKeyProvider` の登録鍵セットに RS256 鍵を含めてください |
| 署名検証に失敗する | `jwks_uri` から `kid` で鍵を引けているか、検証アルゴリズムが RS256 かを確認してください |

## 参考資料

- [RFC 9701: JWT Response for OAuth Token Introspection](https://www.rfc-editor.org/rfc/rfc9701)
- [RFC 7662: OAuth 2.0 Token Introspection](https://www.rfc-editor.org/rfc/rfc7662)
- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)（`typ` による取り違え防止・`kid` による鍵解決）
