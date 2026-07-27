# レビューログ: Pushed Authorization Requests (PAR)

## Review 1

- **日付**: 2026-07-27（仕様作成日を Review 1 として実施）
- **観点**: 仕様の完全性（問題・スコープ・非目標の明確さ / 一次資料の読み違い / 公開API案の subpath export 実装可能性 / CLI統合の現実性 / 依存方向 / テスト定義 / 未解決事項の明示 / 理解資料の自立性）
- **確認資料**:
  - RFC 9126 本文（datatracker、規範的文言を直接引用で確認）
  - `packages/core/src/index.ts`（再利用 API の公開状況）
  - `packages/core/src/authorization-request.ts`（`request_uri` 拒否の現状実装）
  - `packages/core/src/crypto-utils.ts:65`（`generateRandomString` シグネチャ）
  - `packages/cli/src/features.ts` / `index.ts` / `generator.ts`（`--enable` 機構）
  - `packages/cli/src/frameworks/hono/templates.ts:1707` 付近（authorize ハンドラの構造と `${requestObjectStep}` 補間パターン）
  - `tasks/T-019-dpop.md`（重複回避）
- **指摘**:
  1. U1（`generateRandomString` のシグネチャ未確認）は仕様確定に不要な保留だった。crypto-utils.ts を確認すれば即解決できる
  2. 前段フックの挿入点が「現実に生成テンプレートへ挿入可能か」の根拠が薄かった。hono テンプレートには既に `${requestObjectStep}` という「パラメータを展開して `effectiveParams` を作る」補間ステップが存在し、PAR 展開はこれと同型のパターンで挿入できることを確認した
  3. 「認可エンドポイントの client_id と pushed レコードの一致検証」を RFC の MUST として書きかけたが、RFC 9126 に明示的 MUST 文言を確認できなかったため、設計判断であることを sources.md の「記録」に明記した（一次資料の読み違い防止）
  4. 認可エンドポイントのクエリに client_id / request_uri 以外のパラメータが混在した場合の挙動が RFC 未規定であることを確認し、「pushed パラメータを正とし他は無視」を本仕様の設計判断として明記した
- **修正**:
  - specification.md: U1 を解決済みに更新（`generateRandomString(32)` = 256bit を明記）、U3 を「hono 確認済み・残 4 テンプレート未確認」に絞り込み
  - sources.md: client_id 一致検証が設計判断である旨を「記録」に追加
- **残リスク**:
  - hono 以外の 4 テンプレートの挿入点未確認（U3）。仕様の成立自体は hono で確認済みのため完全性は満たすが、実装規模の見積り精度に影響
  - RFC 6749 / OIDC Core §3.1.2.6（`invalid_request_uri`）の原文再精読が未実施（sources.md に Review 2 実施と記録）
  - `requirePushedAuthorizationRequests` の初期スコープ判断が未確定（U5、Review 3 で判断）
- **判定**: **Pass with changes**（指摘 1〜4 を同日中に修正反映済み。仕様の完全性の観点で残る事項はすべて未解決事項表に明示されており、Review 2 の観点（セキュリティ・適合性）に引き継ぐ）
- **次回可能日**: 2026-07-28

## Review 2

（未実施。実施条件: 2026-07-28 以降 / Review 1 の残リスク項目の確認から開始する）

Review 2 で必ず確認する引き継ぎ事項:
1. hono 以外の 4 テンプレート（express/fastify/nextjs/web-standard）の authorize ハンドラ挿入点（U3）
2. OIDC Core §3.1.2.6 `invalid_request_uri` と RFC 6749 エラー形式の原文確認（sources.md 記録参照）
3. RFC 9700（Security BCP）の PAR 関連記述の確認
4. `invalid_request_uri` エラー時のリダイレクト可否判定と既存 redirectable エラー判定の整合（U4）
5. セキュリティ要件表の各対策がテストで検証可能な形になっているか

## Review 3

（未実施）
