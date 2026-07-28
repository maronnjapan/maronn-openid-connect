# 参照資料: Pushed Authorization Requests (PAR)

## Normative（規範的一次資料）

| タイトル | 発行元 | URL | 種別 | 参照セクション | 使用内容 | 確認日 | 仕様バージョン |
|---|---|---|---|---|---|---|---|
| RFC 9126: OAuth 2.0 Pushed Authorization Requests | IETF | https://datatracker.ietf.org/doc/html/rfc9126 | RFC (Proposed Standard) | §2.1, §2.2, §2.3, §4, §5, §6, §7.1〜7.5 | エンドポイント入出力・201 MUST・URN 形式・エントロピー MUST・単回使用 SHOULD・メタデータ・脅威モデル。本文の規範的文言を直接確認済み | 2026-07-27 | RFC 9126 (2021-09) |
| RFC 6749: The OAuth 2.0 Authorization Framework | IETF | https://datatracker.ietf.org/doc/html/rfc6749 | RFC | §2.3, §3.2.1, §5.2 | PAR エンドポイントのクライアント認証規則（token endpoint と同一）とエラーレスポンス形式の参照元 | 2026-07-27（RFC 9126 経由の参照関係として確認。本文の再精読は Review 2 で実施） | RFC 6749 (2012-10) |
| OpenID Connect Core 1.0 | OpenID Foundation | https://openid.net/specs/openid-connect-core-1_0.html | OIDF Final Spec | §3.1.2.6, §6.2, §6.3 | `invalid_request_uri` エラーコードの定義、URL 形式 request_uri（非対応継続）の位置付け | 2026-07-27（リポジトリ内の既存実装・コメントの参照と併せて確認。§3.1.2.6 の原文再確認は Review 2 で実施） | 1.0 (incorporating errata set 2) |

## Informative（参考一次資料）

| タイトル | 発行元 | URL | 種別 | 参照セクション | 使用内容 | 確認日 | 仕様バージョン |
|---|---|---|---|---|---|---|---|
| RFC 9101: JWT-Secured Authorization Request (JAR) | IETF | https://datatracker.ietf.org/doc/html/rfc9101 | RFC | §10.2(d) | request_uri エントロピー要件の参照先（RFC 9126 §7.1 が参照）。PAR+JAR 併用は非目標のため詳細参照は昇格時 | 未精読（RFC 9126 内の引用のみ確認） | RFC 9101 (2021-08) |
| OAuth 2.0 Security Best Current Practice (RFC 9700) | IETF | https://datatracker.ietf.org/doc/html/rfc9700 | BCP | - | PAR 推奨の背景（採用理由の裏付け）。規範根拠には使用していない | 未精読（存在と位置付けのみ。Review 2 で PAR 関連記述を確認する） | RFC 9700 (2025-01) |
| FAPI 2.0 Security Profile | OpenID Foundation | https://openid.net/specs/fapi-security-profile-2_0-final.html | OIDF Final Spec | - | PAR 必須化の背景（採用理由・昇格判断の裏付け）。規範根拠には使用していない | 未精読 | 2.0 Final |
| RFC 8414: OAuth 2.0 Authorization Server Metadata | IETF | https://datatracker.ietf.org/doc/html/rfc8414 | RFC | - | `pushed_authorization_request_endpoint` 等のメタデータ登録先の枠組み | 未精読（RFC 9126 §5 経由） | RFC 8414 (2018-06) |

## リポジトリ内参照

| パス | 使用内容 | 確認日 |
|---|---|---|
| `packages/core/src/index.ts` | 再利用する公開 API（`authenticateClient`, `validateAuthorizationRequest`, `generateRandomString`, `ClientResolver`, `ValidateAuthorizationRequestOptions` 等）の公開状況 | 2026-07-27 |
| `packages/core/src/authorization-request.ts` (L36-76, L846-880) | `request_uri` が `request_uri_not_supported` で拒否される現状実装。前段フック設計の前提 | 2026-07-27 |
| `packages/core/src/discovery.ts` (L107, L252) | `request_uri_parameter_supported` の設定駆動と、メタデータへの追加フィールドマージ方針の判断材料 | 2026-07-27 |
| `packages/cli/src/features.ts` | `--enable/--disable` 機構と `AVAILABLE_FEATURES`。experimental カテゴリ追加の設計前提 | 2026-07-27 |
| `packages/cli/src/index.ts` / `generator.ts` | CLI オプション解釈と generator パイプライン | 2026-07-27 |
| `packages/cli/src/frameworks/hono/templates.ts` (L1707, L2096-2097 付近) | authorize ルートの構造（前段フック挿入点の候補）。詳細精読は Review 2（U3） | 2026-07-27 |
| `tasks/T-019-dpop.md` | 既存タスクとの重複回避の確認（DPoP とは独立） | 2026-07-27 |
| `packages/experimental/README.md` | experimental パッケージの現状（README のみ、package.json 未作成） | 2026-07-27 |
| `CLAUDE.md` | テスト規約・conformance.test.ts の契約テスト方針・依存ポリシー | 2026-07-27 |

## 二次資料

なし（仕様の確定に二次資料・ブログ記事は使用していない）。

## 記録

- RFC 9126 の規範的文言（201 MUST / request_uri in body MUST NOT / エントロピー MUST / 単回使用 SHOULD＋クライアント側 MUST / 有効期限「typically 5〜600秒」/ PAR時検証の MAY省略＋authorize時 MUST 検証）は 2026-07-27 に datatracker 本文から直接引用で確認した。
- 「認可エンドポイントの client_id と pushed レコードの client_id 一致検証」は RFC 9126 に明示的な MUST 文言としては確認できていない（§7.3 リプレイ対策・OIDC Core の client_id 必須要件からの設計判断）。仕様書ではこれを本実装の要件として明記した。Review 2 で RFC 本文を再確認し、規範根拠か設計判断かの区別を最終化する。
