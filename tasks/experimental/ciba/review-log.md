# レビューログ: CIBA (Client-Initiated Backchannel Authentication) Poll Mode

## Review 1

- **日付**: 2026-08-08（仕様作成日を Review 1 として実施）
- **観点**: 仕様の完全性（問題・スコープ・非目標の明確さ / 一次資料の読み違い / 公開API案の subpath export 実装可能性 / CLI統合の現実性 / 依存方向 / テスト定義 / 未解決事項の明示 / 理解資料の自立性）
- **確認資料**:
  - CIBA Core 1.0 本文（openid.net、§4 / §7.1〜§7.3 / §10.1 / §10.3.1 / §11 / §13 / §14 / §15 の規範的文言と目次構成を直接確認）
  - `tasks/experimental/done/device-authorization-grant/`（先例パケット。CIBA を次サイクル候補として残した候補評価の記録）
  - `packages/experimental/src/device-authorization-grant/store.ts`（ストア契約の書式・consume atomic 要件）
  - `packages/cli/src/frameworks/hono/templates.ts:4002` 付近（deviceCodeDispatchStep）/ `:4119`（catch 分岐）/ `:5003`（discovery 追記）/ `:3405`（`authenticateUser` swap point）
  - `packages/core/src/token-request.ts:63-85`（`TokenClientInfo` の `grantTypes` / `tokenEndpointAuthMethod` フィールド）/ `:464`（grantTypes 既定値）
  - `packages/core/src/crypto-utils.ts:65`（`generateRandomString` の Base64URL 出力）
  - `packages/core/src/id-token.ts:276` / 365-372（`validateIdTokenHint` の exp 拒否）
  - `packages/cli/src/features.ts`（`EXPERIMENTAL_FEATURES` / `OidcFeatureConfig` の拡張箇所）
  - `tasks/T-019-dpop.md`（重複回避）
- **指摘**:
  1. **[一次資料の読み違い・修正] セクション番号の誤引用**: user_code の脅威モデルを「§12.2」と引用していたが、目次確認の結果、user_code の定義は §7.1.2、Security Considerations は §14、Privacy Considerations は §15 が正しい。仕様書・理解資料・sources.md の 3 箇所を修正
  2. **[表記・修正] 非目標の署名リクエスト項の行末に表組みの `|` が混入**していた（Markdown 崩れ）。除去
  3. **[完全性・修正] バックチャネル側エラー表の `access_denied` 403 行が「使用しない」とだけ書かれ根拠が無かった**: CIBA §13 は認証エンドポイントでの即時拒否用に定義するが、Poll モードの本 OP は受理後にユーザー判断を待つ設計のため拒否は常にトークン側 `access_denied` で配信される。この理由を表内に明記
  4. **[完全性・修正] `lastPolledAt` の更新タイミングが状態機械に未記載**だった（slow_down 応答時にも更新するのか読み取れない）。「結果によらず全ポーリング試行で更新」を明記
  5. **[実装可能性・確認] 公開クライアント拒否の実装根拠**: `TokenClientInfo.tokenEndpointAuthMethod`（`'none'` を含む）が core 公開型に存在することを確認（`token-request.ts:84`）。`processBackchannelAuthenticationRequest` が core 無変更で auth method `none` を判定できる
  6. **[スコープ判断・記録] `id_token_hint` を初期スコープから外す根拠の確認**: core の `validateIdTokenHint` は exp 切れを拒否する（`id-token.ts:365-372`）。CIBA の再認証ユースケース（期限切れ ID トークンをヒントに使う）とは相容れず、exp 緩和は core 変更を要するため、login_hint 限定は妥当。非対応ヒント単独提示時のエラーコード（`invalid_request` vs `unknown_user_id`）は §13 の両定義を読み比べ、ヒント種別自体の非対応は malformed 系として `invalid_request` を採る設計判断を sources.md「記録」に明記
  7. **[CLI統合の現実性・確認] 全生成物が実証済みパターンに載ることの確認**: バックチャネルエンドポイント（PAR / device_authorization 先例）・grant ディスパッチ（tokenExchange / deviceCode 先例）・承認 UI（/device 先例）・discovery 追記（device 先例）。テンプレート実体は hono 1 系統で web-standard 変換により全フレームワークへ展開される構造も device で確認済み
- **修正**: 指摘 1〜4 を同日中に反映（specification.md / understanding-guide.md / sources.md）
- **残リスク**:
  - U1（UI ログイン部品の共通化 or 複製）・U2（保留数超過時のエラーコード）・U3（denied レコードの削除タイミングと Device Grant 実装の整合）・U4（`backchannelTokenDeliveryMode` の型の載せ方）が未解決事項表に残る。いずれも仕様の成立を妨げない
  - `slow_down` 方式（過剰ポーリングへ invalid_request を返さない）は §11 の MAY を採らない設計判断であり、相互運用上の問題は無いが Review 2 でセキュリティ観点（ポーリング DoS）から再確認する
  - 未承諾リクエスト対策を user_code なしで UI 設計 + 保留数上限に寄せた受容コスト（正規クライアント侵害時はユーザーの拒否に依存）の妥当性は Review 2 の主要確認事項
- **判定**: **Pass with changes**（指摘 1〜4 を同日中に修正反映済み。仕様の完全性の観点で残る事項はすべて未解決事項表に明示されており、Review 2 の観点（セキュリティ・適合性）に引き継ぐ）
- **次回可能日**: 2026-08-09
