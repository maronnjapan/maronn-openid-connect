# 設計案: テストの地図

テストの可視化、管理、自動化の要件を、このリポジトリの上でどう実現するかの設計案である。
実装はしていない。
既存の実装に合わせる前提は外し、必要なところは破壊的に変える。
使う道具は OSS か無料のものに限り、生成 AI には頼らない。

要件が最も重視する四つの項目に、この設計は次の仕組みで答える。

| 要件 | 仕組み | 節 |
|---|---|---|
| エンドポイントごとに、どんなテストが何を検証しているかを可視化する | テストカタログを関数カタログに結合し、地図のエンドポイントの画面に「テスト」の欄を足す | 1, 4 |
| エンドポイントが使う関数と、各関数のユニットテストの対応を可視化する | 対象の静的な解決（`describe` の名前と型）と、実行時の関数トレース | 1, 2 |
| 規則に基づく自然言語の記述からテストを機械的に作り、実行する | 閉じた語彙を持つケース定義（YAML）と、その決定論的なコンパイラ | 3 |
| PR で足した、変えた、消したテストと、関連する実装の変更を把握する | 変更前後のカタログの差分を、地図の「届く経路」と突き合わせて PR のコメントに出す | 5 |

## 現状の計測

提案の根拠として、テストの量と書き方を測った（2026-11、`main` 相当）。

| 観点 | 計測結果 |
|---|---|
| テストファイル | 433 個（`packages/core` 38、`packages/experimental` 25、`packages/google-login` 8、`apps/hono` 227、`apps/nextjs` 67、`tests/e2e/specs` 21、ほかは CLI、地図、スクリプト） |
| `it` / `test` の数 | Vitest 約 5,300 個（`it.each` は一つと数える）、Playwright 222 個 |
| `describe` の数 | 約 1,700 個。トップレベルは関数名（README の命名規則） |
| `it` の直上の仕様コメント | `packages/core` と `apps/hono` で 610 箇所（`// RFC 6749 §5.2: ...` の形） |
| エンドポイントを HTTP で叩くテスト | `apps/hono` の 17 ファイルが `app.request()` で叩く（`pipeline.test.ts` など）。E2E は `request.get()` / `page.goto()` を約 180 箇所 |
| 実行の種類 | Vitest（edge-runtime 環境の core を含む）、Playwright（apps と samples の OP）、OIDF 適合性スイート（Docker）、CLI の生成物の型検査（`test:matrix`）、`node --test`（スクリプト） |

書き方には、地図が使っている規則と同じ種類の規則がすでにある。
トップレベルの `describe` が関数名であること、`it` の名前が「should + 動詞」であること、仕様の節を `it` の直上のコメントに書くこと、ステップのテストをステップの隣に置くことである。
この設計は、これらの規則を読む側の根拠にする。

一方で、いまの地図（`apps/map`）はテストを読まない。
関数カタログの根はテストを除外し（`extract.json` の `exclude`）、PR の地図はテストの変更を「関数の無いファイル」の数（`MapChanges.otherFiles`）として数えるだけである。
エンドポイントから関数まで型でたどる基盤と、PR の変更が届く経路の計算は、テストを載せる土台としてそのまま使える。

## 設計の前提と、残すもの

地図の設計（[design-change-trail-and-decision-cases.md](design-change-trail-and-decision-cases.md)）と同じ考え方を取る。
機械で計算できることは計算し、人に書かせるのは機械が計算できないことに限る。
貢献者に課す規則は、生成器が要るものに絞り、無くても地図が欠けたり CI が落ちたりしないようにする。

残すものは次のとおりである。

- 関数カタログの id（`<root>:<module>#<name>`）と、エンドポイントの処理本体の id（`endpoint:<id>`）。テストの対象はこの id で指す
- `packages/map-analysis` の、TypeScript のコンパイラ API による読み取りと型による呼び先の解決。テストファイルも同じ解析器で読む
- PR の地図の、変更前後の比較と「届く経路」（`changes.frames[].reach`）。テストの差分はこの上に足す
- `map-preview.yml` の、PR ごとのプレビューと一つのコメントを書き換える仕組み。テストの節を同じコメントに足す
- 既存のテストの書き方。いまのテストを書き直さずに読めることを設計の条件にする

捨てるものは、テストの変更を数だけで扱う `otherFiles` と、地図のビルドとテストの実行が別のワークフローで独立に走る構成である（「データとビルド」の節）。

## 全体像

四つの柱で組み立てる。
**テストカタログ**がテストの表現、**関数トレース**が実行の記録、**ケース定義**が規則に基づく記述、**テストの差分**が PR での変化の表現である。

```
  テストコード (*.test.ts, *.spec.ts)   ケース定義 (*.case.yaml)
          │ 静的解析（コンパイラ API）          │ 構文と語彙の検証
          ▼                                    ▼
  ┌──────────────── テストカタログ ────────────────┐
  │ テスト id、種類、対象（関数 / エンドポイント）、    │
  │ 観点、期待結果、仕様の節、リクエストの形            │
  └──────────────────┬─────────────────────────────┘
                     │ 結合（対象の id）
  関数カタログ ───────┤                ◄── 実行結果（Vitest / Playwright の JSON）
  エンドポイントと    │                ◄── 関数トレース（テストごとに通った関数とエンドポイント）
  処理の流れの木 ─────┤
                     ▼
        地図のデータ（map.json + tests/*.json）
                     │
        ┌────────────┼──────────────┐
        ▼            ▼              ▼
  エンドポイントの   関数のページの   このPRの変更の
  「テスト」の欄     「テスト」の欄   「テスト」の節と PR のコメント
```

カタログは静的解析だけで作れる。
実行結果とトレースは、あれば結合して「実行されたか」「実際に通ったか」を足す。
無くても画面は欠けず、根拠の欄が「静的」のままになるだけである。

## 1. テストカタログ

テストカタログは、テストケース一つを一つの札にした索引である。
関数カタログが関数の札を持つのと同じ形で、テストの札を持つ。

```ts
interface TestCase {
  /** 安定な id（「テストの id」の項） */
  id: string;
  kind: 'unit' | 'api' | 'e2e' | 'conformance' | 'tool';
  /** テストコードか、ケース定義か */
  source: { file: string; lines: [number, number]; form: 'code' | 'case' };
  /** `it` の名前 */
  title: string;
  /** `describe` の連なり */
  path: string[];
  /** 何を検証するテストか（対象の項） */
  subjects: Subject[];
  /** 送るリクエスト（api と e2e） */
  requests?: RequestShape[];
  /** 正常系か異常系か。期待結果から決める */
  outcome: 'success' | 'failure' | 'unknown';
  /** 境界値、認証、認可、セキュリティなど（観点の項） */
  aspects: string[];
  /** 仕様の節（`it` の直上のコメント、ケース定義の `仕様`） */
  spec: string[];
  /** 期待結果（`expect` の構造） */
  assertions: Assertion[];
  /** 対象を決めた根拠 */
  evidence: Array<'declared' | 'static' | 'trace'>;
}

type Subject =
  | { kind: 'function'; id: string; how: 'describe' | 'call' | 'trace' }
  | { kind: 'endpoint'; id: string; source: 'hono' | 'nextjs'; how: 'request' | 'trace' }
  | { kind: 'member'; id: string; how: 'trace' };

interface Assertion {
  /** 検証した値を言葉にしたもの: `response.status`, `error`, `body.scope` */
  actual: string;
  matcher: string;
  /** リテラルで書かれた期待値。式なら undefined で、text に式を残す */
  expected?: unknown;
  negated?: boolean;
  mode?: 'resolves' | 'rejects';
  /** 画面に出す一行: 「HTTP ステータスが 401 である」 */
  text: string;
}

interface RequestShape {
  endpoint?: string;
  method: string;
  path: string;
  /** ボディのキー（`grant_type`, `code`, ...）と認証の方式 */
  params?: string[];
  auth?: string;
}
```

### テストの種類

種類は、置き場所と振る舞いの二段で決める。
置き場所で決まらないものだけ、振る舞いで分ける。

| 種類 | 決め方 |
|---|---|
| `e2e` | `tests/e2e/specs/` の Playwright のテスト。動いている OP に HTTP とブラウザで到達する |
| `api` | `apps/*` のテストのうち、エンドポイントのパスへリクエストを送るもの（`app.request()`、Next.js の Route Handler に `Request` を渡すもの）。要件の「API テスト」と「統合テスト」はこの一つにまとめる。どちらもプロセス内で HTTP の形を取り、区別する根拠がコードに無いからである |
| `unit` | `packages/*` と `apps/*` のテストのうち、対象が関数カタログの関数で、リクエストを送らないもの |
| `conformance` | `tests/conformance` の OIDF 適合性スイートの module。結果だけを取り込む（「実行結果」の項） |
| `tool` | CLI、地図、解析パッケージ、`.github/scripts` のテスト。一覧には出すが、エンドポイントの地図には載せない |

### 対象の解決

テストが何を検証しているかは、三つの根拠で決め、根拠の種類をテストの札に残す。

**宣言**（`declared`）は、人が書いた対象である。
ケース定義の `対象` と、テストコードの `// @subject` コメントがこれに当たる。
あれば最も強く、静的な解決より優先する。

**静的**（`static`）は、テストコードを読んで決めた対象である。
規則は種類ごとに次のとおりで、どれもコンパイラ API で決定論的に読む。

- ユニットテスト：トップレベルの `describe` の名前を、そのファイルの import から型で引き、関数カタログの id にする。`describe('authenticateTokenClient')` が `hono:endpoints/token/steps/authenticate-client.ts#authenticateTokenClient` になる。名前が関数に引けなければ「対象不明」として一覧に出す
- ステップのテスト：関数が解決できれば、ステップの `meta`（`function: 'authenticateTokenClient'`）を通ってエンドポイントとステップにも結びつく
- API テスト：`it` の本体と、同じファイルのヘルパー関数の中で送るリクエスト（`app.request(url, init)`、Route Handler の呼び出し）の URL の末尾の固定部分（`${TEST_ISSUER}/token` の `/token`）を、エンドポイントのパスと照合する。メソッドは `init.method` のリテラルから取る。複数のエンドポイントへ送るテストは、その全部を対象にする
- E2E テスト：`request.get()` / `request.post()` / `page.goto()` の URL と、`toHaveURL()` が期待する URL を同じ規則で読む。ブラウザのリダイレクトで通るエンドポイント（`/authorize` から `/login` へ）は静的には読めないので、トレースに任せる
- `it` の本体が直接呼ぶ関数カタログの関数も、`how: 'call'` の対象として持つ。`describe` の名前と違う関数を呼ぶテストや、`describe` の無いテストの受け皿である

**トレース**（`trace`）は、実行時に実際に通った関数とエンドポイントである（「関数トレース」の節）。
静的な対象と一致すれば根拠が二つになり、静的に読めなかった到達（リダイレクト、resolver や store の実装）はトレースだけが与える。

### 正常系、異常系、境界値

正常系か異常系かは、期待結果から決める。
`rejects`、`toThrow`、400 以上のステータス、`error` キーの期待のどれかがあれば異常系、`resolves` や 2xx のステータスや値の一致だけなら正常系である。
期待結果が読めないテストは `unknown` にし、一覧に出す。
この規則は語彙に頼らないので、既存のテストにそのまま効く。

境界値、認証、認可、セキュリティなどの観点は、正常か異常かとは別の軸として持つ（`aspects`）。
境界値のテストは正常系のこともあれば異常系のこともあるからである。
観点は次の順で決める。

1. ケース定義の `観点` と、テストコードの `// @aspect boundary` コメント（宣言）
2. 語彙の表（`tests/catalog/aspects.yaml`）。`it` の名前と `describe` の名前に、表の語（`exactly`、`at the limit`、`ちょうど`、`期限`、`上限`、`empty`、`one more`）が含まれれば境界値、`invalid_client`、401、`WWW-Authenticate` の期待があれば認証、`insufficient_scope`、403、`access_denied` なら認可、と表が定める
3. どれにも当たらなければ観点なし

語彙による分類は規則であって推論ではないが、表に無い言い回しは拾えない。
そのため、表はコミットされた文書にし、拾えなかったテストを「観点なし」として画面に出して、表を直すか宣言を足すかを人が選べるようにする。

### 期待結果

`expect(actual).matcher(expected)` の形を構造として読み、言葉にする。
`await expect(...).resolves` / `.rejects` / `.not` も読む。

| コード | 言葉 |
|---|---|
| `expect(response.status).toBe(401)` | HTTP ステータスが 401 である |
| `.rejects.toMatchObject({ error: 'invalid_client' })` | `invalid_client` で失敗する |
| `expect(response.headers.get('Cache-Control')).toBe('no-store')` | `Cache-Control` ヘッダーが `no-store` である |
| `expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })` | ボディの `token_type` が `Bearer`、`expires_in` が 3600 である |
| `await expect(page).toHaveURL(/\/consent$/)` | URL が `/consent` で終わる |

期待値がリテラルでない（変数や関数の結果）ときは、式をそのまま残す。
言葉にする規則は表（`words.ts` と同じ考え）に置き、新しいマッチャーは表に足す。

エラーコードの期待（`error: 'invalid_client'`、`TokenError(invalid_grant)`）は、地図が木から求める「外へ出る失敗」（`FunctionEntry.failures`）と同じ語彙になるので、「不足」の計算に使う（「エンドポイントの画面」の節）。

### リクエストの形

API と E2E のテストは、送るリクエストの形も札に持つ。
ボディが `new URLSearchParams({ grant_type: 'authorization_code', code: 'code-1', ... })` のようなリテラルなら、キーの一覧を取る。
`Authorization` ヘッダーの作り方（`basicAuthorization()`）から認証の方式を読む。
これで、エンドポイントの画面に「どの入力で、何を期待したか」の表が作れる。

### テストの id

id は、ファイルの移動で変わらず、同じテストを二つのビルドで同じ id にする。

- テストコードのテストは、`<root> | describe の連なり | it の名前` のハッシュを id にする。root（core、hono、nextjs、e2e）はファイルを動かしても変わらず、トップレベルの `describe` は関数名なので、ファイルの分割や移動で id は変わらない。名前を変えると id は変わるが、PR の差分が「名前を変えた」として対応づける（「テストの差分」の節）
- ケース定義のテストは、定義の `id` をそのまま使う。重複は検証で落とす
- 名前に頼らず固定したいテストは、`it` の直上に `// @test-id token-invalid-client-secret` と書く。lint が重複を検査する

同じ root で `describe` の連なりと名前が重なるテストは、ビルドが警告し、ファイル名を足した id にする。

## 2. 実行結果と関数トレース

要件は、テストが存在すること、実行されたこと、実際に通ったコード、検証している振る舞いを区別する。
存在と振る舞いはカタログが答え、実行と到達は実行の記録が答える。

### 実行結果

Vitest は JSON レポーター、Playwright は JSON レポーターで、テストごとの結果を書く。
どちらも標準の機能で、設定で有効にする。
地図のビルドはそのファイルを読み、テストの id に結果（成功、失敗、スキップ、所要時間、E2E ならどの OP に対してか）を結びつける。

```ts
interface TestRun {
  run: { id: string; ref: string; commit: string; at: string };
  results: Record<string, { status: 'passed' | 'failed' | 'skipped'; duration: number; target?: string; attempts: number }>;
}
```

Vitest のレポーターが出す名前は `describe` の連なりと `it` の名前なので、カタログの id の計算と同じ規則で引ける。
Playwright も同じである。
ケース定義のテストは、生成したテストが `task.meta` に `id` を書くので、取り違えない。
再試行（Playwright の `retries`）は最後の結果を採り、試行回数を残す。

適合性スイートの結果は、runner スクリプトが出す JSON（module の名前と結果）を読み、module の名前からエンドポイントへの対応表（`tests/conformance/modules.yaml`、人が書く固定の表）で結びつける。
スイートは Docker と外部のテストプランに依るので、結果が無いときは「未実行」と示すだけにする。

### 関数トレース

関数トレースは、テストごとに実際に呼ばれた関数カタログの関数と、通ったエンドポイントを記録する仕組みである。
カバレッジの行の割合ではなく、地図が扱う単位（関数とエンドポイント）で記録する。

記録の仕方は、ビルド時の差し込みにする。
関数カタログの根（`packages/core`、`packages/experimental`、`packages/google-login`、`apps/hono`、`apps/nextjs`）の関数宣言の先頭に、`globalThis.__maronnTrace?.('<関数の id>')` の一文を足す変換器（TypeScript の `TransformerFactory`）を書く。
id は関数カタログと同じ規則で計算するので、カタログと食い違わない。
`globalThis` の関数を省略可能な呼び出しにするのは、記録する側が無いときに何もしないためである。

差し込む場所は二つである。

- Vitest：`MARONN_TRACE=1` のときだけ有効になる Vite のプラグインで、根のファイルを変換する。`beforeEach` でそのテストの id を記録先にし、`afterEach` で通った関数の集合をワーカーごとの JSONL に書く。Vitest はテストを順に走らせるので（`concurrent` を使っていない）、混ざらない
- E2E の OP：`apps/hono` は変換つきでビルドした `dist-traced/` から起動し、各パッケージは変換つきの `dist-traced/` を `package.json` の `exports` の条件（`maronn-trace`）で公開して、`node --conditions=maronn-trace` で引く。リクエストごとの記録先は `AsyncLocalStorage` で持ち、E2E が送る `x-maronn-test` ヘッダーのテストの id に結びつける。Hono のミドルウェア（`apps/hono/src/test-trace/`、CLI が抽出する根の外）が、応答の時点でエンドポイントの id、メソッド、ステータス、エラーコード、通った関数を一行の JSON に書く

Playwright 側は、`test` を `fixtures.ts` から import する形に変え、`page.setExtraHTTPHeaders()` と `request` の `extraHTTPHeaders` でテストの id を送る。
E2E 用の RP（`tests/e2e/apps/client.mjs`）は、ブラウザから受けたヘッダーを OP への呼び出しに引き継ぐ。
これで、ブラウザがリダイレクトで通った `/login` と `/consent` も、RP が裏で叩いた `/token` と `/userinfo` も、そのテストの記録になる。

```ts
interface TraceRecord {
  test: string;
  /** どの OP か（hono, nextjs）。Vitest のユニットテストでは無い */
  target?: string;
  /** 通った関数と interface のメンバーの実装、id で */
  frames: string[];
  /** E2E と API: リクエストの順に */
  requests?: Array<{ endpoint: string; method: string; status: number; error?: string; frames: string[] }>;
}
```

トレースは次のことを与える。

- テストから関数へ：そのテストが実際に通った関数。ユニットテストなら `describe` の対象の下で何を通ったか、API テストならどのステップで止まったか（`invalid_client` のケースは `authenticate-client` の後を通らない）
- 関数からテストへ：その関数を通ったテストの一覧。`describe` が名指すユニットテストと、上から届く API と E2E のテストを分けて出せる
- E2E からエンドポイントへ：一つのテストが通ったエンドポイントの列（`/authorize` → `/login` → `/consent` → `/token` → `/userinfo`）。要件の「エンドポイントを利用する一連の処理フロー」はこれで描く
- 到達していない場所：どのテストも通らない関数、ステップ、エンドポイント

差し込みは生成物に混ざってはならない。
`dist-traced/` は `exports` の条件でしか見えず、ミドルウェアは抽出の根の外にあり、CLI のテンプレートに `__maronnTrace` が含まれないことをテストで確かめる。

Next.js の OP は、サーバーのコードを Next.js 側がバンドルするので、`node --conditions` だけでは差し込んだ dist を使わない。
Webpack なら `resolve.conditionNames`、Turbopack なら `turbopack.rules` のローダーで同じ変換器を当てる案があるが、この設計では決めない。
決まるまでの Next.js の到達は、`NODE_V8_COVERAGE` によるプロセス単位の V8 カバレッジ（`c8` でソースマップを戻す）で、テストごとでなく実行全体で求める。

### 行のカバレッジとの関係

行のカバレッジ（`@vitest/coverage-v8`、`c8`）は、実行全体の割合として参考に出すだけにする。
テストの保証範囲を見る単位は関数と決定であって行ではなく、テストごとの帰属はトレースの方が軽く正確だからである。
決定（`if` の側）まで記録したくなったときは、同じ変換器で決定のノードにも印を差し込めるが、この設計の範囲には入れない。

## 3. 規則に基づく自然言語のテスト定義

ケース定義は、閉じた語彙で書く YAML のテストである。
人が読める言葉で前提条件、操作、期待結果を書き、コンパイラが決定論的に Vitest または Playwright のテストにする。
自由な文を解釈するのではなく、定義済みの言い回しだけを受け付ける。

### 記述例

要件の例をそのまま書くと、次のようになる。

```yaml
id: token-invalid-client-secret
対象: エンドポイント token
目的: 無効なクライアント認証情報を invalid_client で拒否する
仕様: [RFC 6749 §5.2, OAuth 2.1 §2.3]
観点: 異常系
前提条件:
  - 登録済みの confidential クライアント: { client_id: client-1, secret: secret-1 }
  - 保存済みの認可コード: { code: code-1, client_id: client-1 }
実行操作:
  - トークンエンドポイントにリクエストする:
      認証: { 方式: client_secret_basic, client_id: client-1, secret: wrong-secret }
      入力: { grant_type: authorization_code, code: code-1, redirect_uri: https://rp.example.com/callback }
期待結果:
  - HTTP ステータスが 401 である
  - エラーコードが invalid_client である
  - WWW-Authenticate ヘッダーが Basic で始まる
  - 認可コード code-1 は消費されていない
実行先: [hono, nextjs]
```

複数のエンドポイントをまたぐシナリオも同じ形で書く。

```yaml
id: auth-code-flow-online-refresh
対象: シナリオ 認可コードフロー
目的: offline_access なしでも、ログインセッションに束縛されたリフレッシュトークンが返る
仕様: [OIDC Core 1.0 §11]
観点: 正常系
前提条件:
  - 登録済みの confidential クライアント: { client_id: client-1, secret: secret-1, redirect_uri: https://rp.example.com/callback }
  - 登録済みのユーザー: { name: testuser, password: password }
実行操作:
  - 認可リクエストを送る: { client_id: client-1, scope: openid profile, response_type: code }
  - ログイン画面でログインする: { name: testuser, password: password }
  - 同意画面で承認する
  - 認可コードをトークンに引き換える: { 認証: { 方式: client_secret_basic, client_id: client-1, secret: secret-1 } }
期待結果:
  - HTTP ステータスが 200 である
  - ボディに refresh_token がある
  - refresh_token の長さが 43 である
後処理:
  - ストアを破棄する
実行先: [hono]
```

### 文法

文法は二層にする。
**スキーマ**がどの項目を書けるかを定め、**語彙**が各項目に書ける言い回しを定める。

スキーマの項目は要件の 4.2 に対応する。

| 項目 | 必須 | 内容 |
|---|---|---|
| `id` | 必須 | テストの id。ファイルの中で、リポジトリの中で一意 |
| `対象` | 必須 | `エンドポイント <id>`、`関数 <関数の id か名前>`、`シナリオ <名前>` のどれか |
| `目的` | 必須 | 一文。画面とコメントに出す |
| `仕様` | 任意 | 仕様の節の一覧。関数カタログと同じ書き方 |
| `観点` | 任意 | `正常系` か `異常系` と、境界値などの観点。無ければ期待結果から決める |
| `前提条件` | 任意 | 語彙の言い回しの一覧 |
| `入力` | 任意 | 操作に渡す値。操作の `入力` に書くこともできる |
| `実行操作` | 必須 | 語彙の言い回しの一覧。順に実行する |
| `期待結果` | 必須 | 語彙の言い回しの一覧 |
| `エラー時の振る舞い` | 任意 | 途中の操作が失敗したときの期待（シナリオの途中で止まる場合） |
| `後処理` | 任意 | 語彙の言い回しの一覧 |
| `実行先` | 任意 | `hono`、`nextjs` のどれで走らせるか。無ければ両方 |
| `例` | 任意 | 表形式の値の組。一行が一つのテストになる（`it.each` に当たる） |

語彙は、TypeScript の登録簿（`tests/vocabulary/`）に置く。
一つの言い回しは、穴つきのテンプレート、穴の型、実行先ごとの実装からなる。

```ts
expectation('HTTP ステータスが {status} である', { status: z.number().int() }, {
  'in-process': ({ status }, run) => expect(run.response.status).toBe(status),
  http: ({ status }, run) => expect(run.response.status()).toBe(status),
});

precondition('登録済みの confidential クライアント', clientFields, {
  'in-process': async (fields, run) => registerClient(run.db, confidentialClient(fields)),
});
```

言い回しの照合は、テンプレートとの完全一致である。
穴には宣言した型の値だけが入り、穴の無い部分は一字も違えない。
二つのテンプレートが同じ文に一致しうる登録は、登録簿のテストが落とす。
表記ゆれを許したくなったら、別名として登録簿に足す。
照合に曖昧さを持ち込まないことが、「AI に依存しない」と「実行結果が再現可能」の根拠になる。

値は穴に書くか（`HTTP ステータスが 401 である`）、言い回しの後ろの対応表に書く（`登録済みの confidential クライアント: { ... }`）。
穴は一つか二つの素の値のとき、対応表は構造のある値のときに使う。

### コンパイルと実行

ケース定義は、Vitest のプラグインがテストの実行時に読む。
`*.case.yaml` を一つのテストモジュールに変換し、`例` の一行ごと、`実行先` の一つごとに `it` を作る。
`it` の名前は `目的` にし、`task.meta` に `id` を書く。
生成したコードを読みたいときは `pnpm cases:emit` でファイルに書き出せる。
生成したコードはコミットしない。
コミットすると定義と二重になり、どちらが正か分からなくなるからである。

実行先は二つの実行器で動かす。

- **プロセス内**（`in-process`）：`apps/hono` なら `createApp()` をメモリの DB で立てて `app.request()` で叩き、`apps/nextjs` なら Route Handler に `Request` を渡す。既存の `test-support` のヘルパー（`providerApp()`、`registerClient()`）を前提条件の実装に使う。ユニットテストと API テストはこれで書く
- **HTTP**（`http`）：Playwright の `request` とブラウザで、動いている OP に対して実行する。前提条件は、環境変数と運用者の API で用意できるものに限る。語彙の各言い回しは対応する実行先を宣言し、対応の無い実行先を指定したケースは検証で落ちる

同じケース定義を二つの実行先で走らせられるので、プロセス内で確かめた振る舞いが生成物の OP でも同じかを、定義を書き直さずに確かめられる。

### 検証

`pnpm cases:check` が、すべてのケース定義を実行せずに検証する。

- スキーマに合うこと。スキーマは登録簿から JSON Schema として生成し、エディタ（VS Code の YAML 拡張）が言い回しを補完できるようにする
- すべての言い回しが登録簿にあり、穴の型が合うこと
- `id` が一意で、`対象` の関数やエンドポイントが関数カタログにあること
- `実行先` の言い回しの対応が揃うこと

検証は `pnpm run lint` に入れ、CI で落とす。

### カタログとの関係

ケース定義はカタログに最も良い札を与える。
対象、観点、仕様、期待結果、リクエストの形が構造として書かれているので、静的解析の規則に頼らずに読める。
既存のテストコードは書き直さず、新しいテストはケース定義で書くことを勧める。
ただし強制はしない。
語彙に無い振る舞いを確かめるテストは、コードで書いて語彙を後から足せばよい。

### Gherkin と Hurl を採らない理由

Gherkin（cucumber-js）は自然言語に近い OSS の定番だが、ステップの文は正規表現で実装に結びつくので、言い回しが開いている。
同じ振る舞いを別の文で何度も書けてしまい、文から実装への対応が機械で検証できない。
実行器も Vitest と Playwright と別になる。
この設計の語彙は Gherkin のステップに当たるが、テンプレートの完全一致で閉じている点が違う。

Hurl は HTTP のテストを平文で書く OSS の道具で、トークンエンドポイントの異常系はよく書ける。
しかし前提条件（DB の状態）を置けず、ブラウザを動かせず、英語の HTTP の語彙に限られる。
ケース定義の HTTP の実行先の出力先として足すことはできるが、記述の正本にはしない。

## 4. エンドポイントの画面

エンドポイントの画面（トレース）の右の欄に、図、差分、詳細と並べて「テスト」のタブを足す。
左の一覧のエンドポイントには、テストの数と最新の結果の札を付ける。

### テストのタブ

図が見せているフレームについて、次を出す。
根のフレーム（エンドポイント）なら、そのエンドポイントのテスト全体である。

```
POST /token                                テスト 212（API 41 / E2E 23 / ユニット 148）   最新: 全て成功（hono, nextjs）
正常系 61 / 異常系 149 / 境界値 4 / 認証 23      根拠: 静的 212、トレース 198

不足
  - 外へ出る失敗 TokenError(invalid_target) を検証するテストが無い
  - resolveTokenAcrAmr() にユニットテストが無い（到達するテスト 12）
  - 境界値のテストが無いステップ: select-signing-keys, issue-refresh-token

API テスト（apps/hono/.../token/pipeline.test.ts ほか）
  入力                                              期待                         観点    最新
  authorization_code, code, redirect_uri, code_verifier  200, token_type Bearer, no-store   正常系  ✓
  authorization_code, code（二度目）                  400 invalid_grant             異常系  ✓
  client_secret_basic（誤った secret）               401 invalid_client            異常系 認証  ✓
  ...

E2E（このエンドポイントを通るシナリオ）
  Authorization Code Flow › should complete ...     /authorize → /login → /consent → /token → /userinfo   ✓ hono ✓ nextjs
  Client auth methods › should refuse ...           /authorize → ... → /token（401）                       ✓ hono
  ...
```

この節の数は例である。
行を押すと、そのテストの札（対象、仕様、期待結果の一覧、リクエストの形、根拠、結果）と、コードの Drawer でそのテストのソースを開く。
ケース定義のテストは、定義の YAML をそのまま出す。

### 関数とユニットテストの木

アウトラインの各行（ステップ、呼び出し）に、その関数のユニットテストの数と、その行を通ったテストの数の札を付ける。
行を選ぶと、テストのタブはその関数について述べる。

```
POST /token
├ [parse-request] トークンリクエストを解析する              ユニット 11   到達 38
│   └ parseTokenRequest()                                   正常 3 / 異常 8
├ [authenticate-client] クライアントを認証する              ユニット 9    到達 38
│   └ authenticateTokenClient()
│       ├ extractClientCredentials()                        ユニット 7    到達 47
│       ├ resolveAuthenticatedTokenClient()                 ユニット 4    到達 47
│       ├ validateClientAuthMethod()                        ユニット 6    到達 41
│       └ verifyClientSecret()                              ユニット 5（境界値 1）  到達 36
├ [validate-grant-type] grant_type を検証する               ユニット 4    到達 31
...
```

要件の「エンドポイント → E2E / API / 統合 → 正常系 / 異常系 / 境界値、エンドポイント → 関数 → ユニットテスト」の構造は、この木とテストのタブで読む。
関数のページでも同じタブが出て、「呼び出し元」のタブと並ぶ。

### 想定されるリクエストとレスポンス

エンドポイントの「詳細」に、入力と期待の表を足す。
行は、API テストとケース定義のリクエストの形と期待結果から作る。
列の「失敗」は、地図が木から求めた外へ出る失敗（`endpoint:token` の `failures`）で、それを期待するテストがあるかを横に付ける。
これで「このエンドポイントで何をテストしているか」と「何が起こりうるのに検証していないか」が一つの表になる。

### 不足の規則

不足は、推論ではなく次の規則で求める。

- 関数カタログの関数で、`describe` が名指すユニットテストが無く、どのテストのトレースにも現れないもの
- フレームから外へ出る失敗（`failures`）のうち、そのフレームか上のフレームを対象とするテストの期待に、そのエラーが無いもの
- エンドポイントのステップのうち、どのテストも到達していないもの（トレースがあるときだけ）
- 観点の軸で、エンドポイントに境界値のテストが無い、認証のテストが無いなど。どの観点を求めるかは `aspects.yaml` に書く
- 機能（`MapFeature`）のうち、E2E のテストがそのエンドポイントを通らないもの

一覧のページ（`#tests`）に、エンドポイントごと、機能ごと、種類ごとの数と、不足をまとめて並べる。
要件 2.1 の「テストの全体像」はこのページである。

## 5. PR でのテストの差分

PR の地図は、変更前のコードからも木を作って差分を取る。
同じように、変更前のテストカタログも作り、テストの差分を取る。

### テストの差分

```ts
interface TestDiff {
  added: string[];
  removed: string[];
  /** 名前を変えたテスト: 同じファイルで対象が同じで、期待結果の 8 割以上が同じもの */
  renamed: Array<[before: string, after: string]>;
  modified: Array<{
    id: string;
    what: Array<'title' | 'assertions' | 'subjects' | 'requests' | 'body'>;
    assertions?: { added: Assertion[]; removed: Assertion[] };
  }>;
  counts: { before: number; after: number; byKind: Record<string, [number, number]>; byEndpoint: Record<string, [number, number]> };
  /** 変えたフレーム（関数とエンドポイントの処理本体）ごと */
  frames: Array<{
    frame: string;
    /** 対象にする、または到達するテスト */
    related: string[];
    /** そのうち、この PR が足した、変えたもの */
    touched: string[];
    /** 新しく外へ出る失敗のうち、期待するテストが無いもの */
    failuresWithoutTest: string[];
    /** 変更前後の、関連するテストの観点と期待するエラーの集合 */
    before: { outcomes: string[]; aspects: string[]; errors: string[] };
    after: { outcomes: string[]; aspects: string[]; errors: string[] };
  }>;
  results?: { newlyFailing: string[]; fixed: string[]; newlySkipped: string[] };
}
```

変えたテストの中身は、期待結果の構造の差分で言葉にする。
「期待する HTTP ステータスを 400 から 401 に変えた」「`invalid_client` の期待を足した」である。
本体だけ変えて期待結果の変わらないテストは `body` とし、hunk を添える。

### 実装の変更との対応

地図はすでに、PR が変えた関数とエンドポイントの処理本体（`changes.frames`）と、それが届くエンドポイント（`reach`）を持つ。
テストの差分はこれに次を足す。

- 変えたフレームごとの関連するテスト（`describe` が名指すもの、トレースで到達するもの）と、そのうち PR が触ったもの
- 変えたフレームのうち、関連するテストに変更が無いもの。要件 5.2 の「実装が変更されたにもかかわらず、関連テストに変更がない箇所」である。コメントや書き方だけの変更（木が同じ）は対象にしない
- 新しく外へ出る失敗（`failuresAdded`）で、どのテストも期待していないもの
- 関連するテストの観点と期待するエラーの集合が、変更前後でどう変わったか（保証範囲の変化）

テストの結果の変化は、PR の実行の結果と、main の最新の結果を比べる。
main の結果は、main への push で地図を本番にデプロイするときに `data/tests/results.json` として置くので、PR のビルドはその URL から読む。
fork からの PR はシークレットが無くデプロイしないが、本番の結果は公開の URL なので読める。

### PR のコメント

いまのコメント（`<!-- oidc-provider-map-preview -->` の一つ）に「テスト」の節を足す。
要件 5.3 の例に合わせる。

```
## テスト

テストケース: 5,521 → 5,527（+6）  API +3、ユニット +3

変更対象: POST /token（hono, nextjs）
  追加されたテスト:
    - 不正な認証情報で 401 invalid_client を返す（API, 異常系, 認証）
    - 未対応の grant_type で 400 unsupported_grant_type を返す（API, 異常系）
    - 必須パラメータ不足で 400 invalid_request を返す（API, 異常系）
  関連する変更関数:
    - validateClientAuthMethod: ユニット 追加 2
    - validateTokenGrantType: ユニット 変更 1（期待する HTTP ステータスを 400 から 401 に変えた）

関連テストに変更の無い実装の変更:
  - verifyClientSecret（条件 `secret.length < 8` を足した）: 関連するテスト 5 件、変更なし
  - 新しく外へ出る失敗 TokenError(invalid_client, "secret too short") を期待するテストが無い

結果: 新しく失敗 0、直った 1（client-auth-methods › should refuse ...）
```

数と名前は例である。

CI を落とすかどうかは、地図の方針と同じく限定する。
ケース定義の検証（文法と語彙）と、テストの id の重複は落とす。
「関連するテストに変更が無い」と「新しい失敗を期待するテストが無い」は、コメントに出すだけにする。
テストを足すかどうかは変更の性質によるので、機械で一律に求めると形骸化するからである。
必要なら、ラベルで落とす設定に切り替えられるようにしておく。

## 6. データとビルド

### パッケージ

- `packages/test-catalog`（非公開）：テストコードの読み取り（コンパイラ API）、ケース定義のスキーマと語彙とコンパイラ、実行結果とトレースの取り込み、テストの差分。`packages/map-analysis` に依り、関数カタログの id と木を使う
- `packages/test-trace`（非公開、devDependency）：差し込みの変換器、Vite のプラグイン、Vitest の `setup` ファイル、Playwright の `fixtures.ts`、Hono のミドルウェア。実行時の部分は数十行で、生成物には入らない
- `apps/map`：テストのタブ、テストの一覧のページ、このPRの変更のテストの節
- `tests/cases/`：ケース定義の置き場。エンドポイントごとのディレクトリ
- `tests/vocabulary/`：語彙の登録簿。`apps/hono` と `apps/nextjs` の `test-support` に依る

解析をパッケージに、表示を `apps/map` に置く分け方は、地図と同じである。

### データ

地図のデータに次を足す。

- `data/tests.json`：テストの索引。id、種類、対象、観点、結果の要約。期待結果と本文は含めない
- `data/tests/by-frame/<hash>.json`：フレーム（関数、エンドポイントの処理本体）ごとの、関連するテストの札の全文。テストのタブを開いたときに読む
- `data/tests/results.json`：最新の実行の結果とトレースの要約
- `data/tests/diff.json`：PR の地図の、テストの差分

テストの札は約 5,500 個あるので、索引を小さく保ち、全文はフレームごとに分けて読む。

### ワークフロー

いまは `ci.yml` がテストを走らせ、`map-preview.yml` が別に地図を作る。
地図にテストの結果とトレースを載せるには、テストの後に地図を作る必要がある。
そこで `map-preview.yml` のジョブを `ci.yml` に移し、`test` のジョブの後に `map` のジョブを置く。

1. `test`：`pnpm run test:ci` を `MARONN_TRACE=1` で走らせ、Vitest の JSON とトレースを artifact にする。E2E も同じジョブで、`apps/hono` を `--conditions=maronn-trace` で起動して走らせる
2. `map`：artifact を受け取り、`build:map` がテストカタログと差分も作る。デプロイとコメントはいまのまま
3. main への push：本番にデプロイし、`data/tests/results.json` を次の PR の基準にする

トレースを付けた実行は、関数の先頭に一文が増える分だけ遅くなる。
差し込みは `MARONN_TRACE=1` のときだけなので、手元の `pnpm test` は変わらない。

## 7. 使う道具

どれも OSS か無料である。

| 用途 | 道具 | 新規か |
|---|---|---|
| テストコードとケース定義の読み取り、差し込みの変換器 | TypeScript のコンパイラ API | 既存（`map-analysis` が使う） |
| ユニットと API のテストの実行、JSON レポーター、Vite のプラグイン、`setup` ファイル | Vitest 5 | 既存 |
| E2E の実行、JSON レポーター、fixtures | Playwright | 既存 |
| ケース定義の読み取り（行番号つきの誤り） | `yaml` | 新規（devDependency） |
| 語彙の穴の型と、JSON Schema の生成 | `zod`（`toJSONSchema`） | 新規（devDependency。依存の木にはすでにある） |
| ケース定義の編集の補完 | VS Code の YAML 拡張（JSON Schema を読む） | 任意 |
| リクエストごとの記録先 | `node:async_hooks` の `AsyncLocalStorage` | 標準 |
| 実行全体の行のカバレッジ（参考） | `@vitest/coverage-v8`、`c8` | 既存の設定にある |
| 画面 | React、Vite、Dagre、Shiki | 既存 |
| CI と artifact | GitHub Actions | 既存 |
| プレビューと本番、main の結果の置き場 | Cloudflare Workers（無料枠） | 既存 |
| 適合性の結果 | OIDF Conformance Suite の JSON | 既存 |

検討して採らなかったものは次のとおりである。

| 道具 | 採らない理由 |
|---|---|
| Allure Report | テストの結果に札（epic、feature）を付けて見られる OSS の報告書だが、関数カタログと木を知らないので、エンドポイントから関数への対応は作れない。結果の閲覧だけなら足せるが、地図と二つになる |
| cucumber-js（Gherkin） | 「Gherkin と Hurl を採らない理由」の項 |
| Hurl | 同上 |
| Codecov、SonarQube | 行のカバレッジの集計で、テストごとの対象と期待を持たない |
| Stryker（ミュテーションテスト） | 「テストが実際に振る舞いを固定しているか」の強い信号になるが、実行が重く、この設計の範囲の外に置く。後で「保証範囲」の一つの列として足せる |

## 8. 貢献者に課す規則

地図と同じく、課す規則は生成器が要るものに限る。

**課す規則**

- トップレベルの `describe` に関数名を書く（README の既存の規則）。ユニットテストの対象はこれで引く
- ケース定義には `id` を書き、語彙にある言い回しだけを使う。`pnpm cases:check` が検査する
- `// @test-id` で固定した id は一意にする。lint が検査する
- E2E の spec は `fixtures.ts` の `test` を使う。トレースのヘッダーを送るためで、lint が import を検査する

**あれば良くなるもの**

- `it` の直上の仕様コメント（既存の習慣）。無くても対象と期待結果は読める
- `// @aspect boundary` や `// @subject <id>` の宣言。語彙や静的な解決が外れたときの補正に使う
- API テストで、エンドポイントのパスを `TEST_ISSUER` との連結かリテラルで書くこと。動的に組み立てると静的には読めないが、トレースが補う

**課さない規則**

- 既存のテストの書き直し。読めないテストは「対象不明」「観点なし」として画面に出すだけである
- テストに手で関数の id やエンドポイントの id を書くこと。宣言は補正の手段であって、前提ではない
- 生成したテストコードのコミット

## 9. 進め方

前の段が後の段の土台になるよう、五段に分ける。

1. **テストカタログと結合**：テストコードの読み取り（種類、対象、観点、期待結果、id）、関数カタログとの結合、Vitest と Playwright の JSON の取り込み、エンドポイントの画面のテストのタブ、テストの一覧のページ。最優先の要件に、静的な根拠で答える
2. **関数トレースと不足**：変換器、Vitest のプラグイン、`apps/hono` の E2E の記録、到達の表示、不足の規則。ここで `ci.yml` に地図のジョブを移す
3. **テストの差分と PR のコメント**：変更前のカタログ、差分、`changes.frames` との突き合わせ、main の結果との比較、コメントの節
4. **ケース定義**：スキーマ、語彙の登録簿、Vitest のプラグイン、プロセス内と HTTP の実行器、検証。トークンエンドポイントの異常系をケース定義に書き写して、既存の API テストと同じ結果になることを確かめる
5. **残り**：Next.js のトレース、適合性スイートの結果の取り込み、仕様の節ごとの一覧（関数の `@spec` とテストの仕様コメントを節で結ぶ）

第 4 段は第 2 段と第 3 段に依らないので、人がいれば並行できる。
第 1 段が終わった時点で、`/token` のテストのタブに、API、E2E、ユニットの三種類が対象ごとに並ぶことを計測で確認する。

## 10. 決めずに残すこと

- 語彙を日本語で書くか英語で書くか。要件の例に合わせて日本語を正とし、英語の別名を登録簿で許す案で進めるが、既存のテストの名前は英語なので、画面の言葉の混在は残る
- Next.js の OP に差し込みを当てる方法（Webpack の `conditionNames` か Turbopack のローダーか）
- 「関連するテストに変更が無い」を CI で落とすかどうか。この設計ではコメントに出すだけにする
- 適合性スイートの module とエンドポイントの対応表を誰が保つか
- 名前の変更の対応づけの閾値（期待結果の 8 割）。実際の PR で測って決める
- トレースの決定（`if` の側）までの拡張
