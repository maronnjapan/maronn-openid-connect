# レビューログ: OAuth 2.0 Token Exchange

## Review 1

- **日付**: 2026-07-30（仕様作成日を Review 1 として実施）
- **観点**: 仕様の完全性（問題・スコープ・非目標の明確さ / 一次資料の読み違い / 公開API案の subpath export 実装可能性 / CLI統合の現実性 / 依存方向 / テスト定義 / 未解決事項の明示 / 理解資料の自立性）
- **確認資料**:
  - RFC 8693 本文（datatracker、§1.1 / §2.1 / §2.2.1 / §2.2.2 / §3 / §4 / §5 の規範的文言を直接確認）
  - `packages/core/src/token-request.ts`（`validateGrantTypeSupported` の未知 grant_type 拒否 / `TokenClientInfo` の契約）
  - `packages/core/src/token-error.ts:7-49`（`TokenErrorCode` closed enum / `TokenError` の sanitize・statusCode 実装）
  - `packages/core/src/userinfo.ts:52-83, 423-436`（`AccessTokenInfo` / `validateUserInfoAudience`）
  - `packages/core/src/access-token-issuer.ts:26-57` / `packages/core/src/token-response.ts:169-206`（issuer 契約 / `buildAccessTokenAudience` の合成規則）
  - `packages/core/src/index.ts`（依存 core API の公開状況）
  - `packages/cli/src/features.ts`（PAR で確立済みの experimental 機構）
  - `packages/cli/src/frameworks/hono/templates.ts`（`tokenRouteTemplate` 全体: 重複パラメータ拒否 :2752-2775 / 認証パイプライン終端 :2818 / `${grantTypeSupportedStep}` :2825 / config・privateKey 束縛 :2831-2833 / accessTokenIssuer 束縛 :2905-2908 / 発行・保存 :2938-3045 / catch 節 :3048-3066 / discovery `grantTypesSupported` :3415-3418 / response_mode query 固定 :7027-7028）
  - `packages/cli/src/frameworks/web-standard/templates.ts:2163`（token ルートの全ターゲット共有）
  - `tasks/experimental/done/par/`（前サイクルの候補評価・レビュー指摘・実装記録の引き継ぎ）
  - `tasks/T-019-dpop.md`（重複回避）
- **指摘**:
  1. **[生成コード整合・重要・修正] 発行トークンの aud 合成が既存ポリシーと不整合**: 初版は「検証済みの要求対象（または subject 継承値）をそのまま発行トークンの aud にする」形だった。しかし既存トークンルートは core の `buildAccessTokenAudience` で **UserInfo エンドポイントを aud の恒久メンバとして必ず含める**合成を行っており（RFC 9068 §3 の非空要件と「トークンは常に UserInfo で使える」ポリシー）、UserInfo ルートの `validateUserInfoAudience` は aud に UserInfo エンドポイントが含まれることを要求する。初版のままでは本仕様自身のテスト計画「交換後トークンで UserInfo が成功する」が必ず失敗する。`resolveExchangeTarget` の戻り値を「`buildAccessTokenAudience` の `requested` 入力」と再定義し、最終 aud 合成を既存と同じ core 関数へ委譲する形へ修正（`TokenExchangeGrant.audience` → `requestedAudience` へ改名）
  2. **[U2 解決] 分岐内で参照する束縛の宣言位置**: `config` / `privateKey` / `keyId`（`templates.ts:2831-2833`）と `accessTokenIssuer`（`:2905-2908`）はいずれも分岐挿入点（`:2818` 直後）より後で宣言されることを確認。既存宣言の移動はバイト同一検証を複雑にするため行わず、**分岐ブロック内で独自に取得する**方式に確定（分岐は `return` で完結するため二重実行にならない）。スケッチと実装順序へ反映し、U2 を解決済みへ移動
  3. **[一次資料との衝突検出・初稿反映] `resource` / `audience` の複数指定**: RFC 8693 §2.1 は同名パラメータの複数出現を許容するが、生成トークンエンドポイントは RFC 6749 §3.2 に基づき全パラメータの重複を 400 で拒否する（`templates.ts:2752-2775`）。単一値限定を「RFC 8693 が許容する形への意図的な非対応」として非目標・理解資料・sources の記録に明示した（黙って制限しない）
  4. **[一次資料確認・初稿反映] invalid な subject_token のエラーコード**: RFC 8693 §2.2.2 は invalid なトークンに `invalid_request` を指定しており、authorization_code / refresh_token の感覚で `invalid_grant` を使うのは誤り。エラー表に「`invalid_grant` ではない点に注意」と明記し、理解資料の「誤解しやすい点」にも掲載
  5. **[軽微・修正] スケッチの表記**: `buildAccessTokenAudience` 呼び出し例に、テンプレート文字列内でのみ必要なエスケープ（`\`` / `\${`）が markdown コードブロックへ混入していたのを修正
- **修正**（同日反映）:
  - specification.md: 指摘 1（入出力・公開API・バリデーション 10・スケッチ・依存 API 一覧に `buildAccessTokenAudience` 追加）/ 指摘 2（スケッチの分岐内取得・実装順序・U2 解決済み移動）/ 指摘 5
  - understanding-guide.md: データ構造表の audience 行と「誤解しやすい点」4 を aud 合成規則込みの記述へ更新
  - sources.md: `token-response.ts:169-206` / `userinfo.ts:423-436` の参照を追加、「記録」の設計判断に aud 合成の委譲を追加
- **残リスク**:
  - U1: RFC 9700 の Token Exchange 言及有無が未確認（Review 2 で原文確認。確認前は根拠として引用していない）
  - U3: E2E 専用クライアントへの交換呼び出しの組み込み方（`tests/e2e/apps` の構造確認。Review 3）
  - conformance.test.ts テンプレートの具体的な挿入関数の特定は未実施だが、PAR が同機構で追加済みのため実現性リスクは低い（Review 2 で確認）
  - 生成コードの実挙動（条件付き補間後の出力・バイト同一性）は実装時の完了条件 2・3 でのみ最終確認できる（仕様段階の限界として既知）
- **判定**: **Pass with changes**（指摘 1〜5 を同日中に修正反映済み。指摘 1 は放置すれば実装時に conformance テストで必ず露見する整合性欠陥だが、仕様段階で潰せたため Blocked には該当しない。仕様の完全性の観点で残る事項はすべて未解決事項表に明示されており、Review 2 の観点（セキュリティ・適合性）に引き継ぐ）
- **次回可能日**: 2026-07-31
