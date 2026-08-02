# レビューログ: JWT Secured Authorization Response Mode (JARM)

## Review 1

- **日付**: 2026-08-02（仕様作成日を Review 1 として実施）
- **観点**: 仕様の完全性（問題・スコープ・非目標の明確さ / 一次資料の読み違い / 公開API案の subpath export 実装可能性 / CLI統合の現実性 / 依存方向 / テスト定義 / 未解決事項の明示 / 理解資料の自立性）
- **確認資料**:
  - JARM Final 原文（openid.net。§2.1 のクレーム構造・最大寿命 10 分 RECOMMENDED・成功/エラー実例、§2.3.1 の `response` 単一パラメータ運搬、§2.3.4 の `jwt` 省略形（code のデフォルトは query.jwt）、§2.4 の `alg: none` 拒否 MUST と kid、§3 の未登録時デフォルト RS256、§4 の AS メタデータ、§5.1〜5.4。実例ヘッダーに `typ` が無いことも確認）
  - RFC 9700 原文（datatracker。§2.1 の JARM への言及「or through OAuth 2.0 JARM responses」、§4.4 の mix-up 対策 MUST と 2 方式）
  - `packages/core/src/authorization-request.ts:853-888`（`rejectUnsupportedRequestParams` が response_mode を解釈しないこと = core 無変更の根拠）/ `:105-132`（`ClientInfo` closed = クライアント別 alg 非目標の根拠）
  - `packages/core/src/auth-transaction.ts:96-141`（`AuthTransaction` closed interface / store 契約 get・put・delete）
  - `packages/core/src/signing-key.ts:4-26`（`SigningKey` / `SigningKeyProvider` の形）
  - `packages/core/src/index.ts`（`AuthorizationError` :27 / `sanitizeErrorDescription` :150 / `AuthTransaction` :170 / `SigningKey(Provider)` :229-230 の公開確認。crypto-utils からの公開は `generateRandomString` / `extractAlgorithmParamsFromJwk` / `getJwaAlgorithm` のみで、低レベル署名ヘルパー `sign` / `arrayBufferToBase64Url` は非公開 → JWS 自前実装方針の根拠）
  - `packages/core/src/discovery.ts:56, 104, 242-243`（`responseModesSupported` が既存 `DiscoveryConfig` フィールドであること — 指摘 1）
  - `packages/cli/src/features.ts`（experimental 機構の現状: `EXPERIMENTAL_FEATURES = ['par', 'token-exchange']` :37）
  - `packages/cli/src/frameworks/hono/templates.ts`（`effectiveParams` 束縛 :1650-1660 / `redirectUri`・`state` 確定 :1940-1942 / `buildErrorRedirect` 定義 :1829-1844 と 8 呼び出しサイト :2019-2103 / インライン応答構築 :2133-2138, 2198-2203, 2225-2238, 3953-3961, 4012-4018 / discovery `responseModesSupported: ['query']` :3683-3687 / PAR discovery マージ :3628-3641 / conformance 期待値 :7757-7758）
  - `packages/cli/src/frameworks/web-standard/templates.ts:2169-2185`（全ルートの hono テンプレート共有）/ `:1903-1904`（conformance 期待値）
  - `tasks/experimental/done/par/` / `tasks/experimental/done/token-exchange/`（候補評価の引き継ぎ・条件付き補間/discovery マージ/分岐内取得パターンの実績）
  - `tasks/T-019-dpop.md` / `tasks/p2-signing-alg-ps256.md`（重複回避・alg 拡張タスクとの関係）
- **指摘**:
  1. **[生成コード整合・修正] discovery の `response_modes_supported` はスプレッドマージ不要**: 初稿は JARM の 2 メタデータをどちらも「PAR と同じスプレッドマージで追加」としていたが、`response_modes_supported` は core の既存設定フィールド `responseModesSupported`（`discovery.ts:56, 242-243`）から生成されており、テンプレートの固定値 `['query']`（`templates.ts:3687`）を jarm 有効時のみ差し替える方が既存機構に乗る。スプレッドマージが必要なのは core の `DiscoveryConfig` に無い `authorization_signing_alg_values_supported` のみ。CLI オプション案と sources.md を修正
  2. **[実地確認・仕様に反映済み] 応答構築サイトの棚卸しの完全性**: `grep "searchParams.set('error'\|searchParams.set('code'"` の全件が、仕様の棚卸し表（ヘルパー 1 + インライン 5）と一致することを確認（1837 / 2134 / 2199 / 2226 / 3954 / 4013。`buildErrorRedirect` の呼び出しは定義 1 + 8 サイトで、すべて `transaction` がスコープにある prompt=none 系）。内部リダイレクト（login / consent への遷移 :2212, 2220, 3879）は認可レスポンスではないため対象外であることも確認
  3. **[一次資料確認・初稿反映] `typ` ヘッダー・`iss` パラメータ・省略形 `jwt` の扱い**: (a) JARM は応答 JWT の `typ` を規定せず実例ヘッダーにも無い → 付けない設計を明記 (b) §2.3.1 の応答パラメータは `response` のみ → 素の `code` / `state` / `iss` を付けないことをテスト計画の固定検証に含めた (c) `jwt` 省略形は §2.3.4 で code のデフォルトが query.jwt → 同義扱いを仕様化
  4. **[スコープ判断・初稿反映] `.jwt` 系以外の response_mode を従来どおり無視する隔離原則**: 現行 OP は response_mode を全面無視しており、`form_post` 等の非 JWT 値への拒否を追加すると JARM のスコープ外の挙動変更になる。「`.jwt` 系のみ解釈追加・それ以外は現状維持」を非目標＋設計判断として明文化（黙って挙動を変えない）
  5. **[実装可能性確認・指摘なし] 公開 API 案の検証**: (a) subpath export は package.json への `exports["./jarm"]` 追加のみで PAR / token-exchange と同型 (b) `resolveJarmResponseMode` が例外でなく判別共用体を返す設計は、`invalid_request` が core の `AuthorizationErrorCode` に存在するため専用エラークラス不要という帰結と整合（PAR の `PushedRequestUriError` が必要だった理由との対比を仕様に明記済み） (c) 依存する core API はすべて公開済み。JWS 生成は低レベルヘルパー非公開のため experimental 内自前実装（重複許容方針と整合）
- **修正**（同日反映）:
  - specification.md: 指摘 1（CLI オプション案の discovery 記述を「既存 `responseModesSupported` 差し替え＋alg のみスプレッドマージ」へ修正）
  - sources.md: 指摘 1（`discovery.ts` 参照行の追加、discovery/conformance 参照の分離・行番号修正）
  - 指摘 2〜5 は初稿執筆中の実地確認として仕様に反映済み（棚卸し表・非目標・設計判断の記録）
- **残リスク**:
  - U1: `buildErrorRedirect` の 8 サイトすべてで `transaction` がスコープにあることは grep とサイト周辺の目視で確認したが、各サイトの put 前/put 後の別（JARM モードが transaction 保存前に確定しているか）の網羅確認は未実施（Review 2 でテンプレートを通読して確認）
  - U2: 応答 JWT 生成の async 化に伴う `buildErrorRedirect` 呼び出しサイトの `await` 追加を、jarm 無効時バイト同一と両立させる具体的な補間戦略が未確定（Review 2）
  - U3: E2E 専用クライアント（`tests/e2e/apps`)への JARM 検証組み込み方が未確認（Review 3)
  - 生成コードの実挙動（条件付き補間後の出力・バイト同一性）は実装時の完了条件 2・3 でのみ最終確認できる（仕様段階の限界として既知。PAR / Token Exchange と同じ扱い）
- **判定**: **Pass with changes**（指摘 1 を同日中に修正反映済み。仕様の完全性の観点で残る事項はすべて未解決事項表（U1〜U3）に明示されており、いずれもセキュリティ上の未解決事項ではない。Review 2 の観点（セキュリティ・適合性）へ引き継ぐ）
- **次回可能日**: 2026-08-03
