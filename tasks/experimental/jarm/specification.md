# Experimental機能仕様書: JWT Secured Authorization Response Mode (JARM)

- **機能名**: JWT Secured Authorization Response Mode for OAuth 2.0 (JARM)
- **feature-id**: `jarm`
- **準拠仕様**: JWT Secured Authorization Response Mode for OAuth 2.0 (JARM) — OpenID Foundation Final Specification（2022-11-09）
- **作成日**: 2026-08-02
- **ステータス**: `state.yaml` を参照

## 概要

認可レスポンス（成功時の `code` / `state`、エラー時の `error` / `error_description` / `state`）を、素のクエリパラメータではなく **OP が署名した JWT** 1 つに包んで返す仕組み。クライアントが認可リクエストで `response_mode=query.jwt`（または省略形 `jwt`）を指定すると、OP はリダイレクト先を

```text
https://client.example.com/cb?response=<署名付きJWT>
```

の形に変え、JWT のクレームとして `iss`（OP の issuer）/ `aud`（client_id）/ `exp`（JWT 有効期限）と認可レスポンスパラメータ一式を運ぶ（JARM §2.1 / §2.3.1）。

これにより以下が実現される:

- **改竄防止**: 認可レスポンスの完全性が OP の署名で保護される（§5.2）
- **mix-up 攻撃対策**: `iss` / `aud` クレームにより、クライアントは「どの OP からの・自分宛の応答か」を暗号学的に確認できる（§5.3、RFC 9700 §2.1 も issuer 識別の手段として JARM を明示）
- **出所の証明**: レスポンスが確かにその OP から発行されたことを検証できる

## 採用理由（候補評価）

前サイクル（PAR: 2026-07-27〜29 / Token Exchange: 2026-07-30〜08-01）の候補評価で「次サイクル以降の候補」として明示的に残された JARM を、見送り理由の変化を踏まえて再評価し選定した。

| 観点 | 評価 |
|---|---|
| プロジェクト関連性 | FAPI 系プロファイルで採用される応答保護の標準。実装済みの PAR（リクエスト保護）と対をなし、「リクエストもレスポンスも JWT で保護する」構成の検証を提供できる。RFC 9700 §2.1 が認可レスポンスの issuer 識別手段として JARM を挙げている（2026-08-02 原文確認） |
| Experimental隔離の妥当性 | `response_mode` に JWT 系の値が明示された場合のみ挙動が変わる。指定がない・`query` の場合は完全に従来どおりで、既存フローのデフォルト挙動を一切変えない |
| core無変更 | 可能。core は `response_mode` パラメータを解釈せず黙って無視する（`rejectUnsupportedRequestParams` の拒否対象は `request` / `request_uri` / `registration` のみ。`packages/core/src/authorization-request.ts:853-888` で確認）。リダイレクト URL の構築は core ではなく**生成コード側**（共有テンプレート）で行われているため、応答の JWT 化はテンプレート層＋experimental 層だけで完結する |
| CLI `--enable` 提供 | 可能。既存の experimental 機能カテゴリ（`packages/cli/src/features.ts:37` の `EXPERIMENTAL_FEATURES`）に `jarm` を追加する |
| 一次資料の成熟度 | JARM は OpenID Foundation の **Final Specification**（2022-11-09、Lodderstedt / Campbell）。FAPI 1.0 Advanced / FAPI 2.0 Message Signing で利用実績があり、主要 IdP（Auth0, Keycloak, Authlete 等）で実装済み |
| セキュリティ影響 | 新規エンドポイント・新規ストアを追加しない。応答が「平文クエリ」から「署名付き JWT」に変わるだけで攻撃面は増えず、mix-up・改竄への耐性はむしろ向上する。署名は既存の OP 署名鍵（RS256）を再利用し、新しい鍵素材を導入しない |
| テスト可能性 | 単体（JWT 構造の固定検証）・結合（conformance.test.ts で `response` パラメータの JWS 検証）・E2E（実ブラウザでリダイレクトを受けて JWT を検証）のすべてで検証可能 |
| 実装規模 | 中規模（PAR と同程度）。新規ロジックは「response_mode の解釈」「応答 JWT の生成」「リダイレクト構築の差し替え」に集中する |
| 将来の昇格 | 応答構築を core に「AuthorizationResponseEncoder」として正式導入し、`response_modes_supported` / `authorization_signing_alg_values_supported` を `ProviderMetadata` の型に追加する昇格パスが明確 |
| 既存機能との重複 | なし。`request-object`（JAR: リクエストの JWT 化）・PAR（リクエストの事前登録）とは保護対象が逆方向（レスポンス）で相互補完。`tasks/T-019-dpop.md`（DPoP: トークンの sender-constraining）とも独立 |
| 利用者の検証価値 | 「自分のクライアント実装が JARM 応答（`response` パラメータの JWS 検証、`iss`/`aud`/`exp` チェック）に対応できるか」を IdaaS の契約なしで最速検証できる。FAPI 対応の事前検証として価値が高い |

### 前サイクルで見送った理由の再評価

JARM は過去 2 サイクルで「response_mode の解釈・成功/エラー両応答の JWT 化など authorize 応答系全体に手が入るためテンプレート変更面積が大きい」として見送られた。今回選定に転じた根拠:

1. **共有テンプレートの単一性が実証済み**: authorize / login / consent / discovery の全ルートが hono テンプレートを 5 ターゲット（hono / express / fastify / nextjs / web-standard）で共有していることを PAR 実装が実証した（`packages/cli/src/frameworks/web-standard/templates.ts:2169-2185` で全ルートが `toWebRouteTemplate` 変換で再利用されている）。変更は単一ファイルに閉じる
2. **条件付き補間パターンが確立済み**: 「機能無効時に生成物をバイト同一に保つ `${...}` 補間」「discovery レスポンスへのスプレッドマージ」（PAR の `pushed_authorization_request_endpoint` マージ、`packages/cli/src/frameworks/hono/templates.ts:3628-3641`）が 2 機能で運用実績を持つ
3. **リダイレクト構築サイトが有限で列挙可能**: 本仕様策定時の実地調査で、認可レスポンスを構築する箇所は「エラー用共有ヘルパー `buildErrorRedirect` 1 つ＋インライン 5 箇所」に収まることを確認した（「CLI生成コードからの利用方法」に列挙）

CIBA・Device Authorization Grant は前サイクルと同じ理由（ユーザー対話用の追加 UI・ポーリングが必要でテンプレート変更面積が大きい）で見送り。ただし Device Authorization Grant は「バックチャネルエンドポイント（PAR で実証）＋ grant ディスパッチ（Token Exchange で実証）＋検証 UI」と実証済みパターンの比率が上がっており、次サイクルの有力候補として残す。RAR は authorize / consent / token / introspection の複数層に跨がるため隔離性が劣る判断も前サイクルから変わらない。

## Experimentalにする理由

- 認可レスポンスの出口（リダイレクト構築）という生成コードの根幹に手を入れるため、条件付き補間の設計が安定するまで隔離したい
- `AuthTransaction` への拡張フィールド永続化（後述の `jarmResponseMode`）は「store 実装が未知フィールドを透過的に保存する」ことを前提とする新しい契約であり、実運用フィードバックで固めたい
- 署名 alg の追加（PS256/ES256）・クライアント別 `authorization_signed_response_alg`・JWE 暗号化・`form_post.jwt` 対応で公開 API が変わる可能性が高い

## 非目標（Non-goals）

- **`fragment.jwt`（JARM §2.3.2）**: fragment 系応答は token を含む response_type（implicit / hybrid）向けであり、本 OP は `response_type=code` のみをサポートするため対象外。指定された場合は `invalid_request` で拒否する
- **`form_post.jwt`（JARM §2.3.3）**: 自動送信 HTML フォームのレンダリングが必要でテンプレート面積が増えるため初期スコープから除外。指定された場合は `invalid_request` で拒否する。将来拡張として「将来の昇格考慮」に記録
- **応答 JWT の暗号化（JWE, JARM §2.2 / クライアントメタデータ `authorization_encrypted_response_alg` / `authorization_encrypted_response_enc`）**: 署名のみ対応。暗号化が守る「ブラウザ履歴経由の code 漏えい」（§5.4）への残余リスクはセキュリティ要件に明記する
- **クライアント別 `authorization_signed_response_alg`（JARM §3）**: core の `ClientInfo` は closed なインターフェース（`packages/core/src/authorization-request.ts:105-132`）でメタデータを追加できないため、署名 alg は **RS256 固定**とする。JARM §3 は「未登録時のデフォルトは RS256」と規定しており、メタデータを登録しないクライアントとの相互運用はこの固定で仕様準拠になる
- **RS256 以外の署名 alg**: 本 OP の ID Token 署名と同じ制約（Basic OP の RS256 必須）に合わせる。PS256 対応は `tasks/p2-signing-alg-ps256.md` と歩調を合わせて昇格時に検討
- **JWT 系以外の `response_mode` 値の新規サポート**（`form_post` / `fragment` 等）: 現行の生成 OP は `response_mode` を解釈せず無視する。この挙動は JARM の範囲外であり、本機能は **`.jwt` 系の値のみ**解釈を追加する。`.jwt` 系以外の値は従来どおり無視する（隔離原則。挙動変更を JARM 系列に限定する）
- **Dynamic Client Registration メタデータ対応**: 本リポジトリに DCR 自体が存在しないため対象外

## ユースケース / 想定利用者

- FAPI 対応（FAPI 1.0 Advanced / FAPI 2.0 Message Signing）を見据える開発者が、「自分のクライアント実装が JARM 応答を検証できるか」を最速で確認する
- mix-up 攻撃対策（RFC 9700 §4.4）として「応答の issuer 識別」を JARM で行う構成を、RFC 9207 の `iss` パラメータ方式と比較検証する
- 認可レスポンス改竄（state 差し替え・code 注入）に対する署名保護の効果を、攻撃シナリオ込みで手元で再現する

## プロトコルフロー

```text
Client                                    OP (生成コード + experimental/jarm + core)
  |                                          |
  |--- GET /authorize?response_type=code     |
  |      &client_id=...&redirect_uri=...     |
  |      &response_mode=query.jwt            |  (1) 従来どおり core の認可リクエスト検証
  |      &state=...&code_challenge=... ----->|  (2) redirect_uri 確定後、response_mode を解釈
  |                                          |      - query.jwt / jwt → JARM モードを auth transaction に記録
  |                                          |      - fragment.jwt / form_post.jwt → invalid_request
  |<-- 302 login / consent へ ----------------|  (3) ログイン・同意は既存フローと同一
  |                                          |
  |    （ログイン・同意完了）                  |  (4) code 発行後、応答 JWT を生成
  |                                          |      claims: iss / aud / exp / code / state
  |                                          |      header: alg=RS256, kid（既存 OP 署名鍵）
  |<-- 302 Location:                          |
  |    redirect_uri?response=<JWT> -----------|  (§2.3.1: パラメータは response のみ)
  |                                          |
  |--- POST /token (code, code_verifier) --->|  (5) トークン交換は既存フローと完全に同一
  |<-- 200 {access_token, id_token, ...} ----|
```

エラー時（例: ユーザーが同意を拒否）も同様に、`error` / `error_description` / `state` をクレームに持つ署名付き JWT を `response` パラメータで返す（§2.1 のエラー例に一致）。

## 入出力

### 認可リクエスト（追加解釈するパラメータ）

- `response_mode`: 以下の値を解釈する（response_mode パラメータ自体の定義は OAuth 2.0 Multiple Response Type Encoding Practices §2.1）
  - `query.jwt`: JARM モード。応答を JWT 化しクエリの `response` パラメータで返す（JARM §2.3.1）
  - `jwt`: 省略形。`response_type=code` に対するデフォルトは `query.jwt`（JARM §2.3.4）なので `query.jwt` と同義に扱う
  - `query` / 未指定: 従来どおりの平文クエリ応答（挙動変更なし）
  - `fragment.jwt` / `form_post.jwt` / その他の `.jwt` で終わる値: `invalid_request`（リダイレクト可能エラー。本 OP が対応しない JARM モード）
  - 上記以外（`form_post` / `fragment` / 未知の値）: 従来どおり無視する（非目標に記載の隔離原則）
- `response_mode` は Request Object（`request` パラメータ）内でも指定でき、その場合は OIDC Core §6.1 の supersede 規則に従い Request Object 側の値を採用する。実装上は core の request object マージ後の `effectiveParams`（テンプレートの `packages/cli/src/frameworks/hono/templates.ts:1650-1660` で束縛）から読む
- PAR と併用する場合、pushed パラメータに含めた `response_mode` は PAR の展開（authorize 前段フック）後に通常どおり解釈される。追加の統合作業は不要

### 応答 JWT（JARM §2.1）

**JOSE ヘッダー**:

```json
{ "alg": "RS256", "kid": "<既存 OP 署名鍵の keyId>" }
```

- `alg` は RS256 固定（非目標に記載のとおり。JARM §3 の未登録時デフォルトと一致）
- `typ` ヘッダーは付けない。JARM は `typ` を規定しておらず、§2.3.1 の実例ヘッダーも `{"kid":"laeb","alg":"ES256"}` と `typ` なしのため、実例に忠実な形とする（設計判断）
- 署名鍵は生成 OP の既存 `signingKeyProvider`（`SigningKey { privateKey, publicJwk, keyId }`）を再利用し、クライアントは `jwks_uri` で検証できる

**成功時クレーム**（すべて具体値で固定検証可能）:

```json
{
  "iss": "http://localhost:3000",
  "aud": "<client_id>",
  "exp": 1754092800,
  "code": "<authorization code>",
  "state": "<state（リクエストにあった場合のみ）>"
}
```

**エラー時クレーム**:

```json
{
  "iss": "http://localhost:3000",
  "aud": "<client_id>",
  "exp": 1754092800,
  "error": "access_denied",
  "error_description": "<sanitizeErrorDescription 済み文字列（ある場合のみ）>",
  "state": "<state（ある場合のみ）>"
}
```

- `iss` / `aud` / `exp` は成功・エラー共通の必須クレーム（JARM §2.1）
- `exp` は発行時刻 + `jarmResponseLifetimeSeconds`（デフォルト 60 秒）。JARM §2.1 は「JWT の最大寿命は 10 分を RECOMMENDED」としており、設定上限を 600 秒に制限する
- 素の `iss` クエリパラメータ（RFC 9207）は JARM モードでは**付けない**。§2.3.1 の応答パラメータは `response` のみであり、issuer 識別は JWT の `iss` クレームが担う（RFC 9700 §2.1 が JARM を issuer 識別手段として認めている）。平文クエリ応答（JARM 無効時・非 JARM リクエスト）では既存どおり `iss` パラメータを付ける

### リダイレクト URL（JARM §2.3.1）

```text
HTTP/1.1 302 Found
Location: https://client.example.com/cb?response=<JWS compact serialization>
```

- クエリに付くのは `response` パラメータ**のみ**。`code` / `state` / `iss` の素のパラメータは付けない

## 公開API案（`@maronn-oidc/experimental/jarm`）

subpath export（`packages/experimental/package.json` の `exports["./jarm"]` → `src/jarm/index.ts`）で提供する。PAR / Token Exchange と同様、CLI 生成コードが読める粒度のステップ関数で構成する。

```typescript
// ---- response_mode の解釈 ----

/** effectiveParams の response_mode を JARM の観点で分類する。
 *  - { kind: 'jarm', mode: 'query.jwt' }: query.jwt / jwt（JARM §2.3.4 の code デフォルト）
 *  - { kind: 'plain' }: 未指定 / 'query' / .jwt 系以外の値（従来挙動を維持）
 *  - { kind: 'unsupported-jwt-mode', requested: string }: fragment.jwt / form_post.jwt /
 *    その他 '.jwt' で終わる未知値。呼び出し側が invalid_request のリダイレクト可能エラーにする */
export function resolveJarmResponseMode(
  params: Record<string, string | undefined>,
): JarmResponseModeResolution;

export type JarmResponseModeResolution =
  | { kind: 'jarm'; mode: 'query.jwt' }
  | { kind: 'plain' }
  | { kind: 'unsupported-jwt-mode'; requested: string };

// ---- 応答 JWT の生成 ----

/** 認可レスポンスパラメータを JARM §2.1 のクレーム構造で署名付き JWT にする。
 *  header: { alg: 'RS256', kid: signingKey.keyId }（typ なし）
 *  payload: { iss, aud, exp, ...parameters } */
export async function createJarmResponseJwt(options: {
  issuer: string;                        // iss クレーム
  clientId: string;                      // aud クレーム
  parameters: Record<string, string>;    // code/state または error/error_description/state
  signingKey: SigningKey;                // core の型を再利用
  lifetimeSeconds?: number;              // デフォルト 60
  now?: Date;                            // テスト用の時刻注入
}): Promise<string>;

/** redirect_uri に response パラメータのみを付けた URL を返す（JARM §2.3.1） */
export function buildJarmRedirectUrl(redirectUri: string, responseJwt: string): string;

/** 設定値の起動時検証: 5〜600 秒（JARM §2.1 の最大 10 分 RECOMMENDED）以外はエラー */
export function assertJarmLifetimeSeconds(value: number): void;

// ---- auth transaction への拡張フィールド ----

/** AuthTransaction（core の closed interface）に JARM モードを相乗りさせるための
 *  交差型。生成コードは put 時に { ...transaction, jarmResponseMode } を保存し、
 *  get 後にこの型として読む。store 実装は未知フィールドを透過的に保存する必要がある
 *  （契約要件。conformance テストで固定する） */
export type JarmAuthTransactionFields = {
  /** JARM モードで応答すべきトランザクションであることの記録。無指定は平文応答 */
  jarmResponseMode?: 'query.jwt';
};

export const JARM_RESPONSE_PARAM = 'response';
export const JARM_SUPPORTED_RESPONSE_MODES = ['query.jwt', 'jwt'] as const;
```

### JWS 生成の実装方針

core は低レベル署名ヘルパー（`sign` / `arrayBufferToBase64Url`）を公開 API に含めていない（`packages/core/src/index.ts` の crypto-utils export は `generateRandomString` / `extractAlgorithmParamsFromJwk` / `getJwaAlgorithm` のみ。2026-08-02 確認）。core の非公開内部に依存しない原則を守るため、`createJarmResponseJwt` は **Web Crypto API（`crypto.subtle.sign` + base64url 化）で compact JWS 生成を experimental 内に自前実装**する。core 内部と同種のコードが重複するが、「Experimental 機能間・core との重複は許容し独立性を優先する」方針（CLAUDE.md / 本 Routine の package 境界規約）に従う。core への export 追加はしない（core 無変更の維持）。

依存する core 公開 API（すべて `packages/core/src/index.ts` で公開済みであることを確認済み）: `SigningKey` / `SigningKeyProvider`（`index.ts:229-230`）/ `AuthorizationError`（`index.ts:27`）/ `AuthorizationErrorCode` / `sanitizeErrorDescription`（`index.ts:150`）/ `AuthTransaction` 型（`index.ts:170`）。

なお `resolveJarmResponseMode` が例外ではなく判別共用体を返すのは、`unsupported-jwt-mode` を検出できる時点（パラメータ解釈時）と、それをリダイレクト可能エラーにできる時点（redirect_uri 確定後）が異なるためである。エラー化は生成コードが redirect_uri 確定後に core の `AuthorizationError`（`invalid_request` は closed enum に含まれる）で行い、専用エラークラスを追加しない（PAR の `PushedRequestUriError` と異なり、必要なエラーコードが core の enum に存在するため）。

## CLIオプション案

- `maronn-oidc generate <framework> --enable jarm` で有効化。**デフォルト無効**
- `packages/cli/src/features.ts`: `EXPERIMENTAL_FEATURES` に `'jarm'` を追加し、`OidcFeatureConfig` に `jarm: boolean`（デフォルト `false`）を追加。既存の resolve 規則（experimental はデフォルト false・`--disable` 指定は no-op）に乗る
- `jarm: true` のとき生成コードに以下を追加:
  - authorize ルート: redirect_uri 確定後（`templates.ts:1940-1942` の `redirectUri` / `state` 束縛直後）に `resolveJarmResponseMode(effectiveParams)` を実行。`unsupported-jwt-mode` なら `AuthorizationError('invalid_request', ..., redirectUri, state)`、`jarm` なら auth transaction に `jarmResponseMode: 'query.jwt'` を含めて保存
  - 応答構築の共通化: 成功リダイレクト構築ヘルパー（仮称 `buildSuccessRedirect`）を導入し、既存のインライン構築（後述の 4 箇所）を置き換える。`buildErrorRedirect`（`templates.ts:1829-1844`）とともに「トランザクションの `jarmResponseMode` があれば `createJarmResponseJwt` + `buildJarmRedirectUrl`、なければ従来の平文クエリ」で分岐する
  - discovery: `response_modes_supported` は core の既存設定フィールド `responseModesSupported`（`packages/core/src/discovery.ts:56, 242-243` で確認）に `['query', 'query.jwt', 'jwt']` を渡す形で拡張する（テンプレートの `responseModesSupported: ['query']` 固定値（`templates.ts:3687`）を jarm 有効時のみ差し替え。core 無変更）。`authorization_signing_alg_values_supported: ['RS256']` は core の `DiscoveryConfig` に存在しないため、PAR の `pushed_authorization_request_endpoint` と同じスプレッドマージ方式（`templates.ts:3628-3641` のパターン）で追加する（JARM §4）
  - `jarmConfig`（`jarmResponseLifetimeSeconds`）の定数 export と `assertJarmLifetimeSeconds` によるモジュールトップレベル検証（PAR の `parConfig` / `assertParExpiresInSeconds` と同型）
  - `INSTALL_COMMANDS` 相当の案内に `@maronn-oidc/experimental` を追加（PAR / Token Exchange で導入済みのため、jarm 有効時にも同パッケージが案内されることの確認のみ）
  - `conformance.test.ts` テンプレートへ JARM 契約テストを追加（`jarm` 有効時のみ生成）
  - 生成コード冒頭コメントで **Experimental である旨**（API が破壊的に変わり得る旨）と JARM のセクション番号を明示
- **`jarm` 無効時の生成物は現行とバイト同一**（条件付き補間。PAR / Token Exchange と同じ完了条件）

## 設定値とデフォルト

| 設定 | デフォルト | 説明 |
|---|---|---|
| `jarmResponseLifetimeSeconds` | `60` | 応答 JWT の `exp` までの秒数。許容範囲 5〜600 秒（JARM §2.1「最大 10 分 RECOMMENDED」内に制限）。範囲外は起動時エラー |
| 署名 alg | `RS256` 固定 | 変更不可（非目標参照。JARM §3 の未登録時デフォルトと一致） |
| 応答パラメータ名 | `response` 固定 | 変更不可（JARM §2.3.1） |
| 対応 response_mode | `query.jwt` / `jwt` 固定 | 変更不可（`response_type=code` 専用 OP のため） |

## バリデーション

**認可エンドポイント**（順序どおり。1〜2 は既存パイプラインのまま）:

1. 既存の core 検証パイプライン（client_id 解決・redirect_uri 登録一致・response_type・scope・PKCE 等）を従来どおり実行
2. `redirectUri` / `state` 確定（`resolveAuthorizationRedirectUri`）
3. `resolveJarmResponseMode(effectiveParams)` を実行:
   - `unsupported-jwt-mode` → `AuthorizationError('invalid_request', 'response_mode <値> is not supported', redirectUri, state)`。リダイレクト可能エラーとして既存 catch 節で処理される（このエラー自体は**平文クエリで返す**。対応できないモードでの応答は不可能であり、JARM はこのケースの応答形式を規定しないため設計判断として平文とする）
   - `jarm` → auth transaction に `jarmResponseMode: 'query.jwt'` を記録
   - `plain` → 何もしない（従来挙動）
4. 応答構築時（成功・リダイレクト可能エラーの全サイト）: トランザクションの `jarmResponseMode` が `'query.jwt'` なら応答 JWT を生成し `redirect_uri?response=<jwt>` へ 302。無ければ従来の平文クエリ

**応答 JWT 生成時**:

1. `lifetimeSeconds` は起動時に `assertJarmLifetimeSeconds` で検証済み（5〜600）
2. `error_description` は `sanitizeErrorDescription` を通した文字列のみクレームに入れる
3. 値が `undefined` のパラメータ（`state` なし等）はクレームに含めない（JARM §2.1: 「リクエストに state があった場合のみ」の実現）

## エラー処理

- **リダイレクト可能エラー**（redirect_uri 確定後）: トランザクション（またはリクエスト処理中のローカル変数）の JARM モードに従い、JARM モードなら `error` クレーム入り JWT を `response` パラメータで返す（JARM §2.1 のエラー例と同形）。平文モードなら既存どおり `error` / `error_description` / `state` / `iss` クエリ
- **非リダイレクトエラー**（client_id 不明・redirect_uri 不一致等）: 既存の非リダイレクト経路（JSON 400 / 内部エラーページ 303 / HTML）のまま変更しない。JARM は redirect_uri が確立した応答の形式であり、リダイレクトしない応答には適用されない
- **`unsupported-jwt-mode` のエラー応答は平文クエリ**（バリデーション 3 の設計判断参照）
- **JARM モード確定後の応答 JWT 生成失敗**（署名鍵取得失敗等）: 既存の `server_error` 経路に落とす。このとき応答形式は平文クエリへフォールバックする（JWT を生成できない以上 JARM 形式では返せない。エラーの内容は署名の有無に関わらず `server_error` 固定文言であり、情報漏えいの追加はない）

## セキュリティ要件

| 脅威 | 対策 | 検証方法 |
|---|---|---|
| 応答改竄（state 差し替え・code 注入） | 全応答パラメータを RS256 署名付き JWT に内包（JARM §5.2） | 結合テスト: `response` JWT を jwks_uri の鍵で検証し、クレームを具体値で固定 |
| mix-up 攻撃（RFC 9700 §4.4 / JARM §5.3） | `iss`（OP issuer）・`aud`（client_id）クレームを常時含める | 単体テスト: クレーム値の固定検証 |
| `alg: none` 攻撃 | OP は常に RS256 で署名し `none` を生成しない（JARM §2.4 は client 側に `none` 拒否を MUST）。alg はコード上固定で設定不能 | 単体テスト: ヘッダー `alg` が `RS256` 固定であること |
| 応答 JWT の長期リプレイ | `exp` クレーム（デフォルト 60 秒、上限 600 秒 = JARM §2.1 の 10 分 RECOMMENDED 内） | 単体テスト: `exp = now + lifetime` の固定検証 / 範囲外設定の起動時エラー |
| 認可コードのリプレイ | JWT はコード再利用を防がない（JARM §5.2: 署名は完全性のみ）。コードの単回使用・PKCE は core の既存実装が担う | 既存 conformance テストでカバー済み（本機能で挙動不変であることを結合テストで確認） |
| ブラウザ履歴・Referer 経由の code 漏えい（JARM §5.4） | **残余リスクとして明示**: 署名のみでは防げず、JWE 暗号化は非目標。PKCE 必須（core 既定）により漏えいコード単独での交換は不可。理解資料・生成コードコメントに明記 | ドキュメントレビュー |
| 署名鍵の取り扱い | 新規鍵を導入せず既存 `signingKeyProvider` を再利用。秘密鍵はログ・エラーメッセージに出さない（既存規約のまま） | コードレビュー |
| エラー情報の露出 | `error_description` は `sanitizeErrorDescription` 経由のみ。JWT 化により露出面は増えない | 単体テスト: sanitize 済み文字列の固定検証 |
| store 実装によるフィールド欠落 | `jarmResponseMode` が store の round-trip で失われると**平文応答に静かにフォールバック**してしまう（クライアントは JARM 応答を期待して平文を受ける）。契約として「store は未知フィールドを保存する」を明記し、conformance テストで round-trip を固定する | 結合テスト: JARM リクエスト→ログイン→同意の全フロー後の応答が JWT であること |

**ログ禁止情報**: 応答 JWT（`code` を含む）・認可コード・署名鍵。生成コードのログには transaction id / client_id / 応答モード種別のみを出力してよい。

## プライバシー考慮

- 応答 JWT に含まれるのは `iss` / `aud` / `exp` / `code` / `state`（エラー時は `error` 系）のみで、ユーザー識別子・PII は含めない（含めてはならない。クレーム追加は昇格時の検討事項とし、初期実装では固定クレームセットとする）
- JWT はクエリパラメータとして URL に載るためブラウザ履歴に残る。含まれる実質的な機密は短命な `code` のみであり、既存の平文クエリ応答と同等（悪化しない）。JWE による改善は昇格時の検討事項

## パッケージ配置と境界

```text
packages/experimental/
  package.json          # exports["./jarm"] を追加
  src/jarm/
    index.ts            # 公開API
    response-mode.ts    # resolveJarmResponseMode
    response-mode.test.ts
    response-jwt.ts     # createJarmResponseJwt / buildJarmRedirectUrl / assertJarmLifetimeSeconds
    response-jwt.test.ts
```

### 依存方向（必須遵守）

```text
packages/core ──X──> packages/experimental（import禁止・coreの必須機能にしない）
packages/cli  ─────> @maronn-oidc/experimental（許可・生成コードの依存として明示）
@maronn-oidc/experimental ─────> @maronn-oidc/core（許可）
```

- core には一切手を入れない。jarm 無効時の生成コード・既存利用者の挙動は完全に不変
- 機能ごとの subpath export（`@maronn-oidc/experimental/jarm`）で提供し、ルートからの再エクスポートは作らない
- 他の experimental 機能（par / token-exchange）とのコード共有は行わない（重複許容・独立性優先）

### CLI生成コードからの利用方法

生成テンプレートの変更はすべて共有ファイル `packages/cli/src/frameworks/hono/templates.ts`（＋conformance テンプレートを持つ `web-standard/templates.ts`）に閉じる。本仕様策定時（2026-08-02, main 相当）の実地調査による**応答構築サイトの棚卸し**:

| # | サイト | 位置（templates.ts） | 種別 | JARM 対応 |
|---|---|---|---|---|
| 1 | `buildErrorRedirect` ヘルパー | 1829-1844 | エラー（prompt=none 系の全エラーが経由: 2019-2103 で 8 回呼び出し） | ヘルパー自体をモード対応にする（トランザクションを引数に追加） |
| 2 | authorize ルート: 即時発行（prompt=none 成功） | 2133-2138 | 成功 | `buildSuccessRedirect` 化 |
| 3 | authorize ルート: SSO 再利用パス | 2198-2203 | 成功 | `buildSuccessRedirect` 化 |
| 4 | authorize ルート: catch 節の `AuthorizationError` リダイレクト | 2225-2238 | エラー | JARM モードのローカル解決結果で分岐（トランザクション保存前のエラーがあるため） |
| 5 | consent ルート: 拒否（access_denied） | 3953-3961 | エラー | トランザクションの `jarmResponseMode` で分岐 |
| 6 | consent ルート: 承認（code 発行） | 4012-4018 | 成功 | `buildSuccessRedirect` 化 |

実装上の必須要件:

1. **挿入はすべて条件付き補間**（`${...}` が jarm 無効時に空文字列/現行文字列へ展開される形）とし、jarm 無効時の生成物を現行とバイト同一に保つ
2. **auth transaction の保存**: `createAuthTransaction`（core）が返すトランザクションに `{ ...transaction, jarmResponseMode: 'query.jwt' }` を合成してから store へ put する。読み出し側は `JarmAuthTransactionFields` 交差型で参照する。core の `AuthTransaction` インターフェースは変更しない（構造的型付けにより余剰プロパティの保存・参照は型安全に可能）
3. **サイト 4（catch 節）の注意**: `AuthorizationError` はトランザクション保存前にも投げられる。catch 節では「リクエスト処理中に解決した JARM モードのローカル変数」を参照し、モード解決前のエラー（client_id 不明等）は必ず非リダイレクトなので JARM 分岐に到達しない
4. **応答 JWT 生成に使う鍵**: 各サイトのスコープに既にある `signingKeyProvider` 由来の鍵束縛を再利用する（新規の鍵取得経路を作らない）。サイトのスコープに鍵束縛が無い場合は当該サイト内で `getSigningKey()` を呼ぶ（Token Exchange Review 1 で確立した「分岐内で独自に取得」方式）

## テスト計画

### 単体テスト（packages/experimental/src/jarm/*.test.ts）

- **`resolveJarmResponseMode` 正常系**: `query.jwt` → jarm / `jwt` → jarm（mode は `query.jwt`）/ 未指定・`query` → plain / `form_post` → plain（従来挙動維持）
- **`resolveJarmResponseMode` 異常系**: `fragment.jwt` / `form_post.jwt` / `foo.jwt` → unsupported-jwt-mode（requested 値を固定検証）
- **`createJarmResponseJwt` 正常系**: header（`{alg: 'RS256', kid: <固定値>}` を `toEqual` で固定。`typ` が無いこと）/ 成功クレーム（iss / aud / exp / code / state を具体値で固定。now 注入で exp を決定的に）/ エラークレーム / `state` なし時にクレーム自体が無いこと / jwks の公開鍵で署名検証が通ること
- **`buildJarmRedirectUrl`**: `response` パラメータのみが付与された URL の固定検証（既存クエリを持つ redirect_uri の保全含む）
- **`assertJarmLifetimeSeconds`**: 5 / 600 の境界通過、4 / 601 / 非整数の拒否
- CLAUDE.md の規約に従い、`should + 動詞` 命名・合格値一意固定・`it` 内条件分岐なしで記述する

### 結合テスト（conformance.test.ts テンプレート追加、`jarm` 有効時のみ生成）

- `response_mode=query.jwt` の全フロー（authorize → login → consent → `response` JWT 受領 → JWT 内 code で token 交換成功）。JWT は `/.well-known/jwks.json` の鍵で検証し、`iss` / `aud` / `code` / `state` を固定検証。`code` / `state` / `iss` の素のクエリパラメータが**無い**ことも固定検証
- `response_mode=jwt`（省略形）が `query.jwt` と同じ応答になること
- 同意拒否時のエラー応答が `error: access_denied` クレーム入り JWT で返ること
- `response_mode=fragment.jwt` が平文クエリの `invalid_request` エラーリダイレクトになること
- `response_mode` 未指定・`query` のフローが従来と完全に同一であること（JARM 有効化が既存挙動を変えないことの契約）
- discovery が `response_modes_supported: ['query', 'query.jwt', 'jwt']` と `authorization_signing_alg_values_supported: ['RS256']` を返すこと（無効時は現行の `['query']` のまま）
- prompt=none（既存セッションあり）の成功・エラー応答が JARM モードで JWT 化されること（サイト 1〜3 の検証）
- store round-trip: ログイン・同意を挟んでも（= transaction が store を往復しても）JARM モードが維持されること（上記全フローテストが兼ねる）

### E2Eテスト（tests/e2e）

- E2E 専用クライアント（`tests/e2e/apps`）に JARM 応答の受信・検証（JWS 検証 + iss/aud/exp チェック + code 抽出）を追加し、実ブラウザで authorize → ログイン → 同意 → JWT 応答 → コード交換までを検証
- OP は `samples/*` の CLI 生成アプリ（`--enable jarm` で再生成）を使用

### 相互運用性

- JARM §2.1 の成功・エラー実例（iss / aud / exp / code / state の構造）と生成 OP の応答 JWT をクレーム単位で突き合わせるテストを結合テストに含める

## ドキュメント要件

- `docs/library-document/src/content/docs/experimental/jarm.md` を追加（par.md / token-exchange.md と同構成: 概要・有効化方法・クライアント側の検証手順・**Experimental であり API が変わり得る旨の明示**・`form_post.jwt` / JWE 非対応の制限一覧）
- `packages/experimental/README.md` に jarm の subpath・依存方向・昇格条件を追記
- 生成コード内コメントに JARM のセクション番号を明記（既存生成コードの流儀に合わせる）
- store 実装者向けに「auth transaction store は未知フィールドを透過的に保存すること」の契約をドキュメント化（JARM 有効時の前提として明示）

## Changeset要件

- `@maronn-oidc/experimental`: minor（新規機能追加）
- `@maronn-oidc/cli`: minor（`--enable jarm` の追加。既存デフォルト挙動は不変のため breaking ではない）
- core: 変更なし（changeset 不要）

## 実装順序

実装 Routine は次の順で進める。各ステップの検証方法は「完了条件」の対応番号を参照する:

1. `packages/experimental/src/jarm/` の実装と単体テスト（完了条件 1）。JWS 自前実装は `response-jwt.ts` に閉じる
2. `packages/experimental/package.json` に `exports["./jarm"]` を追加
3. `packages/cli/src/features.ts`: `EXPERIMENTAL_FEATURES` へ `'jarm'` 追加・`OidcFeatureConfig.jarm`・ヘルプ表示
4. テンプレート変更（共有 `hono/templates.ts`）: response_mode 解釈＋transaction 拡張保存 → 応答構築サイト 6 箇所のモード対応（棚卸し表の順）→ discovery マージ → `jarmConfig` → conformance テンプレート（完了条件 2・4・6）
5. `--enable jarm` なし生成のバイト同一確認（完了条件 3。変更前後の CLI で同一設定の生成物を diff する）
6. E2E（tests/e2e。完了条件 5）
7. ドキュメント・changeset（完了条件 7）

## 完了条件

1. `pnpm --filter @maronn-oidc/experimental test` で本仕様のテスト計画（単体）が全て通る
2. `maronn-oidc generate hono --enable jarm` の生成コードで conformance.test.ts（JARM ケース含む）が通る
3. `--enable jarm` なしの生成コードが現行とバイト単位で同一（後方互換の客観的確認）
4. 4 フレームワーク（hono / express / fastify / nextjs）＋ web-standard で JARM 対応が生成される（共有テンプレート変更のみで反映されること。PAR で実証済みの構造）
5. tests/e2e に JARM フローの Playwright テストが追加され通過する
6. discovery / 応答 JWT / エラー応答が本仕様の表と一致する
7. changeset・ドキュメントが追加されている

## 未解決事項

| ID | 内容 | 解決予定 |
|---|---|---|
| U1 | `buildErrorRedirect` の 8 呼び出しサイト（`templates.ts:2019-2103`）すべてで `transaction`（JARM モードを持つ）がスコープにあることの網羅確認。1 箇所でもトランザクション不在のサイトがあれば、そのサイトの扱い（平文フォールバック）を仕様に追記する | Review 2（テンプレート実地確認） |
| U2 | 応答 JWT 生成が async になることで、現在同期関数である `buildErrorRedirect` の呼び出しサイトに `await` 追加が必要になる。条件付き補間でバイト同一を保ちながら同期/非同期を切り替える具体的なテンプレート戦略（ヘルパーを常に async にすると無効時もバイト差分が出るため、呼び出し式ごと補間する等）の確定 | Review 2 |
| U3 | E2E 専用クライアント（`tests/e2e/apps`）への JARM 検証組み込み方（既存クライアントの構造確認） | Review 3 |

セキュリティ上の未解決事項: なし（U1・U2 はテンプレート実装戦略の確認事項であり、未確認のまま承認はしない）。

## 将来の昇格考慮

- 昇格条件の目安: (1) conformance テストが 2 サイクル以上安定 (2) `AuthTransaction` 拡張フィールド方式への変更要望が収束（昇格時は core の `AuthTransaction` に正式フィールドとして追加） (3) FAPI 対応方針が決まった時点で PAR とセットで core 候補になる
- 昇格時の作業: core に応答エンコーダ抽象を導入し、`ProviderMetadata` へ `authorization_signing_alg_values_supported` を型として追加。`response_modes_supported` の動的合成。クライアント別 `authorization_signed_response_alg` は `ClientInfo` 拡張として検討
- `form_post.jwt`・JWE 暗号化・PS256/ES256 署名は昇格とは独立の拡張として追加可能（`tasks/p2-signing-alg-ps256.md` と連動）
