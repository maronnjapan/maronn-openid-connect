# Experimental機能仕様書: Pushed Authorization Requests (PAR)

- **機能名**: Pushed Authorization Requests (PAR)
- **feature-id**: `par`
- **準拠仕様**: RFC 9126 - OAuth 2.0 Pushed Authorization Requests
- **作成日**: 2026-07-27
- **ステータス**: `state.yaml` を参照

## 概要

認可リクエストのパラメータ一式を、フロントチャネル（ブラウザのクエリ文字列）ではなく、事前にバックチャネルの専用エンドポイント（PARエンドポイント）へ HTTP POST で送信し、引き換えに短命な参照値 `request_uri`（`urn:ietf:params:oauth:request_uri:<reference>`）を受け取る仕組み。クライアントは認可エンドポイントへは `client_id` と `request_uri` のみを渡す。

これにより以下が実現される:

- 認可リクエスト内容がブラウザ経由で露出・改竄されない（完全性・機密性）
- ユーザー操作より前にクライアント認証が行われる（confidential client の場合）
- URLサイズ制限を受けずに大きな認可リクエスト（`claims` パラメータ等）を送れる

## 採用理由（候補評価）

対象候補として CIBA / PAR / RAR / JARM / Device Authorization Grant / Token Exchange を検討し、以下の理由で PAR を選定した。

| 観点 | 評価 |
|---|---|
| プロジェクト関連性 | FAPI 2.0 Security Profile のベースライン必須機能。OAuth 2.0 Security BCP（RFC 9700）§4.1.3 も、クライアント認証を伴う PAR を「認可リクエストの出所と完全性を検証できる手段」として挙げている（Review 2 で原文確認。RFC 9700 に PAR の一般的な使用推奨の規範文言はない）。既存の `request-object`（JAR by value）機能と直接補完関係にあり、「最新仕様を最速で検証できる」というコンセプトに合致 |
| Experimental隔離の妥当性 | 新規エンドポイント＋認可エンドポイント前段の参照解決のみで構成でき、既存フローのデフォルト挙動を一切変えない |
| core無変更 | 可能。core は `request_uri` を `request_uri_not_supported` で拒否するが（`packages/core/src/authorization-request.ts:871`）、experimental 層が core 検証より**前に** URN を実パラメータへ展開し `request_uri` を除去してから core に渡すため、core の変更が不要 |
| CLI `--enable` 提供 | 可能。既存の `--enable/--disable` 機構（`packages/cli/src/features.ts`）に experimental 機能カテゴリを追加する |
| 一次資料の成熟度 | RFC 9126 は 2021年発行の Proposed Standard。主要 IdP（Auth0, Keycloak, Authlete 等）で実装済みで相互運用実績が豊富 |
| セキュリティ影響 | 追加されるのはバックチャネルエンドポイント1つ。外部URLフェッチを行わないため JAR の `request_uri` にある SSRF 懸念が構造的に存在しない。攻撃面の増加が小さい |
| テスト可能性 | 単体・結合（conformance.test.ts）・E2E（Playwright）すべてで HTTP レベルの検証が可能 |
| 実装規模 | 中規模。core のステップ関数を再利用でき、新規ロジックは「保存・参照解決・単回使用制御」に集中する |
| 将来の昇格 | `request_uri` 対応が core の discovery 設定（`request_uri_parameter_supported`）と自然に接続でき、昇格パスが明確 |
| 既存機能との重複 | なし。`request-object`（by value）とは相互補完。`tasks/T-019-dpop.md`（DPoP）とも独立 |

CIBA・Device Authorization Grant はユーザー対話用の追加 UI（検証ページ・ポーリング）が必要でテンプレート変更面積が大きく、RAR は authorize/token/introspection の複数層に跨がるため隔離性が劣る。Token Exchange・JARM は次サイクル以降の候補として残す。

## Experimentalにする理由

- 認可エンドポイントの入口（`request_uri` の解釈）に手を入れるため、生成コードの前段フックとして安定するまで隔離したい
- 単回使用制御・有効期限管理のためのストア契約が新規であり、resolver/store 契約の設計を実運用フィードバックで固めたい
- `require_pushed_authorization_requests`（PAR強制モード）の適用範囲（グローバル/クライアント単位）の設計判断を実装後の利用感で見直す余地を残したい

## 非目標（Non-goals）

- **PAR ボディ内の `request` パラメータ（JAR との併用, RFC 9126 §3）**: RFC 上は MAY。初期スコープでは PAR ボディに `request` が含まれる場合 `invalid_request` で拒否する。既存 `request-object` 機能との合成は将来拡張として `将来の昇格考慮` に記録
- **クライアント単位の `require_pushed_authorization_requests`（RFC 9126 §6 client metadata）**: 初期はグローバル設定のみ。`ClientInfo` 拡張は core 変更を伴うため昇格時に検討
- **Dynamic Client Registration メタデータ対応**: 本リポジトリに DCR 自体が存在しないため対象外
- **PAR エンドポイントのレート制限・リクエストサイズ上限の実装**（RFC 9126 §2.3 の 413/429）: ライブラリ本体ではなくデプロイ層の責務とし、生成コードのコメントとドキュメントで案内する
- **`request_uri` の URL 形式（外部参照, OIDC Core §6.2）**: URN 形式のみ対応。URN 前置詞に一致しない `request_uri` は従来通り core の `request_uri_not_supported` に落とす

## ユースケース / 想定利用者

- FAPI 2.0 やセキュリティ強化構成の PoC を行う開発者が、「自分のクライアント実装が PAR フローに対応できるか」を最速で検証する
- `claims` パラメータや長大な scope を使う構成で、URL 長制限を回避するリクエスト設計を試す
- 「PAR 必須（`require_pushed_authorization_requests: true`）にしたとき既存クライアントがどう壊れるか」を安全に確認する

## プロトコルフロー

```text
Client                                    OP (生成コード + experimental/par + core)
  |                                          |
  |--- POST /par ---------------------------->|  (1) client 認証（token endpoint と同一規則, RFC 9126 §2.1）
  |    client_id, client_secret,              |  (2) request_uri パラメータ拒否（§2.1 MUST NOT）
  |    response_type, redirect_uri,           |  (3) core の認可リクエスト検証を事前実行
  |    scope, state, nonce,                   |  (4) レコード保存 + URN 生成
  |    code_challenge, ...                    |
  |<-- 201 {request_uri, expires_in} ---------|  (§2.2)
  |                                          |
  |--- GET /authorize?client_id=...          |
  |        &request_uri=urn:...:<ref> ------->|  (5) URN 前置詞を検出 → store から単回使用で取得
  |                                          |  (6) client_id 一致・期限を検証、パラメータ展開
  |                                          |  (7) 展開後パラメータで従来の core 検証を実行（§4 MUST）
  |<-- 302 login / consent へ ----------------|  以降は既存 Authorization Code Flow と同一
```

## 入出力

### PARエンドポイント リクエスト（RFC 9126 §2.1）

- メソッド: `POST` のみ。他メソッドは `405`
- Content-Type: `application/x-www-form-urlencoded`
- クライアント認証: token endpoint と同一規則（`client_secret_basic` / `client_secret_post`。public client は `client_id` のみ提示）。core の `authenticateClient` を再利用する
- ボディ: 認可エンドポイントに送るのと同じパラメータ一式
- `request_uri` パラメータは **MUST NOT**（§2.1）。含まれていたら `invalid_request`
- `request` パラメータは非目標のため `invalid_request`（error_description で PAR+JAR 未対応を明示）

### PARエンドポイント 成功レスポンス（RFC 9126 §2.2）

- ステータス: `201 Created`（§2.2 MUST）
- ヘッダ: `Content-Type: application/json`, `Cache-Control: no-cache, no-store`（§2.2 の応答例に一致させる。Review 2 で原文確認し `no-store` のみから修正）
- ボディ:

```json
{
  "request_uri": "urn:ietf:params:oauth:request_uri:<reference-value>",
  "expires_in": 60
}
```

- `<reference-value>` は暗号論的擬似乱数で生成（§2.2 MUST）。core の `generateRandomString(32)`（`crypto.getRandomValues` による 32 バイト = 256bit を base64url 化。`packages/core/src/crypto-utils.ts:65` で確認済み）を使用する
- `expires_in` デフォルト 60 秒（RFC の推奨レンジ 5〜600 秒内。設定で変更可能）

### PARエンドポイント エラーレスポンス（RFC 9126 §2.3）

token endpoint と同一形式の JSON エラー（`{"error": "...", "error_description": "..."}`）。

| 条件 | HTTP | error |
|---|---|---|
| クライアント認証失敗 | 401 | `invalid_client`（`client_secret_basic` 失敗時は `WWW-Authenticate: Basic` を付与。token endpoint の既存挙動に合わせる） |
| `request_uri` がボディに存在 | 400 | `invalid_request` |
| `request` がボディに存在（非目標） | 400 | `invalid_request` |
| 認可リクエスト検証エラー（redirect_uri 不一致、scope 不正等） | 400 | core の `AuthorizationErrorCode` を PAR 用にマップ（`invalid_request` / `invalid_scope` / `unauthorized_client` / `unsupported_response_type`）。**リダイレクトはしない**（バックチャネルのため JSON で返す） |
| POST 以外のメソッド | 405 | （ボディ任意） |

### 認可エンドポイント側（RFC 9126 §4）

- `request_uri` が `urn:ietf:params:oauth:request_uri:` 前置詞に一致する場合のみ experimental の解決処理を行う
- store から**単回使用（atomic consume）**で取得。見つからない・期限切れ・使用済みは `invalid_request_uri` エラー（OIDC Core §3.1.2.6 定義のエラーコード。RFC 9126 は認可エンドポイント側のエラーコードを規定しないため、OIDC のコードを採用する設計判断）。期限切れ拒否自体は RFC 9126 §4 の MUST（"An expired request_uri MUST be rejected as invalid"）
- 解決失敗（不存在・使用済み・期限切れ・client_id 不一致）は**リダイレクトせず**、既存の非リダイレクトエラー経路（`Accept: application/json` なら JSON 400、`authorizationErrorRedirectPath` 設定時は OP 内部パスへ 303、それ以外は HTML エラーページ）で返す。根拠: これらのケースでは検証済みの redirect_uri が確立していない（レコード不存在・他クライアントのレコード）ため、RFC 6749 §4.1.2.1 / OIDC Core §3.1.2.6 の「Redirection URI を検証できない場合は MUST NOT redirect」に該当する。期限切れケースはレコード内に PAR 時検証済みの redirect_uri が残っているが、失敗種別ごとにリダイレクト可否を変えるとエラー応答が request_uri の存在確認オラクルになり得るため、解決失敗は一律非リダイレクトとする（本仕様の設計判断。OIDC Core §3.1.2.6 は `invalid_request_uri` をリダイレクト返却可能なコードとして定義しており、そこからの意図的な逸脱）
- 解決失敗の `error_description` は失敗種別（不存在・使用済み・期限切れ・不一致）を区別しない固定文言とする（存在確認・使用状況のオラクル化を避ける）
- クエリの `client_id` と pushed レコードの `client_id` の一致を検証（不一致は `invalid_request_uri`）。RFC 9126 §2.2「The request_uri value MUST be bound to the client that posted the authorization request」（規範的 MUST）の実現手段であり、比較による強制方法自体は実装判断（Review 2 で原文確認し、Review 1 時点の「純粋な設計判断」という記録を更新）
- 単回使用は RFC 9126 §4 が MAY で許容する「ユーザーエージェントのリロード起因の重複要求の許容」を採らない厳格運用とする。consume 後に authorize URL をリロードすると `invalid_request_uri` のエラーページになる（意図した挙動として理解資料に明記）
- 展開後、`request_uri` を除去したパラメータで**既存の core 検証パイプラインを丸ごと実行**する（§4「MUST validate as it would any other authorization request」を、展開後パラメータを通常フローに流すことで満たす）
- クエリに `client_id`・`request_uri` 以外のパラメータがある場合は無視し、pushed パラメータを正とする（本仕様の設計判断。RFC 9126 §4 はクライアントが送るのは `client_id` と `request_uri` のみと規定しており、それ以外の混在時の挙動は未規定のため、改竄面を最小化する方針を採る）
- `requirePushedAuthorizationRequests: true` 設定時、`request_uri` を伴わない認可リクエストは `invalid_request` で拒否（RFC 9126 §5）

## 公開API案（`@maronn-oidc/experimental/par`）

subpath export（`packages/experimental/package.json` の `exports["./par"]` → `src/par/index.ts`）で提供する。core と同様「合成関数＋ステップ関数」の二層構成とし、CLI 生成コードはステップ単位で呼び出す。

```typescript
// ---- PAR エンドポイント処理 ----

/** 合成関数: PAR エンドポイントの全処理 */
export async function handlePushedAuthorizationRequest(
  context: PushedAuthorizationRequestContext,
): Promise<PushedAuthorizationResponse>;

// ステップ関数（handlePushedAuthorizationRequest はこれらの合成）
export async function authenticateParClient(/* core authenticateClient を委譲 */);
export function rejectForbiddenParParams(params: Record<string, string>): void; // request_uri / request 拒否
export async function validatePushedAuthorizationParams(/* core validateAuthorizationRequest を委譲 */);
export async function createPushedAuthorizationRecord(/* URN生成 + store保存 */): Promise<PushedAuthorizationRecord>;
export function buildPushedAuthorizationResponse(record: PushedAuthorizationRecord): PushedAuthorizationResponse;

// ---- 認可エンドポイント前段の解決処理 ----

/** URN 前置詞に一致する request_uri を pushed パラメータへ展開する。
 *  一致しない場合は null を返し、呼び出し側は従来フローを継続する */
export async function resolvePushedRequestUri(options: {
  params: Record<string, string>;      // 認可エンドポイントが受けたクエリ
  store: PushedAuthorizationRequestStore;
  now?: Date;
}): Promise<Record<string, string> | null>; // 展開後パラメータ（request_uri 除去済み）

/** requirePushedAuthorizationRequests 用ガード */
export function assertPushedRequestUsed(params: Record<string, string>): void;

export const PAR_REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';

// ---- 型・エラー ----

export interface PushedAuthorizationRequestContext {
  params: Record<string, string>;              // フォームボディ
  authorizationHeader?: string;                // client_secret_basic 用
  clientResolver: ClientResolver;              // core の型を再利用
  store: PushedAuthorizationRequestStore;
  validationOptions: ValidateAuthorizationRequestOptions; // core の型を再利用
  expiresInSeconds?: number;                   // デフォルト 60
}

export interface PushedAuthorizationRecord {
  requestUri: string;      // urn:ietf:params:oauth:request_uri:<ref>
  clientId: string;
  params: Record<string, string>;
  createdAt: Date;
  expiresAt: Date;
}

export interface PushedAuthorizationResponse {
  requestUri: string;
  expiresIn: number;
}

/** 利用者が実装するストア契約（他機能の resolver/store 契約と同スタイル） */
export interface PushedAuthorizationRequestStore {
  save(record: PushedAuthorizationRecord): Promise<void>;
  /** 取得と同時に削除する（単回使用, RFC 9126 §7.3 SHOULD を MUST 運用にする）。
   *  存在しない場合は null。
   *  requestUri は不透明なキーとして扱うこと（URN 前置詞一致は呼び出し側で検証済みだが、
   *  永続ストア実装ではキーをクエリへ埋め込まずパラメータ化するなど、外部入力として扱う） */
  consume(requestUri: string): Promise<PushedAuthorizationRecord | null>;
}

export class ParError extends Error {
  readonly code: ParErrorCode;
  readonly statusCode: number; // 400 | 401
}

export type ParErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_scope'
  | 'unauthorized_client'
  | 'unsupported_response_type';

/** 認可エンドポイント側の解決エラー。常に非リダイレクト（redirect 先情報を持たない）。
 *  生成コードは既存の AuthorizationError 非リダイレクト経路と同じ描画（JSON / 303 / HTML）で処理する */
export class PushedRequestUriError extends Error {
  readonly code: 'invalid_request_uri' | 'invalid_request';
}
```

依存する core API（すべて `packages/core/src/index.ts` で公開済みであることを確認済み）: `authenticateClient` / `extractClientCredentials` / `validateAuthorizationRequest` / `generateRandomString` / `ClientResolver` / `ValidateAuthorizationRequestOptions` / `AuthorizationError` / `AuthorizationErrorCode`。

## CLIオプション案

- `maronn-oidc generate <framework> --enable par` で有効化。**デフォルト無効**
- `packages/cli/src/features.ts` に experimental 機能カテゴリを追加する:

```typescript
export const EXPERIMENTAL_FEATURES = ['par'] as const;
// resolveFeatures: EXPERIMENTAL_FEATURES はデフォルト false、--enable で明示指定した場合のみ true
// --disable に par を指定した場合はデフォルトと同じ無効（エラーにしない）
// 既存 AVAILABLE_FEATURES の「デフォルト全有効」挙動は変更しない（後方互換）
```

- ヘルプ表示に `Experimental features (disabled by default): par` の行を追加
- `OidcFeatureConfig` に `par: boolean`（デフォルト `false`）を追加
- `par: true` のとき生成コードに以下を追加:
  - `oidc-provider/par.ts`: PAR エンドポイントのルート（`/par`）
  - authorize ルート先頭に `resolvePushedRequestUri` の前段フック
  - discovery レスポンスへ `pushed_authorization_request_endpoint` と（強制時のみ）`require_pushed_authorization_requests` をマージ（core の `buildProviderMetadata` の戻り値へのスプレッド追加。core 変更なし）
  - ストア契約の in-memory 実装（他ストアと同様、利用者が差し替える前提のサンプル実装）
  - `INSTALL_COMMANDS` 相当の案内に `@maronn-oidc/experimental` を追加
  - `conformance.test.ts` テンプレートへ PAR 契約テストを追加（`par` 有効時のみ生成）
  - 生成コード冒頭コメントで **Experimental である旨**（API が破壊的に変わり得る旨）を明示

## 設定値とデフォルト

| 設定 | デフォルト | 説明 |
|---|---|---|
| `expiresInSeconds` | `60` | request_uri の有効期間。RFC 9126 §2.2 の推奨レンジ（5〜600秒）内に制限し、範囲外は起動時エラー |
| `requirePushedAuthorizationRequests` | `false` | true のとき PAR を経由しない認可リクエストを `invalid_request` で拒否（RFC 9126 §5） |
| URN 前置詞 | `urn:ietf:params:oauth:request_uri:` 固定 | 変更不可（RFC 9126 §2.2 推奨形式） |

## バリデーション

1. **PAR エンドポイント**（順序どおり）
   1. メソッド `POST` 以外 → 405（フレームワークルーティング層）
   2. クライアント認証（core `authenticateClient`）失敗 → 401 `invalid_client`
   3. `request_uri` パラメータ存在 → 400 `invalid_request`（§2.1 MUST NOT）
   4. `request` パラメータ存在 → 400 `invalid_request`（非目標の明示的拒否）
   5. `client_id` がボディに存在する場合、認証済みクライアントと一致しなければ 400 `invalid_request`
   6. core `validateAuthorizationRequest` による事前検証（redirect_uri 登録一致・response_type・scope・PKCE 等）→ 失敗はエラーコードをマップして 400 JSON（§2.1「validate as it would an authorization request」）
2. **認可エンドポイント**
   1. `request_uri` が URN 前置詞一致 → store から atomic consume。null（不存在・使用済み）→ `invalid_request_uri`（非リダイレクト）
   2. `expiresAt` 超過 → `invalid_request_uri`（非リダイレクト。RFC 9126 §4 MUST）
   3. クエリ `client_id` 欠落または pushed レコードと不一致 → `invalid_request_uri`（非リダイレクト。RFC 9126 §2.2 の client 紐付け MUST の実現）
   4. 展開後パラメータで従来の core 検証を全実行（§4 MUST）。ここ以降のエラーのリダイレクト可否は既存パイプラインの判定（`AuthorizationError.redirectUri` の有無）にそのまま従う
   5. `requirePushedAuthorizationRequests: true` かつ `request_uri` なし → `invalid_request`（RFC 9126 §5）

## エラー処理

- PAR エンドポイントは**リダイレクトしない**。すべて JSON（token endpoint 形式）で返す
- `error_description` には core の `sanitizeErrorDescription` を通した安全な文字列のみ含める
- 認可エンドポイント側の `request_uri` 解決失敗（`invalid_request_uri`）は**一律非リダイレクト**とし、既存の非リダイレクトエラー経路（生成コードの `AuthorizationError` catch 節で `redirectUri` が無い場合の分岐: JSON / 内部エラーページ 303 / HTML）で描画する（詳細と根拠は「認可エンドポイント側」を参照）
- 解決成功後（展開後パラメータを既存パイプラインへ流した後）のエラーは、既存のリダイレクト可否判定に従う。展開後パラメータの redirect_uri は PAR 時に登録一致検証済みのものと同一であり、パイプライン内の `resolveAuthorizationRedirectUri` を通過した時点からリダイレクト可能エラーになる（既存フローと完全に同じ規則）

## セキュリティ要件

| 脅威 | 対策 | 検証方法 |
|---|---|---|
| request_uri 推測（RFC 9126 §7.1） | `generateRandomString` による 256bit 相当エントロピー。MUST（§2.2） | 単体テストで参照値の長さ・文字集合を固定検証 |
| request_uri リプレイ（§7.3） | store の `consume` による atomic な単回使用（RFC の SHOULD を本実装では必須とする。§4 の「UA リロード起因の重複許容 MAY」は採らない） | 結合テスト: 同一 request_uri の2回目使用が `invalid_request_uri` |
| 有効期限切れの使用 | `expiresAt` 検証（RFC 9126 §4 MUST）。デフォルト 60 秒 | 結合テスト: 期限経過後の使用拒否 |
| 他クライアントによる横取り | 認可リクエストの `client_id` と pushed レコードの一致検証（RFC 9126 §2.2「request_uri MUST be bound to the client」の実現） | 結合テスト: client_id 不一致拒否 |
| request_uri の存在確認オラクル | 解決失敗（不存在・使用済み・期限切れ・不一致）を単一エラーコード＋固定 error_description＋一律非リダイレクトで返し、失敗種別を外部から区別不能にする | 結合テスト: 各失敗ケースの応答（コード・description）が同一であることを固定検証 |
| オープンリダイレクト（§7.2） | 未登録 redirect_uri は PAR 時点で core の登録一致検証により拒否。動的 redirect_uri 登録機能自体が存在しないため RFC の想定より厳しい | PAR エンドポイントの結合テスト |
| SSRF | 外部 URL 形式の request_uri を一切フェッチしない（URN のみ）。構造的に不可能 | 仕様レビューで確認（フェッチ処理が存在しないこと） |
| CSRF | PAR はクライアント認証付きバックチャネル POST であり Cookie を使用しない。認可エンドポイント側は既存の state/PKCE 対策（§7.5）に委ねる | 既存テストでカバー |
| ストア溢れ（DoS） | 短い有効期限＋期限切れレコードの削除を store 契約のドキュメント要件とする。レート制限・サイズ上限（413/429）はデプロイ層責務として生成コードコメントで案内 | ドキュメントレビュー |
| 未認証クライアントによる pushed リクエスト汚染 | 認証（または public client の client_id 存在確認＋クライアント解決）を保存より前に実施 | 結合テスト: 認証失敗時にレコードが保存されないこと |

**ログ禁止情報**: pushed パラメータには `login_hint` 等の PII が含まれ得るため、生成コードのログには request_uri 参照値と client_id のみを出力し、パラメータ本体・client_secret・Authorization ヘッダを出力しない。

## プライバシー考慮

- 認可リクエスト内容がブラウザ履歴・Referer・アクセスログ（クエリ文字列）に残らなくなるため、PAR はプライバシー面で既存フローより改善となる
- store に保存されるパラメータ（`login_hint` 等）は有効期限後に参照不能となるべきで、in-memory 実装は consume または期限切れ掃除で削除する。永続ストア実装者向けに TTL 設定の指針をドキュメントに記載する

## パッケージ配置と境界

```text
packages/experimental/
  package.json          # 実装Routineが初回実装時に作成（exports["./par"] を定義）
  src/par/
    index.ts            # 公開API
    par-request.ts      # PAR エンドポイント処理（合成＋ステップ）
    par-request.test.ts
    resolve-request-uri.ts       # 認可エンドポイント前段の解決処理
    resolve-request-uri.test.ts
    store.ts            # PushedAuthorizationRequestStore 型定義
```

### 依存方向（必須遵守）

```text
packages/core ──X──> packages/experimental（import禁止・coreの必須機能にしない）
packages/cli  ─────> @maronn-oidc/experimental（許可・生成コードの依存として明示）
@maronn-oidc/experimental ─────> @maronn-oidc/core（許可）
```

- core には一切手を入れない。PAR 無効時の生成コード・既存利用者の挙動は完全に不変
- 機能ごとの subpath export（`@maronn-oidc/experimental/par`）で提供し、ルートからの再エクスポートは作らない
- 他の experimental 機能とのコード共有は行わない（重複許容・独立性優先）

### CLI生成コードからの利用方法

生成される `par.ts` は `@maronn-oidc/experimental/par` からステップ関数を import し、既存の生成コードと同じ「利用者が読める・改造できる」粒度で処理を並べる。

authorize テンプレートは 5 ターゲット全てが hono の `authorizeRouteTemplate` を共有している（`packages/cli/src/frameworks/web-standard/templates.ts` が `toWebRouteTemplate` の文字列変換で再利用し、express / fastify / nextjs の各 generator は web-standard へ委譲する）ため、**前段フックの挿入は単一テンプレートの変更で済む**（Review 2 で確認、旧 U3 解決）。

挿入点は `const params = rawParams;`（`isAuthorizationRequestParams` ナローイング直後、`resolveClientForAuthorization` より前）であり、次の形で `params` 束縛そのものを展開後パラメータへ差し替える:

```typescript
// Experimental: PAR (RFC 9126). request_uri (urn:...) を pushed パラメータへ展開する。
// 展開後パラメータを params として以降の全ステップに流す。URN 前置詞に一致しない場合は
// null が返り、従来どおり rawParams のまま処理される（core が request_uri_not_supported で拒否）。
const resolvedParams = await resolvePushedRequestUri({ params: rawParams, store: parStore });
const params = resolvedParams ?? rawParams;
```

**注意（Review 2 指摘）**: 既存テンプレートの後続ステップ（`resolveClientForAuthorization` / `validateResponseType` / `validateAuthorizationScope` / `rejectUnsupportedRequestParams`）は `effectiveParams` ではなく `params` を参照する。展開結果を `effectiveParams` にだけ入れて `params` を元のまま残すと、`rejectUnsupportedRequestParams(params, ...)` が `request_uri` を検出して `request_uri_not_supported` を投げてしまうため、上記のように `params` 自体を差し替えること。

## テスト計画

### 単体テスト（packages/experimental/src/par/*.test.ts）

- **正常系**: 201 レスポンス構造（`request_uri` 前置詞・`expires_in` 値を具体値で固定）/ URN 参照値のエントロピー形式 / store 保存内容 / `resolvePushedRequestUri` の展開結果（`request_uri` 除去を含めた `toEqual` 固定）
- **異常系**: 認証失敗 401 / `request_uri` in body 400 / `request` in body 400 / client_id 不一致 / core 検証エラーのマッピング（`invalid_scope` 等）/ consume 済み・期限切れ・前置詞不一致（null 返却）/ `expiresInSeconds` 範囲外の起動時エラー
- CLAUDE.md の規約に従い、`should + 動詞` 命名・合格値一意固定・`it` 内条件分岐なしで記述する

### 結合テスト（conformance.test.ts テンプレート追加、`par` 有効時のみ生成）

- PAR → authorize → token の全フロー成功
- discovery に `pushed_authorization_request_endpoint` が含まれる（無効時は含まれない）
- 単回使用: 2回目の authorize が `invalid_request_uri`
- 期限切れ request_uri の拒否
- 認証なし PAR の 401
- `request_uri` を PAR ボディに含めた場合の 400
- `requirePushedAuthorizationRequests` 有効時の非 PAR リクエスト拒否（設定オプションとしてテンプレートに含める場合のみ）

### E2Eテスト（tests/e2e）

- E2E 専用クライアント（`tests/e2e/apps`）に PAR 対応を追加し、実ブラウザで PAR → ログイン → 同意 → コード交換までを検証
- OP は `samples/*` の CLI 生成アプリ（`--enable par` で再生成）を使用

### 相互運用性

- 一次資料の実例（RFC 9126 §2 のリクエスト/レスポンス例）と生成 OP の応答をフィールド単位で突き合わせるテストを結合テストに含める

## ドキュメント要件

- `docs/library-document` に Experimental 機能のガイドページを追加（PAR の概要・有効化方法・ストア差し替え・**Experimental であり API が変わり得る旨の明示**）
- `packages/experimental/README.md` に par の subpath・依存方向・昇格条件を追記
- 生成コード内コメントに RFC 9126 のセクション番号を明記（既存生成コードの流儀に合わせる）

## Changeset要件

- `@maronn-oidc/experimental`: minor（新規機能追加。0.x 運用の場合は初回リリースバージョンに従う）
- `@maronn-oidc/cli`: minor（`--enable par` の追加。既存デフォルト挙動は不変のため breaking ではない）
- core: 変更なし（changeset 不要）

## 完了条件

1. `pnpm --filter @maronn-oidc/experimental test` で本仕様のテスト計画（単体）が全て通る
2. `maronn-oidc generate hono --enable par` の生成コードで conformance.test.ts（PAR ケース含む）が通る
3. `--enable par` なしの生成コードが現行とバイト単位で同一（後方互換の客観的確認）
4. 4フレームワーク（hono / express / fastify / nextjs）＋ web-standard で par テンプレートが生成される。authorize 前段フックは共有テンプレート（hono の `authorizeRouteTemplate`）1 箇所の変更で全ターゲットに反映されるため（Review 2 確認）、残る個別対応は PAR ルートの各ターゲットへの配線（web-standard のルート登録・nextjs の `route.ts` ラッパー等）のみ
5. tests/e2e に PAR フローの Playwright テストが追加され通過する
6. discovery / エラー応答が本仕様の表と一致する
7. changeset・ドキュメントが追加されている

## 未解決事項

| # | 事項 | 影響 | 解決方針 |
|---|---|---|---|
| U2 | `packages/experimental` のビルド・テスト基盤（package.json・tsconfig・vitest 設定）が未整備 | 実装初日の作業量 | 実装Routineが core の構成を踏襲して作成する（本仕様の前提として明記済み） |
| U5 | `requirePushedAuthorizationRequests` を初期リリースに含めるか（テンプレート設定値として公開するか） | スコープ | Review 3 までに判断。含めない場合は公開 API から `assertPushedRequestUsed` を落とし将来拡張へ移す |

セキュリティ上の未解決事項はなし（U2・U5 は実装詳細・スコープ判断であり、脅威対策の設計自体は確定している）。

解決済みの事項:

- U1（2026-07-27 Review 1 解決）: `generateRandomString` のシグネチャ確認。`generateRandomString(32)` で 256bit エントロピーを確保する
- U3（2026-07-28 Review 2 解決）: hono 以外のテンプレート挿入点。5 ターゲット全てが hono の `authorizeRouteTemplate` を共有していることを確認（「CLI生成コードからの利用方法」参照）。テンプレート変更は単一ファイルで済む
- U4（2026-07-28 Review 2 解決）: `invalid_request_uri` のリダイレクト可否。既存実装は `AuthorizationError.redirectUri` の有無で分岐しており、解決失敗は一律非リダイレクト（既存の非リダイレクト経路で描画）と決定（「認可エンドポイント側」「エラー処理」参照）

## 将来の昇格考慮

- 昇格条件の目安: (1) conformance テストが 2 サイクル以上安定 (2) ストア契約への変更要望が収束 (3) FAPI 2.0 対応方針が決まった時点で PAR は core 必須候補になる
- 昇格時の作業: core `authorization-request.ts` に `request_uri` 解決フックを正式追加し、`ProviderMetadata` に `pushed_authorization_request_endpoint` を型として追加、`request_uri_parameter_supported` の discovery 設定と統合。クライアント単位 `require_pushed_authorization_requests` は `ClientInfo` 拡張として検討
- PAR + JAR 併用（PAR ボディの `request`）は昇格とは独立の拡張として、既存 `request-object` 機能の `parseRequestObject` を PAR 検証ステップに合成する形で追加可能
