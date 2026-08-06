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

## Review 2

- **日付**: 2026-08-06
- **観点**: セキュリティと適合性（認証認可上の脅威 / 鍵・トークン・シークレットの扱い / ログ禁止情報 / 有効期限 / エラー情報の露出 / package 境界 / CLI 後方互換 / 明示的有効化 / 生成コードの安全性 / セキュリティ要件のテスト検証可能性）。Review 1 と重複する完全性確認は繰り返さず、Review 1 の修正内容（CSRF）と残リスク 2 件の再評価を中心に据えた
- **確認資料**:
  - `packages/cli/src/frameworks/hono/templates.ts:527-600`（transaction-binding Cookie ヘルパーと設計コメント）、同 4234 行・4429 行付近（csrf_token 埋め込み前のバインディング検査）、同 6363-6372 行（「binding cookie 無しでは csrf_token を露出しない」contract テスト）— 既存リポジトリが「識別子を知る第三者が csrf_token を読める」問題をどう解いているかの確認
  - `packages/core/src/auth-transaction.ts`（`computeTransactionBindingHash` / `validateTransactionBinding` が core 公開 API であること）
  - `packages/cli/src/features.ts`（transaction-binding が optional・既定オフである理由のコメント / EXPERIMENTAL_FEATURES の追加位置 / DEFAULT_FEATURES の既定オフ機構）
  - `packages/experimental/package.json`（subpath exports の現況。既存 3 機能と同型で追加可能なこと・package.json が既に存在すること）
  - `packages/experimental/src/par/store.ts`（atomic consume・キーのパラメータ化注意書きの書式）
  - セッション Cookie / トランザクション Cookie の属性（HttpOnly / Secure / SameSite=Lax）の実装値
  - `tasks/p2-login-attempt-throttling-subject-scope.md` / `tasks/p3-csrf-token-constant-time-comparison.md`（未着手の関連セキュリティタスク）
  - RFC 8628 §5.1〜§5.7（脅威対策の再照合）
- **指摘**:
  1. **（重大）Review 1 で導入したレコード紐付き CSRF トークンは、主要脅威に対して無効**。device フローでは攻撃者がフロー開始者として user_code を必ず知っており、`POST /device` を自分で叩けば有効な csrf_token を取得できる。したがって (a) 被害者ブラウザへの `POST /device/approve` フォージ（承認強要 → 攻撃者デバイスへのトークン流出）も (b) `POST /device/login` フォージ（ログイン CSRF。Review 1 がまさに防ごうとした脅威）も、トークンでは防げない。残る防御はセッション Cookie の SameSite=Lax のみで、(b) はセッション Cookie を必要としないため SameSite でも防げない。既存 transaction-binding の設計コメント（templates.ts:534-542）が指摘する「CSRF 防御が識別子の秘匿に還元されてしまう」問題そのものであり、authorize フローでは transaction_id が通常秘匿されるため opt-in ハードニングで足りるが、device フローでは識別子（user_code）が設計上攻撃者に既知のため、ブラウザバインディングが唯一実効的な CSRF 防御になる
  2. **（中）`/device/login` 経由の資格情報総当たりの集計上限が無い**ことが仕様に明記されていなかった。レコード単位 maxLoginAttempts=5 はあるが、攻撃者はレコードを無制限に発行できる。既存 `/login` と同一の残存面（未着手タスク p2-login-attempt-throttling-subject-scope の責務）だが、仕様が無言だと「対策済み」に読める
  3. **（小）CSRF 照合の比較方法が未規定**。既存タスク p3-csrf-token-constant-time-comparison が login / consent の `validateCsrfToken` を対象にしており、本機能の照合の水準と関係を明記すべき
  4. **（小）ポーリングを止めたデバイスの期限切れレコードが削除経路を持たない**（削除はポーリング時のみ）。ストア実装の掃除方針が未規定で、掃除すると `expired_token` でなく `invalid_grant` になる相互作用も未記載
- **修正**（すべて同日反映）:
  1. ブラウザバインディングを常時有効の必須要件として導入: `POST /device` 照合成功時に bindingSecret を発行し、生値を `oidc_device_<正規化user_code>` Cookie（HttpOnly / Secure / SameSite=Lax / Max-Age=残TTL）で、SHA-256 ハッシュのみをレコード（`bindingHash`）で保持。`/device/login` `/device/approve` は Cookie 照合を前提条件とし、完了時に Cookie を削除。公開 API を `issueVerificationBinding`（bindingSecret + csrfToken のペア発行・回転）/ `validateVerificationBinding` に再構成し、csrf_token は多層防御として維持。フロー図・バリデーション表・テスト計画（Set-Cookie 属性固定・Cookie 無し 403・回転・削除の conformance 検証、binding の単体テスト）・完了条件（条件 8 追加）・curl 手順（cookie jar）・理解資料（脅威 4 節と誤解 2 項を追加）を整合させた。transaction-binding が opt-in なのに対し常時有効とする理由（識別子の秘匿に頼れない）も仕様・理解資料の両方に明記
  2. セキュリティ要件に資格情報総当たりの残存面を明記し、p2-login-attempt-throttling-subject-scope 実装時に `/device/login` を対象へ含めることを本仕様の要件として記載
  3. バインディング照合はハッシュ対ハッシュ比較でタイミング攻撃が成立しないこと、csrf_token 直接比較は既存水準に揃え p3 タスクの適用範囲に含めることを明記
  4. ストア契約に期限切れレコードの自主破棄（TTL 相当の猶予後）と、破棄後ポーリングが `invalid_grant` になっても相互運用上問題ない根拠を明記
- **Review 1 残リスクの再評価**:
  - user_code 照合のタイミング差: エントロピー（20^8）× TTL（600 秒）を主防御とする設計判断を維持。タイミング差で得られるのは user_code の実在性のみで、実在を知っても承認操作には至れない（バインディング導入後は承認画面到達に Cookie 発行が伴い観測可能）。判断変更なし
  - アプリ内グローバルレート制限を持たない判断: RFC 8628 §5.1 の対策 3 点（エントロピー・TTL・レート制限）のうちレート制限をデプロイ基盤責務へ切り出す判断を維持。Cloudflare Workers 等でアプリ内カウンタが成立しない根拠は妥当。生成コードコメント・理解資料への明示は仕様済み
- **適合性の確認**: エラーコード・応答フィールドは RFC 8628 登録値のみ / 明示的有効化（既定オフ・DEFAULT_FEATURES 機構）と feature 無効時の不変性テストが定義済み / 依存方向は package 境界規約と一致 / experimental 機能間のコード共有なし（バインディングのハッシュは core 公開 API または機能内実装で賄う方針も規約適合）/ ログ禁止情報に bindingSecret を追加
- **残リスク**:
  - リモートフィッシング（§5.4）はプロトコル上完全には防げない（承認画面での user_code 再表示 + 短 TTL の緩和のみ）。RFC 自身が認める限界であり、理解資料に記載済み
  - 資格情報総当たりの集計上限は p2-login-attempt-throttling-subject-scope 実装まで既存 `/login` と同水準のまま（本機能で悪化はしない）
- **判定**: Pass with changes（指摘 4 件はすべて同日修正済み。Blocked 相当の未解決セキュリティ事項なし）
- **次回可能日**: 2026-08-07（Review 3: 実装着手可否）
