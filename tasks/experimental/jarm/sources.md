# 参照資料: JWT Secured Authorization Response Mode (JARM)

## Normative（規範的一次資料）

| タイトル | 発行元 | URL | 種別 | 参照セクション | 使用内容 | 確認日 | 仕様バージョン |
|---|---|---|---|---|---|---|---|
| JWT Secured Authorization Response Mode for OAuth 2.0 (JARM) | OpenID Foundation（Lodderstedt / Campbell） | https://openid.net/specs/oauth-v2-jarm-final.html | 標準仕様（Final） | §2.1（応答 JWT クレーム: iss/aud/exp、最大寿命 10 分 RECOMMENDED、成功・エラー実例）/ §2.2（署名 alg の決定はクライアントメタデータ基準）/ §2.3.1（query.jwt: `response` パラメータのみで運搬）/ §2.3.4（`jwt` 省略形: code のデフォルトは query.jwt）/ §2.4（クライアント処理規則: kid による鍵特定・`alg: none` 拒否 MUST）/ §3（`authorization_signed_response_alg` 未登録時デフォルト RS256）/ §4（AS メタデータ: `authorization_signing_alg_values_supported` / `response_modes_supported`）/ §5.1〜5.4（セキュリティ: DoS・完全性・mix-up・code 漏えい） | 応答 JWT の構造・response_mode 値・メタデータ・セキュリティ要件の全根拠 | 2026-08-02 | Final（2022-11-09） |
| OAuth 2.0 Multiple Response Type Encoding Practices | OpenID Foundation | https://openid.net/specs/oauth-v2-multiple-response-types-1_0.html | 標準仕様（Final） | §2.1（response_mode パラメータの定義）/ §2（code の応答は query） | `response_mode` パラメータそのものの定義。既存 discovery が `response_modes_supported: ['query']` を固定している根拠でもある | 2026-08-02 | 1.0 |
| The OAuth 2.0 Authorization Framework (RFC 6749) | IETF | https://datatracker.ietf.org/doc/html/rfc6749 | 標準仕様（RFC） | §4.1.2（認可レスポンス）/ §4.1.2.1（エラーレスポンス） | JWT クレームに詰め替える応答パラメータ（code / state / error 系）の原典 | 2026-08-02 | RFC 6749 |
| OpenID Connect Core 1.0 | OpenID Foundation | https://openid.net/specs/openid-connect-core-1_0.html | 標準仕様（Final） | §3.1.2.5（成功応答）/ §3.1.2.6（エラー応答）/ §6.1（Request Object の supersede 規則） | 応答パラメータの意味・Request Object 内 response_mode の優先規則 | 2026-08-02 | 1.0 (incorporating errata set 2) |
| JSON Web Signature (RFC 7515) / JSON Web Token (RFC 7519) | IETF | https://datatracker.ietf.org/doc/html/rfc7515 / https://datatracker.ietf.org/doc/html/rfc7519 | 標準仕様（RFC） | RFC 7515 §3（compact serialization）/ RFC 7519 §4.1（iss/aud/exp 登録クレーム） | 応答 JWT の生成形式（experimental 内の自前 JWS 実装の準拠先） | 2026-08-02 | RFC 7515 / 7519 |

## セキュリティガイダンス

| タイトル | 発行元 | URL | 種別 | 参照セクション | 使用内容 | 確認日 |
|---|---|---|---|---|---|---|
| Best Current Practice for OAuth 2.0 Security (RFC 9700) | IETF | https://datatracker.ietf.org/doc/html/rfc9700 | BCP | §2.1（issuer 識別の手段として JARM を明示: "or through OAuth 2.0 JARM responses"）/ §4.4（mix-up 攻撃: クライアントは対策 MUST。対策 1 = issuer 識別、対策 2 = OP ごとの distinct redirect URI） | JARM 採用理由（mix-up 対策としての位置付け）とセキュリティ要件の根拠 | 2026-08-02 |
| OAuth 2.0 Authorization Server Issuer Identification (RFC 9207) | IETF | https://datatracker.ietf.org/doc/html/rfc9207 | 標準仕様（RFC） | §2（iss パラメータ） | 平文応答での issuer 識別（既存実装）。JARM モードで素の `iss` パラメータを付けない設計判断の対比先 | 2026-08-02 |
| Proof Key for Code Exchange (RFC 7636) | IETF | https://datatracker.ietf.org/doc/html/rfc7636 | 標準仕様（RFC） | 全体 | JARM が防がない code リプレイ・漏えいの補完策（JARM §5.2 / §5.4 が参照） | 2026-08-02 |

## 相互運用性情報

- JARM は FAPI 1.0 Advanced（Part 2）および FAPI 2.0 Message Signing で採用されており、Auth0 / Keycloak / Authlete 等の主要実装が対応済み。相互運用実績は十分（実装状況の個別確認は実装 Routine のスコープ外とし、本リポジトリの結合テストは JARM Final の実例との突き合わせで担保する）
- JARM §2.1 の成功・エラー実例（iss / aud / exp / code / state 構造）を conformance テストの期待値として使用する

## リポジトリ内参照

| パス | 確認内容 | 確認日 |
|---|---|---|
| `packages/core/src/authorization-request.ts:853-888` | `rejectUnsupportedRequestParams` の拒否対象は request / request_uri / registration のみで、`response_mode` は解釈されず無視される（core 無変更で JARM を差し込める根拠） | 2026-08-02 |
| `packages/core/src/authorization-request.ts:105-132` | `ClientInfo` が closed interface で `authorization_signed_response_alg` を追加できない（RS256 固定・クライアント別 alg 非目標の根拠） | 2026-08-02 |
| `packages/core/src/auth-transaction.ts:96-141` | `AuthTransaction` interface と `AuthTransactionStore`（get/put/delete）。拡張フィールド `jarmResponseMode` の相乗り先と round-trip 契約の対象 | 2026-08-02 |
| `packages/core/src/signing-key.ts:4-26` | `SigningKey { privateKey, publicJwk, keyId }` / `SigningKeyProvider`。応答 JWT の署名鍵として再利用 | 2026-08-02 |
| `packages/core/src/index.ts:27,150,170,229-230` | `AuthorizationError` / `sanitizeErrorDescription` / `AuthTransaction` / `SigningKey(Provider)` が公開済み。低レベル署名ヘルパー（`sign` / `arrayBufferToBase64Url`）は非公開（JWS 自前実装の根拠） | 2026-08-02 |
| `packages/cli/src/features.ts:37` | `EXPERIMENTAL_FEATURES = ['par', 'token-exchange']`（jarm 追加先の機構） | 2026-08-02 |
| `packages/cli/src/frameworks/hono/templates.ts:1650-1660` | `effectiveParams` の束縛位置（request object マージ後。response_mode の読み出し元） | 2026-08-02 |
| `packages/cli/src/frameworks/hono/templates.ts:1829-1844, 2019-2103` | `buildErrorRedirect` ヘルパーと 8 呼び出しサイト（応答構築サイト棚卸し #1） | 2026-08-02 |
| `packages/cli/src/frameworks/hono/templates.ts:1940-1942` | `redirectUri` / `state` の確定位置（response_mode 検証の挿入点） | 2026-08-02 |
| `packages/cli/src/frameworks/hono/templates.ts:2133-2138, 2198-2203, 2225-2238, 3953-3961, 4012-4018` | 成功・エラーのインライン応答構築サイト（棚卸し #2〜#6） | 2026-08-02 |
| `packages/cli/src/frameworks/hono/templates.ts:3628-3641` | PAR の discovery スプレッドマージ実装（jarm のメタデータ追加が踏襲するパターン） | 2026-08-02 |
| `packages/cli/src/frameworks/hono/templates.ts:3683-3687` | discovery 設定の `responseModesSupported: ['query']` 固定値（jarm 有効時に差し替える箇所） | 2026-08-02 |
| `packages/core/src/discovery.ts:56, 104, 242-243` | `responseModesSupported` が core の既存 `DiscoveryConfig` フィールドであること（core 無変更で response_modes_supported を拡張できる根拠）。`authorization_signing_alg_values_supported` は存在しないためスプレッドマージで追加 | 2026-08-02 |
| `packages/cli/src/frameworks/hono/templates.ts:7757-7758` / `web-standard/templates.ts:1903-1904` | conformance テストテンプレートの `response_modes_supported: ['query']` 期待値（jarm 有効時に更新が必要な箇所） | 2026-08-02 |
| `packages/cli/src/frameworks/web-standard/templates.ts:2169-2185` | authorize / login / consent / discovery / conformance の全ルートが hono テンプレートを共有（テンプレート変更が単一ファイルに閉じる根拠） | 2026-08-02 |
| `tasks/experimental/done/par/` / `tasks/experimental/done/token-exchange/` | 前サイクルの候補評価（JARM 見送り理由）・条件付き補間・discovery マージ・「分岐内で独自に取得」方式の引き継ぎ | 2026-08-02 |
| `tasks/T-019-dpop.md` | 重複回避（DPoP は sender-constrained token で保護対象が異なる） | 2026-08-02 |
| `tasks/p2-signing-alg-ps256.md` | PS256 対応タスクとの連動（alg 拡張は昇格時に歩調を合わせる） | 2026-08-02 |

## 二次資料

なし（本仕様の根拠はすべて上記の一次資料とリポジトリ実装で確認した。ブログ記事等を根拠として使用していない）。

## 記録（一次資料とリポジトリの照合で確定した設計判断）

1. **`typ` ヘッダーを付けない**: JARM は応答 JWT の `typ` を規定せず、§2.3.1 の実例ヘッダーも `{"kid":"laeb","alg":"ES256"}` と `typ` なし。実例に忠実な形を採る（2026-08-02 原文確認）
2. **JARM モードで素の `iss` パラメータを付けない**: §2.3.1 の応答パラメータは `response` のみ。RFC 9207 の役割は JWT の `iss` クレームが担う（RFC 9700 §2.1 が JARM を issuer 識別手段として明示）
3. **`unsupported-jwt-mode` のエラーは平文クエリで返す**: JARM は「AS が対応しない response_mode を要求された場合」の応答形式を規定していない（2026-08-02 原文確認: 該当する規範文言なし）。対応できないモードでは応答を組めないため平文とする設計判断
4. **`.jwt` 系以外の response_mode 値は従来どおり無視する**: response_mode の一般的な拒否規則は JARM のスコープ外。挙動変更を JARM 系列に限定する隔離原則による設計判断
5. **署名 alg は RS256 固定**: `ClientInfo` closed interface（core 無変更制約）＋ JARM §3 の未登録時デフォルトが RS256 であることの両立点
