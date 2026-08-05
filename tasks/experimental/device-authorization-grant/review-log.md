# レビューログ: device-authorization-grant

## Review 1

- **日付**: 2026-08-05（仕様作成日と同日。運用ルール上 Review 1 として扱う）
- **観点**: 仕様の完全性（問題・スコープ・非目標の明確さ / 一次資料の読み違い / 公開 API 案が subpath export で実装可能か / CLI 統合の現実性 / 依存方向 / テスト定義 / 未解決事項の明示 / 理解資料の自立性）
- **確認資料**:
  - RFC 8628 全文（datatracker、2026-08-05 取得）— §3.1〜3.5 の必須/任意フィールド、エラーコード 4 種、slow_down の +5 秒規則、interval 既定 5 秒、§4 メタデータ名、§6.1 base-20 文字種を仕様書の記載と突き合わせ、読み違いなしを確認
  - `packages/cli/src/frameworks/hono/templates.ts`（tokenExchangeDispatchStep 3106-3216 / loginRouteTemplate 4183-4375 / parStore・views 契約）— 分岐位置・セッション確立手順・store レジストリパターンが実在の構造と一致することを確認
  - `packages/cli/src/frameworks/web-standard/templates.ts` — hono テンプレート変換共有により 4 フレームワークへ展開できることを確認
  - `packages/experimental/package.json` — subpath exports 追加が既存 3 機能と同型で成立することを確認
  - `packages/core/src/authorization-request.ts`（validateAuthorizationScope）— scope/openid 必須プロファイルの根拠を確認
  - `tasks/experimental/done/jarm/specification.md` — 前サイクルが本機能を次サイクル有力候補と明記していることを確認
- **指摘**:
  1. `/device/login` に CSRF 保護が定義されていなかった。フォージされたログイン POST が被害者ブラウザに攻撃者の OP セッションを確立し得る（ログイン CSRF）。既存 login ルートはトランザクション CSRF トークンで同種の防御を持っており、水準が揃っていない
  2. user_code の衝突（pending レコード間の一意性）時の挙動が未定義で、`findByUserCode` の契約が曖昧になる
  3. `GET /device` の user_code 事前入力はクエリ値を HTML に埋め込むため、エスケープ要件が明記されていなかった
- **修正**:
  1. CSRF トークンの発行タイミングを「user_code 照合成功時」に前倒しし、`/device/login` と `/device/approve` の両 POST で照合必須に変更。公開 API に `validateVerificationCsrfToken` を追加し、ストア契約コメント・バリデーション表・セキュリティ要件を整合させた
  2. user_code 生成時に `findByUserCode` で衝突確認し再生成（上限 5 回）する規則を明記
  3. views の既存エスケープ規則に従う旨を検証 UI の表に明記
- **残リスク**:
  - user_code 照合のタイミング差（ストア検索由来）は実在コード推測にわずかに使える可能性が残るが、エントロピー × TTL を主防御とする設計判断としてセキュリティ要件に明記済み。Review 2 で再評価する
  - アプリ内グローバルレート制限を持たない判断（デプロイ基盤責務への切り出し）は Review 2 のセキュリティ観点で再確認する
- **判定**: Pass with changes（指摘 3 件はすべて同日修正済み）
- **次回可能日**: 2026-08-06（Review 2: セキュリティと適合性）
