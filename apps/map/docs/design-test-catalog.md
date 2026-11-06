# 設計案: テストの地図

テストの可視化、管理、自動化の要件を、このリポジトリの上でどう実現するかの設計案である。
実装はしていない。
既存の実装に合わせる前提は外し、必要なところは破壊的に変える。
使う道具は OSS か無料のものに限り、生成 AI には頼らない。

要件が最も重視する四つの項目に、この設計は次の仕組みで答える。

| 要件 | 仕組み | 節 |
|---|---|---|
| エンドポイントごとに、どんなテストが何を検証しているかを可視化する | テストカタログを関数カタログに結合し、地図のエンドポイントの画面に「テスト」の欄を足す | 1, 4 |
| エンドポイントが使う関数と、各関数のユニットテストの対応を可視化する | 対象の静的な解決（`describe` の名前と型）と、Istanbul の計測から取るテストごとの到達 | 1, 2 |
| 規則に基づく自然言語の記述からテストを機械的に作り、実行する | Gherkin と Cucumber Expressions による英語の閉じた語彙と、playwright-bdd による生成。日本語は訳の表から機械的に出す | 3 |
| PR で足した、変えた、消したテストと、関連する実装の変更を把握する | 変更前後のカタログの差分を地図の「届く経路」と突き合わせて PR のコメントに出し、結果とカバレッジは Codecov に任せる | 5 |

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

## 設計の前提と、自前にする境界

地図の設計（[design-change-trail-and-decision-cases.md](design-change-trail-and-decision-cases.md)）と同じ考え方を取る。
機械で計算できることは計算し、人に書かせるのは機械が計算できないことに限る。
貢献者に課す規則は、生成器が要るものに絞り、無くても地図が欠けたり CI が落ちたりしないようにする。

これに一つ加える。
自前で作るのは、関数カタログと処理の流れの木を知らないと作れないものに限り、それ以外は既製品に任せる。
自前のコンパイラや計測器は保守する人が自分たちしかおらず、既製品より依存として重いからである。
この線引きで、自前と既製品は次のように分かれる。

| 役割 | 担うもの | 理由 |
|---|---|---|
| テストが何を対象にし、何を期待しているかを読む | 自前（`packages/map-analysis` の解析器を広げる） | `describe` の名前を関数の id に引く規則と、`expect` を言葉にする規則はこのリポジトリ固有で、既製品に無い |
| エンドポイントから関数、ユニットテストへの木と、不足の表示 | 自前（`apps/map`） | 木と「外へ出る失敗」を知るのは地図だけである |
| テストごとに実際に通った関数と分岐 | Istanbul の計測（`@vitest/coverage-istanbul`、`nyc instrument`） | 計測器を自前で書く必要が無い。自前はテストごとの計数の差分を関数の id に対応づける部分だけ |
| 規則に基づく自然言語のテスト | Gherkin、Cucumber Expressions、playwright-bdd | 型付きの穴を持つ言い回しの照合、曖昧さの検出、日本語のキーワード、表形式の例、エディタの補完、レポートが揃っている。自前はステップ定義（語彙）だけで、これはどの方式でも要る |
| PR のカバレッジの変化と、テストの結果の変化 | Codecov（patch coverage と Test Analytics） | PR へのコメント、基準との比較、flaky の検出が付いてくる |
| PR で足した、変えた、消したテストと、変えた実装との対応 | 自前（カタログの差分と「届く経路」の結合） | 「変えた関数に関連するテストが変わっていない」は木を知らないと言えない |

テストの記述の言語は英語を正とする。
シナリオの名前、`it` の名前、ステップ、期待結果の言葉は英語で書き、日本語は訳があれば出す。
既存のテストの名前がすべて英語で、OAuth と OIDC の仕様の語（`invalid_client`、`grant_type`）も英語だからである。
地図の画面の枠（見出し、札、変更の要約の言い回し）は、いまの地図と同じく日本語のままにする。
訳の仕組みは「日本語への訳」の項で述べる。

残すものは次のとおりである。

- 関数カタログの id（`<root>:<module>#<name>`）と、エンドポイントの処理本体の id（`endpoint:<id>`）。テストの対象はこの id で指す
- `packages/map-analysis` の、TypeScript のコンパイラ API による読み取りと型による呼び先の解決。テストファイルも同じ解析器で読む
- PR の地図の、変更前後の比較と「届く経路」（`changes.frames[].reach`）。テストの差分はこの上に足す
- `map-preview.yml` の、PR ごとのプレビューと一つのコメントを書き換える仕組み。テストの節を同じコメントに足す
- 既存のテストの書き方。いまのテストを書き直さずに読めることを設計の条件にする

捨てるものは、テストの変更を数だけで扱う `otherFiles` と、地図のビルドとテストの実行が別のワークフローで独立に走る構成である（「データとビルド」の節）。

## 全体像

四つの柱で組み立てる。
**テストカタログ**がテストの表現、**テストごとの到達**が実行の記録、**機能ファイル**が規則に基づく記述、**テストの差分**が PR での変化の表現である。

```
  テストコード (*.test.ts, *.spec.ts)   機能ファイル (*.feature)
          │ 静的解析（コンパイラ API）          │ @cucumber/gherkin で読む
          ▼                                    ▼
  ┌──────────────── テストカタログ ────────────────┐
  │ テスト id、種類、対象（関数 / エンドポイント）、    │
  │ 観点、期待結果、仕様の節、リクエストの形            │
  └──────────────────┬─────────────────────────────┘
                     │ 結合（対象の id）
  関数カタログ ───────┤                ◄── 実行結果（Vitest / Playwright の JSON）
  エンドポイントと    │                ◄── テストごとの到達（Istanbul の計数の差分）
  処理の流れの木 ─────┤
                     ▼
        地図のデータ（map.json + tests/*.json）
                     │
        ┌────────────┼──────────────┐
        ▼            ▼              ▼
  エンドポイントの   関数のページの   このPRの変更の
  「テスト」の欄     「テスト」の欄   「テスト」の節と PR のコメント

  （PR のカバレッジの変化と結果の変化は Codecov が別に PR へコメントする）
```

カタログは静的解析だけで作れる。
実行結果と到達は、あれば結合して「実行されたか」「実際に通ったか」を足す。
無くても画面は欠けず、根拠の欄が「静的」のままになるだけである。

## 1. テストカタログ

テストカタログは、テストケース一つを一つの札にした索引である。
関数カタログが関数の札を持つのと同じ形で、テストの札を持つ。

```ts
interface TestCase {
  /** 安定な id（「テストの id」の項） */
  id: string;
  kind: 'unit' | 'api' | 'e2e' | 'conformance' | 'tool';
  /** テストコードか、機能ファイルか */
  source: { file: string; lines: [number, number]; form: 'code' | 'feature' };
  /** `it` の名前、またはシナリオの名前。英語で書かれる */
  title: string;
  /** 名前の日本語訳（`ja:` の行かコメント）。無ければ英語のまま出す */
  ja?: { title?: string };
  /** `describe` の連なり、または機能とシナリオアウトラインの名前 */
  path: string[];
  /** 何を検証するテストか（対象の項） */
  subjects: Subject[];
  /** 送るリクエスト（api と e2e） */
  requests?: RequestShape[];
  /** 正常系か異常系か。期待結果から決める */
  outcome: 'success' | 'failure' | 'unknown';
  /** 境界値、認証、認可、セキュリティなど（観点の項） */
  aspects: string[];
  /** 仕様の節（`it` の直上のコメント、機能ファイルの `@spec` タグ） */
  spec: string[];
  /** 期待結果（`expect` の構造、または `Then` のステップ） */
  assertions: Assertion[];
  /** 対象を決めた根拠 */
  evidence: Array<'declared' | 'static' | 'coverage'>;
}

type Subject =
  | { kind: 'function'; id: string; how: 'describe' | 'call' | 'coverage' }
  | { kind: 'endpoint'; id: string; source: 'hono' | 'nextjs'; how: 'request' | 'coverage' }
  | { kind: 'member'; id: string; how: 'coverage' };

interface Assertion {
  /** 検証した値を言葉にしたもの: `response.status`, `error`, `body.scope` */
  actual: string;
  matcher: string;
  /** リテラルで書かれた期待値。式なら undefined で、text に式を残す */
  expected?: unknown;
  negated?: boolean;
  mode?: 'resolves' | 'rejects';
  /** 画面に出す一行: `the HTTP status is 401` */
  text: string;
  /** 訳の表にある言い回しなら、その日本語: 「HTTP ステータスが 401 である」 */
  ja?: string;
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
| `e2e` | `tests/e2e/specs/` の Playwright のテストと、機能ファイルのうち HTTP の実行先で走るもの。動いている OP に HTTP とブラウザで到達する |
| `api` | `apps/*` のテストのうち、エンドポイントのパスへリクエストを送るもの（`app.request()`、Next.js の Route Handler に `Request` を渡すもの）と、機能ファイルのうちプロセス内の実行先で走るもの。要件の「API テスト」と「統合テスト」はこの一つにまとめる。どちらもプロセス内で HTTP の形を取り、区別する根拠がコードに無いからである |
| `unit` | `packages/*` と `apps/*` のテストのうち、対象が関数カタログの関数で、リクエストを送らないもの |
| `conformance` | `tests/conformance` の OIDF 適合性スイートの module。結果だけを取り込む（「実行結果」の項） |
| `tool` | CLI、地図、解析パッケージ、`.github/scripts` のテスト。一覧には出すが、エンドポイントの地図には載せない |

### 対象の解決

テストが何を検証しているかは、三つの根拠で決め、根拠の種類をテストの札に残す。

**宣言**（`declared`）は、人が書いた対象である。
機能ファイルの `@endpoint:token` や `@function:verifyClientSecret` のタグと、テストコードの `// @subject` コメントがこれに当たる。
あれば最も強く、静的な解決より優先する。

**静的**（`static`）は、テストコードを読んで決めた対象である。
規則は種類ごとに次のとおりで、どれもコンパイラ API で決定論的に読む。

- ユニットテスト：トップレベルの `describe` の名前を、そのファイルの import から型で引き、関数カタログの id にする。`describe('authenticateTokenClient')` が `hono:endpoints/token/steps/authenticate-client.ts#authenticateTokenClient` になる。名前が関数に引けなければ「対象不明」として一覧に出す
- ステップのテスト：関数が解決できれば、ステップの `meta`（`function: 'authenticateTokenClient'`）を通ってエンドポイントとステップにも結びつく
- API テスト：`it` の本体と、同じファイルのヘルパー関数の中で送るリクエスト（`app.request(url, init)`、Route Handler の呼び出し）の URL の末尾の固定部分（`${TEST_ISSUER}/token` の `/token`）を、エンドポイントのパスと照合する。メソッドは `init.method` のリテラルから取る。複数のエンドポイントへ送るテストは、その全部を対象にする
- E2E テスト：`request.get()` / `request.post()` / `page.goto()` の URL と、`toHaveURL()` が期待する URL を同じ規則で読む。ブラウザのリダイレクトで通るエンドポイント（`/authorize` から `/login` へ）は静的には読めないので、到達の記録に任せる
- `it` の本体が直接呼ぶ関数カタログの関数も、`how: 'call'` の対象として持つ。`describe` の名前と違う関数を呼ぶテストや、`describe` の無いテストの受け皿である

**到達**（`coverage`）は、実行時に実際に通った関数とエンドポイントである（「テストごとの到達」の節）。
静的な対象と一致すれば根拠が二つになり、静的に読めなかった到達（リダイレクト、resolver や store の実装）は到達の記録だけが与える。

### 正常系、異常系、境界値

正常系か異常系かは、期待結果から決める。
`rejects`、`toThrow`、400 以上のステータス、`error` キーの期待のどれかがあれば異常系、`resolves` や 2xx のステータスや値の一致だけなら正常系である。
期待結果が読めないテストは `unknown` にし、一覧に出す。
この規則は語彙に頼らないので、既存のテストにそのまま効く。
機能ファイルでは、`Then` のステップが使うステップ定義に、正常と異常のどちらの期待かを付けておく（`the HTTP status is {int}` は値で決め、`the error code is {string}` は異常）。

境界値、認証、認可、セキュリティなどの観点は、正常か異常かとは別の軸として持つ（`aspects`）。
境界値のテストは正常系のこともあれば異常系のこともあるからである。
観点は次の順で決める。

1. 機能ファイルのタグ（`@boundary`、`@auth`）と、テストコードの `// @aspect boundary` コメント（宣言）
2. 語彙の表（`tests/catalog/aspects.yaml`）。`it` の名前と `describe` の名前に、表の語（`exactly`、`at the limit`、`boundary`、`expired`、`maximum`、`empty`、`one more`）が含まれれば境界値、`invalid_client`、401、`WWW-Authenticate` の期待があれば認証、`insufficient_scope`、403、`access_denied` なら認可、と表が定める
3. どれにも当たらなければ観点なし

語彙による分類は規則であって推論ではないが、表に無い言い回しは拾えない。
そのため、表はコミットされた文書にし、拾えなかったテストを「観点なし」として画面に出して、表を直すか宣言を足すかを人が選べるようにする。

### 期待結果

`expect(actual).matcher(expected)` の形を構造として読み、言葉にする。
`await expect(...).resolves` / `.rejects` / `.not` も読む。

| コード | 言葉（正） | 日本語訳 |
|---|---|---|
| `expect(response.status).toBe(401)` | the HTTP status is 401 | HTTP ステータスが 401 である |
| `.rejects.toMatchObject({ error: 'invalid_client' })` | fails with `invalid_client` | `invalid_client` で失敗する |
| `expect(response.headers.get('Cache-Control')).toBe('no-store')` | the `Cache-Control` header is `no-store` | `Cache-Control` ヘッダーが `no-store` である |
| `expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 })` | the body has `token_type` `Bearer` and `expires_in` 3600 | ボディの `token_type` が `Bearer`、`expires_in` が 3600 である |
| `await expect(page).toHaveURL(/\/consent$/)` | the URL ends with `/consent` | URL が `/consent` で終わる |

期待値がリテラルでない（変数や関数の結果）ときは、式をそのまま残す。
言葉にする規則は表（`words.ts` と同じ考え）に置き、新しいマッチャーは表に足す。
表の言い回しは、同じことを確かめるステップ定義があればその式にそろえる（`the HTTP status is {int}`）。
そろえておけば、テストコードの期待結果と機能ファイルのステップが一つの訳の表を共有する。
機能ファイルの `Then` のステップは、すでに言葉なのでそのまま札に入れる。

エラーコードの期待（`error: 'invalid_client'`、`TokenError(invalid_grant)`）は、地図が木から求める「外へ出る失敗」（`FunctionEntry.failures`）と同じ語彙になるので、「不足」の計算に使う（「エンドポイントの画面」の節）。

### リクエストの形

API と E2E のテストは、送るリクエストの形も札に持つ。
ボディが `new URLSearchParams({ grant_type: 'authorization_code', code: 'code-1', ... })` のようなリテラルなら、キーの一覧を取る。
`Authorization` ヘッダーの作り方（`basicAuthorization()`）から認証の方式を読む。
機能ファイルでは `When` のステップの表から取る。
これで、エンドポイントの画面に「どの入力で、何を期待したか」の表が作れる。

### テストの id

id は、ファイルの移動で変わらず、同じテストを二つのビルドで同じ id にする。

- テストコードのテストは、`<root> | describe の連なり | it の名前` のハッシュを id にする。root（core、hono、nextjs、e2e）はファイルを動かしても変わらず、トップレベルの `describe` は関数名なので、ファイルの分割や移動で id は変わらない。名前を変えると id は変わるが、PR の差分が「名前を変えた」として対応づける（「テストの差分」の節）
- 機能ファイルのシナリオは、`@id:token-invalid-client-secret` のタグをそのまま使う。シナリオアウトラインの例の行は、タグに行の番号を足す。重複は lint で落とす
- 名前に頼らず固定したいテストコードのテストは、`it` の直上に `// @test-id token-invalid-client-secret` と書く。lint が重複を検査する

同じ root で `describe` の連なりと名前が重なるテストは、ビルドが警告し、ファイル名を足した id にする。

## 2. 実行結果とテストごとの到達

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
Playwright も同じで、機能ファイルから生成したテストは `@id` のタグが Playwright のタグとして残る。
再試行（Playwright の `retries`）は最後の結果を採り、試行回数を残す。

同じ実行で JUnit XML も書き、Codecov の Test Analytics に上げる（「PR でのテストの差分」の節）。

適合性スイートの結果は、runner スクリプトが出す JSON（module の名前と結果）を読み、module の名前からエンドポイントへの対応表（`tests/conformance/modules.yaml`、人が書く固定の表）で結びつける。
スイートは Docker と外部のテストプランに依るので、結果が無いときは「未実行」と示すだけにする。

### テストごとの到達

到達の記録は、テストごとに実際に通った関数カタログの関数と、通ったエンドポイントの列である。
計測は Istanbul に任せ、自前で書くのはテストごとの差分を取って関数の id に対応づける部分だけにする。

Istanbul の計測は、関数ごと、文ごと、分岐ごとの計数をプロセスのグローバルなオブジェクトに置く。
その計数を一つのテストの前後で比べれば、そのテストが通った関数と分岐が分かる。
これは計測器の仕組みをそのまま使うもので、新しい変換器も、リクエストにテストの id を載せるヘッダーも要らない。

- Vitest：`coverage.provider` を `istanbul` にし、到達を取る実行（`MARONN_REACH=1`）でだけ `coverage.enabled` にする。`coverage.include` は関数カタログの根に限る。`setup` ファイルの `beforeEach` で計数の写しを取り、`afterEach` で差分（計数が増えた関数と分岐）をテストの id と共にワーカーごとの JSONL に書く。計数を置くグローバルの名前はプロバイダーの定数で（Vitest 5 では `__VITEST_COVERAGE__`）、版で変わりうるので実装時に確かめる。Vitest はテストを順に走らせるので（`concurrent` を使っていない）、差分が混ざらない
- E2E の OP：`apps/hono` と各パッケージをビルドした `dist/` を、`nyc instrument` で計測つきに書き換えて起動する。CI ではその場で書き換え（`--in-place`）、手元では別のディレクトリに出す。計測は `globalThis.__coverage__` に計数を置く。`server.ts`（CLI が抽出する根の外）が `MARONN_REACH=1` のときだけ `POST /__coverage__/reset` と `GET /__coverage__` を足し、Playwright の fixture がテストの前に reset を、後に GET を呼んで、そのテストの計数を JSONL に書く。E2E は順に走る（`fullyParallel: false`）ので、テストの間の計数は混ざらない

通ったエンドポイントの列は、二つの標準の記録から作る。
ブラウザが通ったリクエスト（リダイレクトを含む）は Playwright の `page.on('request')` と `page.on('response')` で、`request` fixture の呼び出しは fixture を包んで記録する。
E2E 用の RP（`tests/e2e/apps/client.mjs`）が裏で叩く `/token` と `/userinfo` はブラウザには見えないので、OP のアクセスログ（`hono/logger` を `MARONN_REACH=1` のときにファイルへ出す）を、テストの開始と終了の時刻で切って足す。
時刻で切れるのは、E2E が順に走るからである。

計数から関数の id への対応づけは、Istanbul の `fnMap`（関数の名前と宣言の位置）を関数カタログの札（ファイルと宣言の行）に引いて行う。
名前のある関数はファイルと名前で、エンドポイントの処理本体のような無名の関数はファイルと宣言の行で引く。
位置はソースマップで元の行に戻す（`istanbul-lib-source-maps`）。
分岐の計数（`branchMap`）は、木の決定のノード（`if`、`switch`、`cond-expr`）の行と引けるので、「この決定のこの側を通ったテスト」も同じ記録から求まる。
この設計では関数の到達までを範囲にし、決定の側の到達は後で足す。

```ts
interface ReachRecord {
  test: string;
  /** どの OP か（hono, nextjs）。Vitest のユニットテストでは無い */
  target?: string;
  /** 通った関数と interface のメンバーの実装、id で */
  functions: string[];
  /** 通った決定の側、`<frame>.<node>:<side>` で（後の段で足す） */
  branches?: string[];
  /** E2E と API: リクエストの順に */
  requests?: Array<{ endpoint: string; method: string; status: number; error?: string }>;
}
```

到達の記録は次のことを与える。

- テストから関数へ：そのテストが実際に通った関数。ユニットテストなら `describe` の対象の下で何を通ったか、API テストならどのステップで止まったか（`invalid_client` のケースは `authenticate-client` の後を通らない）
- 関数からテストへ：その関数を通ったテストの一覧。`describe` が名指すユニットテストと、上から届く API と E2E のテストを分けて出せる
- E2E からエンドポイントへ：一つのテストが通ったエンドポイントの列（`/authorize` → `/login` → `/consent` → `/token` → `/userinfo`）。要件の「エンドポイントを利用する一連の処理フロー」はこれで描く
- 到達していない場所：どのテストも通らない関数、ステップ、エンドポイント

計測つきの `dist/` が生成物や公開物に混ざることはない。
CLI のテンプレートは `pnpm run build` が `src` から作り、npm への publish は release のワークフローが別にビルドする。
念のため、テンプレートに `__coverage__` が含まれないことをテストで確かめる。

Next.js の OP は、サーバーのコードを Next.js 側がバンドルするので、`dist/` の書き換えだけでは `app/` の関数が計測に入らない。
`swc-plugin-coverage-instrument` か `babel-plugin-istanbul` を `next build` に当てる案があるが、この設計では決めない。
決まるまでの Next.js の到達は、`NODE_V8_COVERAGE` によるプロセス単位の V8 カバレッジ（`c8` でソースマップを戻す）で、テストごとでなく実行全体で求める。

### 行のカバレッジとの関係

同じ計測から、実行全体の行のカバレッジ（lcov）も出る。
これは Codecov に上げ、PR のコメントに patch coverage として出す（「PR でのテストの差分」の節）。
地図はテストごとの到達を関数と決定の単位で見せ、行の割合は Codecov に任せる。

## 3. 規則に基づく自然言語のテスト定義

機能ファイルは、Gherkin で書くテストである。
人が読める英語で前提条件、操作、期待結果を書き、playwright-bdd が Playwright のテストに生成する。
言い回しは Cucumber Expressions で定義し、定義済みのものだけを受け付ける。
日本語は、英語の言い回しから訳の表で機械的に出す（「日本語への訳」の項）。

### 記述例

要件の例を英語で書くと、次のようになる。

```gherkin
@endpoint:token
Feature: Client authentication at the token endpoint
  ja: トークンエンドポイントのクライアント認証

  Background:
    Given a registered confidential client:
      | client_id | secret   | redirect_uri                    |
      | client-1  | secret-1 | https://rp.example.com/callback |
    And the client "client-1" has the authorization code "code-1"

  @id:token-invalid-client-secret @spec:RFC6749-5.2 @spec:OAuth2.1-2.3 @auth @hono @nextjs
  Scenario: Reject invalid client credentials with invalid_client
    ja: 無効なクライアント認証情報を invalid_client で拒否する
    Given the client "client-1" presents invalid credentials
    When the client requests the token endpoint with grant_type "authorization_code":
      | code   | redirect_uri                    |
      | code-1 | https://rp.example.com/callback |
    Then the HTTP status is 401
    And the error code is "invalid_client"
    And the WWW-Authenticate header starts with "Basic"
    And the authorization code "code-1" is not consumed

  @id:token-missing-required-parameter @spec:RFC6749-5.2 @hono @nextjs
  Scenario Outline: Reject a request without <param> with invalid_request
    When the client requests the token endpoint with grant_type "authorization_code" without <param>
    Then the HTTP status is 400
    And the error code is "invalid_request"

    Examples:
      | param        |
      | code         |
      | redirect_uri |
```

`ja:` の行は Gherkin の説明（キーワードの行の後の自由な行）で、runner は読まない。
書くかどうかは任意で、二つ目のシナリオのように無ければ英語の名前をそのまま出す。

複数のエンドポイントをまたぐシナリオも同じ形で書き、HTTP の実行先（`@http`）で走らせる。

```gherkin
@scenario:authorization-code-flow
Feature: Authorization code flow

  @id:auth-code-flow-online-refresh @spec:OIDC-Core-11 @http
  Scenario: Return a refresh token bound to the login session without offline_access
    Given the user "testuser" can log in with the password "password"
    When the client "e2e-client" sends an authorization request with scope "openid profile"
    And the user logs in on the login page as "testuser" with the password "password"
    And the user approves on the consent page
    And the client redeems the authorization code for tokens
    Then the HTTP status is 200
    And the body has a refresh_token
    And the length of refresh_token is 43
```

要件の 4.2 の項目は、Gherkin の要素にそのまま対応する。

| 要件の項目 | Gherkin |
|---|---|
| テスト対象 | `Feature` のタグ（`@endpoint:token`、`@function:verifyClientSecret`、`@scenario:...`） |
| テストの目的 | `Scenario` の名前 |
| 前提条件 | `Given` と `Background` |
| 入力データ | ステップの表（データテーブル）と、`Scenario Outline` の `Examples` |
| 実行する操作 | `When` |
| 期待する振る舞い、期待する結果 | `Then` |
| エラー時の振る舞い | `Then` の失敗の言い回し（`the error code is {string}`） |
| 後処理 | ステップ定義の `After` フック。シナリオごとにストアを捨てるので、機能ファイルには書かない |
| 識別子、仕様、観点、実行先 | タグ（`@id:`、`@spec:`、`@auth` `@boundary`、`@hono` `@nextjs` `@http`） |

### 閉じた語彙

Gherkin のステップの文は自由に書けるが、文に対応するステップ定義が無ければ実行できない。
この設計では、ステップ定義を次の形に限って、語彙を閉じる。

- ステップ定義は Cucumber Expressions で書き、正規表現を使わない。lint（`tests/steps/` の小さな検査）が `Given(/.../)` の形を落とす
- Cucumber Expressions は、穴（`{int}`、`{string}`、`{word}`、`defineParameterType` で定義した型）を除いて文と一字一句一致する。二つの定義が同じ文に一致すると「ambiguous」として落ちる。`bddgen` の生成時と `cucumber-js --dry-run` が、実行せずに未定義と曖昧なステップを報告する
- 表記ゆれを許したいときは、定義に別名を足す（`a/b` の選択肢、`(s)` の任意の語）。暗黙の照合はしない
- 式は英語で書く。lint が、穴の外に ASCII でない文字を含む式を落とす。語彙を一つの言語に保てば、同じ振る舞いの言い回しが英語と日本語の二つに割れず、訳の表も英語から日本語への一方向で済む

```ts
import { createBdd } from 'playwright-bdd';
const { Given, When, Then } = createBdd(test);

Then('the HTTP status is {int}', async ({ run }, status: number) => {
  expect(run.response.status).toBe(status);
});

Given('a registered confidential client:', async ({ run }, table: DataTable) => {
  for (const row of table.hashes()) await registerClient(run.db, confidentialClient(row));
});
```

ステップ定義は `tests/steps/` に置き、`apps/hono` と `apps/nextjs` の `test-support` のヘルパー（`providerApp()`、`registerClient()`）を使う。
一つの定義は、プロセス内と HTTP のどちらの実行先で使えるかを fixture で宣言し、対応の無い実行先のシナリオは生成時に落ちる。

### 生成と実行

playwright-bdd の `bddgen` が、機能ファイルから Playwright のテストを生成する。
生成したファイルはコミットせず、`.features-gen/` に置いて実行のたびに作り直す。
コミットすると定義と二重になり、どちらが正か分からなくなるからである。

実行先は Playwright の project で分ける。

- **プロセス内**（`in-process-hono`、`in-process-nextjs`）：ブラウザを使わず、`createApp()` をメモリの DB で立てて `app.request()` で叩く、または Route Handler に `Request` を渡す。既存の API テストと同じ形である。`@hono` と `@nextjs` のタグで選ぶ
- **HTTP**（`http`）：動いている OP に `request` とブラウザで到達する。既存の E2E と同じ `playwright.config.ts` の `webServer` を使う。前提条件は環境変数と運用者の API で用意できるものに限る

Playwright の runner を使うのは、Vitest に Gherkin を載せる OSS（`@amiceli/vitest-cucumber`）が若く、cucumber-js を足すと runner が三つになるからである。
同じ機能ファイルをプロセス内と HTTP の両方で走らせられるので、プロセス内で確かめた振る舞いが生成物の OP でも同じかを、定義を書き直さずに確かめられる。

### 検証と編集

- 機能ファイルの形は `gherkin-lint` で検査する。`@id` と対象のタグの必須、シナリオの名前の重複、未使用の背景を規則にする
- ステップの未定義と曖昧さは `bddgen` が落とす。`pnpm run lint` に入れる
- 編集は VS Code の Cucumber の拡張（公式の `cucumber-official`）が、ステップ定義から言い回しを補完する。語彙の一覧は、ステップ定義から `cucumber-js --format usage` で出す

### 日本語への訳

日本語は、英語の記述から機械的に組み立てる。
訳を書く人がいなくても英語で読め、訳があるところだけ日本語になる。
訳す部分は三つで、どれも決定論的に置き換える。

- **キーワード**：`Feature`、`Scenario`、`Given`、`When`、`Then`、`And` などは、`@cucumber/gherkin` が持つ言語の辞書（`gherkin-languages.json`）の日本語にする（機能、シナリオ、前提、もし、ならば、かつ）。辞書に別名が複数ある語は、表示に使う一つを固定する
- **ステップと期待結果**：訳の表（`tests/steps/ja.yaml`）が、ステップ定義の式を日本語のひな形に対応づける。ステップの文はちょうど一つの式に一致し、一致すると穴の値が取れるので、その値をひな形に入れる。日本語の語順は英語と違うので、ひな形は穴を `{0}` `{1}` の番号で指す。テストコードの期待結果の言い回し（「期待結果」の項）も、同じ表で訳す
- **名前**：機能とシナリオの名前は自由な文なので、表では訳せない。キーワードの次の行に `ja:` で書いた説明を訳として使う。テストコードの `it` の名前は、直上の `// ja: ...` コメントを訳として使う。どちらも任意である

```yaml
# tests/steps/ja.yaml
'the HTTP status is {int}': 'HTTP ステータスが {0} である'
'the error code is {string}': 'エラーコードが {0} である'
'the client {string} has the authorization code {string}': 'クライアント {0} の認可コード {1} が保存されている'
'the client {string} presents invalid credentials': 'クライアント {0} が無効な認証情報を提示する'
'the client requests the token endpoint with grant_type {string}:': 'トークンエンドポイントに grant_type {0} でリクエストする:'
```

記述例の一つ目のシナリオは、この表で次のように出る。

```
機能: トークンエンドポイントのクライアント認証
  シナリオ: 無効なクライアント認証情報を invalid_client で拒否する
    前提 クライアント "client-1" が無効な認証情報を提示する
    もし トークンエンドポイントに grant_type "authorization_code" でリクエストする:
      | code   | redirect_uri                    |
      | code-1 | https://rp.example.com/callback |
    ならば HTTP ステータスが 401 である
    かつ エラーコードが "invalid_client" である
    かつ the WWW-Authenticate header starts with "Basic"      ← 表に訳が無い言い回しは英語のまま
    かつ the authorization code "code-1" is not consumed
```

表の行と列の名前（`client_id`、`grant_type`）は仕様の語なので訳さない。
訳の表に無い式と `ja:` の無い名前は、英語のまま出し、英語であることを画面で示す。

訳の表は lint で検査する。
キーがどれかのステップ定義の式か期待結果の言い回しであること、ひな形の番号が穴の数の範囲にあり、すべての穴を一度ずつ使うことを確かめる。
訳の欠けは CI を落とさず、テストの一覧のページに「日本語の訳が無い言い回し」の数として出す。
訳は望ましいが、無くてもテストの意味は英語で読めるからである。

### カタログとの関係

機能ファイルはカタログに最も良い札を与える。
対象、観点、仕様はタグに、入力は表に、期待結果は `Then` のステップにあり、`@cucumber/gherkin` の parser で構造のまま読める。
既存のテストコードは書き直さず、新しいテストは機能ファイルで書くことを勧める。
ただし強制はしない。
語彙に無い振る舞いを確かめるテストは、コードで書いて語彙を後から足せばよい。

## 4. エンドポイントの画面

エンドポイントの画面（トレース）の右の欄に、図、差分、詳細と並べて「テスト」のタブを足す。
左の一覧のエンドポイントには、テストの数と最新の結果の札を付ける。

### テストのタブ

図が見せているフレームについて、次を出す。
根のフレーム（エンドポイント）なら、そのエンドポイントのテスト全体である。

```
POST /token                                テスト 212（API 41 / E2E 23 / ユニット 148）   最新: 全て成功（hono, nextjs）
正常系 61 / 異常系 149 / 境界値 4 / 認証 23      根拠: 静的 212、到達 198

不足
  - 外へ出る失敗 TokenError(invalid_target) を検証するテストが無い
  - resolveTokenAcrAmr() にユニットテストが無い（到達するテスト 12）
  - 境界値のテストが無いステップ: select-signing-keys, issue-refresh-token

API テスト（apps/hono/.../token/pipeline.test.ts、tests/features/token/*.feature）
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
機能ファイルのシナリオは、Gherkin をそのまま出す。
タブの上の「English / 日本語」で、テストの記述（名前、ステップ、期待結果）を英語か日本語訳に切り替える。
訳の無い部分は英語のまま出し、選んだ表示は「言葉 / コード」と同じくこのブラウザに残す。

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
行は、API テストと機能ファイルのリクエストの形と期待結果から作る。
列の「失敗」は、地図が木から求めた外へ出る失敗（`endpoint:token` の `failures`）で、それを期待するテストがあるかを横に付ける。
これで「このエンドポイントで何をテストしているか」と「何が起こりうるのに検証していないか」が一つの表になる。

### 不足の規則

不足は、推論ではなく次の規則で求める。

- 関数カタログの関数で、`describe` が名指すユニットテストが無く、どのテストの到達にも現れないもの
- フレームから外へ出る失敗（`failures`）のうち、そのフレームか上のフレームを対象とするテストの期待に、そのエラーが無いもの
- エンドポイントのステップのうち、どのテストも到達していないもの（到達の記録があるときだけ）
- 観点の軸で、エンドポイントに境界値のテストが無い、認証のテストが無いなど。どの観点を求めるかは `aspects.yaml` に書く
- 機能（`MapFeature`）のうち、E2E のテストがそのエンドポイントを通らないもの

一覧のページ（`#tests`）に、エンドポイントごと、機能ごと、種類ごとの数と、不足をまとめて並べる。
要件 2.1 の「テストの全体像」はこのページである。

## 5. PR でのテストの差分

PR で変わったものは三種類あり、担うものを分ける。
カバレッジの変化と結果の変化は Codecov が、テストの札の差分と実装の変更との対応は地図が担う。

### Codecov に任せるもの

- **patch coverage**：Vitest と E2E の lcov を `codecov/codecov-action` で上げる。PR のコメントに、変えた行のうちテストが通った割合と、通っていない行が出る。要件 5.2 の「実装が変更されたのに、テストが通っていない」の行の単位の答えである。Vitest と E2E は flag で分け、どちらが通したかを見分ける
- **Test Analytics**：JUnit XML を `codecov/test-results-action` で上げる。PR のコメントに失敗したテスト、新しく失敗したテスト、flaky なテストが出る。main との比較を Codecov が持つので、基準の結果を自前で置く必要が無い

公開リポジトリは無料で、アップロードにはリポジトリのトークンが要る。
fork からの PR はトークンが無いので上がらないが、これは地図のプレビューと同じ制限である。

### 地図が出すもの

PR の地図は、変更前のコードからも木を作って差分を取る。
同じように、変更前のテストカタログも作り、テストの差分を取る。

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
}
```

変えたテストの中身は、期待結果の構造の差分で示す。
足した期待、消した期待、値を変えた期待（`the HTTP status is 400` → `the HTTP status is 401`）である。
本体だけ変えて期待結果の変わらないテストは `body` とし、hunk を添える。

地図はすでに、PR が変えた関数とエンドポイントの処理本体（`changes.frames`）と、それが届くエンドポイント（`reach`）を持つ。
テストの差分はこれに次を足す。

- 変えたフレームごとの関連するテスト（`describe` が名指すもの、到達するもの）と、そのうち PR が触ったもの
- 変えたフレームのうち、関連するテストに変更が無いもの。要件 5.2 の「実装が変更されたにもかかわらず、関連テストに変更がない箇所」である。コメントや書き方だけの変更（木が同じ）は対象にしない。Codecov の patch coverage が「通ったか」を行で答えるのに対し、これは「そのテストの期待が変わったか」を答える
- 新しく外へ出る失敗（`failuresAdded`）で、どのテストも期待していないもの
- 関連するテストの観点と期待するエラーの集合が、変更前後でどう変わったか（保証範囲の変化）

### PR のコメント

いまの地図のコメント（`<!-- oidc-provider-map-preview -->` の一つ）に「テスト」の節を足す。
要件 5.3 の例に合わせる。

```
## テスト

テストケース: 5,521 → 5,527（+6）  API +3、ユニット +3

変更対象: POST /token（hono, nextjs）
  追加されたテスト:
    - Reject invalid client credentials with invalid_client（API, 異常系, 認証）
    - Reject an unsupported grant_type with unsupported_grant_type（API, 異常系）
    - Reject a request without <param> with invalid_request（API, 異常系, 2 行）
  関連する変更関数:
    - validateClientAuthMethod: ユニット 追加 2
    - validateTokenGrantType: ユニット 変更 1（期待 the HTTP status is 400 → the HTTP status is 401）

関連テストに変更の無い実装の変更:
  - verifyClientSecret（条件 `secret.length < 8` を足した）: 関連するテスト 5 件、変更なし
  - 新しく外へ出る失敗 TokenError(invalid_client, "secret too short") を期待するテストが無い

結果とカバレッジの変化は Codecov のコメントを参照
```

数と名前は例である。
テストの記述は英語のまま載せ、枠の言葉は地図のコメントに合わせて日本語にする。
PR には地図と Codecov の二つのコメントが付く。
一つにまとめるには Codecov の API から読んで地図のコメントに引く手があるが、まずは二つのままにする。

CI を落とすかどうかは、地図の方針と同じく限定する。
機能ファイルの lint、ステップの未定義と曖昧さ、テストの id の重複は落とす。
「関連するテストに変更が無い」と「新しい失敗を期待するテストが無い」は、コメントに出すだけにする。
テストを足すかどうかは変更の性質によるので、機械で一律に求めると形骸化するからである。
patch coverage の閾値で落とすかは Codecov の設定（`codecov.yml`）で決められるので、地図の検査とは独立に後で選べる。

## 6. データとビルド

### パッケージとディレクトリ

- `packages/test-catalog`（非公開）：テストコードの読み取り（コンパイラ API）、機能ファイルの読み取り（`@cucumber/gherkin`）、実行結果と到達の取り込み（Istanbul の計数から関数の id への対応づけを含む）、テストの差分。`packages/map-analysis` に依り、関数カタログの id と木を使う
- `apps/map`：テストのタブ、テストの一覧のページ、このPRの変更のテストの節
- `tests/features/`：機能ファイル。エンドポイントごとのディレクトリ
- `tests/steps/`：英語の式のステップ定義と、日本語の訳の表（`ja.yaml`）。ステップ定義は `apps/hono` と `apps/nextjs` の `test-support` に依る
- `tests/e2e/fixtures.ts`：到達の記録（`/__coverage__`、リクエストの記録）を足した `test`。既存の spec と生成したテストの両方が使う
- `apps/hono/src/server.ts` と Vitest の `setup` ファイル：到達の記録の数十行。CLI が抽出する根の外に置く

解析をパッケージに、表示を `apps/map` に置く分け方は、地図と同じである。
実行時の計測器は持たない。

### データ

地図のデータに次を足す。

- `data/tests.json`：テストの索引。id、種類、対象、観点、結果の要約。期待結果と本文は含めない
- `data/tests/by-frame/<hash>.json`：フレーム（関数、エンドポイントの処理本体）ごとの、関連するテストの札の全文。テストのタブを開いたときに読む
- `data/tests/results.json`：最新の実行の結果と到達の要約
- `data/tests/diff.json`：PR の地図の、テストの差分

テストの札は約 5,500 個あるので、索引を小さく保ち、全文はフレームごとに分けて読む。

### ワークフロー

いまは `ci.yml` がテストを走らせ、`map-preview.yml` が別に地図を作る。
地図にテストの結果と到達を載せるには、テストの後に地図を作る必要がある。
そこで `map-preview.yml` のジョブを `ci.yml` に移し、`test` のジョブの後に `map` のジョブを置く。

1. `test`：`pnpm run test:ci` を `MARONN_REACH=1` で走らせ、Vitest の JSON、JUnit、lcov、到達の JSONL を artifact にする。E2E も同じジョブで、計測つきの `dist/` から `apps/hono` を起動して走らせる。lcov と JUnit は Codecov に上げる
2. `map`：artifact を受け取り、`build:map` がテストカタログと差分も作る。デプロイとコメントはいまのまま
3. main への push：本番にデプロイする。結果の基準は Codecov が持つので、地図は置かない

計測つきの実行は遅くなる。
`MARONN_REACH=1` のときだけ計測するので、手元の `pnpm test` は変わらない。

## 7. 使う道具

どれも OSS か無料である。

| 用途 | 道具 | 新規か |
|---|---|---|
| テストコードの読み取り | TypeScript のコンパイラ API | 既存（`map-analysis` が使う） |
| ユニットと API のテストの実行、JSON と JUnit のレポーター、`setup` ファイル | Vitest 5 | 既存 |
| E2E の実行、JSON と JUnit のレポーター、fixtures、リクエストの記録 | Playwright | 既存 |
| テストごとの到達の計測 | `@vitest/coverage-istanbul`、`nyc`（`nyc instrument`）、`istanbul-lib-source-maps` | 新規（devDependency） |
| 機能ファイルの読み取りと検査、日本語のキーワード | `@cucumber/gherkin`（言語の辞書を含む）、`gherkin-lint` | 新規（devDependency） |
| 観点の表、適合性の対応表、日本語の訳の表の読み取り | `yaml` | 新規（devDependency） |
| 機能ファイルから Playwright のテストの生成、Cucumber Expressions | `playwright-bdd`（`@cucumber/cucumber-expressions` を含む） | 新規（devDependency） |
| 機能ファイルの編集の補完 | VS Code の Cucumber の拡張 | 任意 |
| PR のカバレッジの変化、結果の変化、flaky | Codecov（`codecov-action`、`test-results-action`） | 新規（無料、トークンをシークレットに置く） |
| Next.js の実行全体のカバレッジ（当面） | `c8`、`NODE_V8_COVERAGE` | 新規（devDependency） |
| 画面 | React、Vite、Dagre、Shiki | 既存 |
| CI と artifact | GitHub Actions | 既存 |
| プレビューと本番 | Cloudflare Workers（無料枠） | 既存 |
| 適合性の結果 | OIDF Conformance Suite の JSON | 既存 |

検討して採らなかったものは次のとおりである。

| 道具 | 採らない理由 |
|---|---|
| Allure Report | テストの結果に札（epic、feature）を付けて見られる OSS の報告書で、札はカタログから自動で付けられる。しかし関数カタログと木を知らないので、エンドポイントから関数への木と不足は描けず、地図のタブと二重になる。履歴と傾向が欲しくなったら、カタログから札を付けて足せる |
| cucumber-js を runner にする | Vitest と Playwright に加えて三つ目の runner になる。playwright-bdd で Playwright に載せる方が、レポーターと fixture を共有できる |
| `@amiceli/vitest-cucumber` | Vitest に Gherkin を載せるが、若く、Cucumber Expressions の照合と曖昧さの検出を自前で確かめる必要がある |
| YAML の独自のケース定義 | この設計の前の版で採っていた。閉じた語彙の照合器、コンパイラ、スキーマ、エディタの補完を自前で持つことになり、Cucumber Expressions と playwright-bdd で同じ性質が得られる |
| 関数の先頭に印を差し込む自前の変換器 | 同じく前の版。Istanbul の計測の差分で代えられ、分岐の到達も付いてくる |
| Coveralls | Codecov と同等。Test Analytics に当たるものが無いので Codecov を選ぶ |
| Stryker（ミュテーションテスト） | 「テストが実際に振る舞いを固定しているか」の強い信号になるが、実行が重く、この設計の範囲の外に置く。後で「保証範囲」の一つの列として足せる |

## 8. 貢献者に課す規則

地図と同じく、課す規則は生成器が要るものに限る。

**課す規則**

- トップレベルの `describe` に関数名を書く（README の既存の規則）。ユニットテストの対象はこれで引く
- 機能ファイルには `@id` と対象のタグ（`@endpoint:` `@function:` `@scenario:`）を書き、ステップ定義は英語の Cucumber Expressions で書く。`gherkin-lint`、`bddgen`、ステップ定義の lint が検査する
- `// @test-id` で固定した id は一意にする。lint が検査する
- E2E の spec は `fixtures.ts` の `test` を使う。到達の記録のためで、lint が import を検査する

**あれば良くなるもの**

- `it` の直上の仕様コメント（既存の習慣）。無くても対象と期待結果は読める
- 日本語の訳（訳の表の行、`Feature` と `Scenario` の `ja:` の行、`it` の直上の `// ja:` コメント）。無ければ英語のまま読める
- `// @aspect boundary` や `// @subject <id>` の宣言。語彙や静的な解決が外れたときの補正に使う
- API テストで、エンドポイントのパスを `TEST_ISSUER` との連結かリテラルで書くこと。動的に組み立てると静的には読めないが、到達の記録が補う

**課さない規則**

- 既存のテストの書き直し。読めないテストは「対象不明」「観点なし」として画面に出すだけである
- テストに手で関数の id やエンドポイントの id を書くこと。宣言は補正の手段であって、前提ではない
- 生成したテストコードのコミット

## 9. 進め方

前の段が後の段の土台になるよう、五段に分ける。

1. **テストカタログと結合**：テストコードの読み取り（種類、対象、観点、期待結果、id）、関数カタログとの結合、Vitest と Playwright の JSON の取り込み、エンドポイントの画面のテストのタブ、テストの一覧のページ。最優先の要件に、静的な根拠で答える
2. **到達と Codecov**：Istanbul の計測、テストごとの差分、`apps/hono` の E2E の記録、到達の表示、不足の規則、lcov と JUnit の Codecov へのアップロード。ここで `ci.yml` に地図のジョブを移す
3. **テストの差分と PR のコメント**：変更前のカタログ、差分、`changes.frames` との突き合わせ、コメントの節
4. **機能ファイル**：playwright-bdd の導入、英語のステップ定義、二つの実行先の project、lint。トークンエンドポイントの異常系を機能ファイルに書き写して、既存の API テストと同じ結果になることを確かめる
5. **残り**：日本語の訳の表と表示の切り替え、Next.js の計測、決定の側の到達、適合性スイートの結果の取り込み、仕様の節ごとの一覧（関数の `@spec` とテストの仕様コメントを節で結ぶ）

第 4 段は第 2 段と第 3 段に依らないので、人がいれば並行できる。
第 1 段が終わった時点で、`/token` のテストのタブに、API、E2E、ユニットの三種類が対象ごとに並ぶことを計測で確認する。

## 10. 決めずに残すこと

- 日本語の訳の欠けを、いずれ CI で落とすか。この設計では数を出すだけにする
- Next.js の `app/` の関数を計測に入れる方法（`swc-plugin-coverage-instrument` か `babel-plugin-istanbul` か）
- 「関連するテストに変更が無い」を CI で落とすかどうか。この設計ではコメントに出すだけにする
- 地図と Codecov の二つのコメントを一つにまとめるか
- 適合性スイートの module とエンドポイントの対応表を誰が保つか
- 名前の変更の対応づけの閾値（期待結果の 8 割）。実際の PR で測って決める
- Vitest の istanbul プロバイダーが計数を置くグローバルの名前と、`isolate` の設定で計数がファイルごとに作り直されるか。実装の最初に確かめる
