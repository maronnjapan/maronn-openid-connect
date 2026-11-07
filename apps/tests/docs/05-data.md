# ⑤ データを書き出す

[全体像](README.md) ＞ [④ PR の差分と検査](04-pull-request.md) ＞ ⑤ データを書き出す ＞ [⑥ テストのページ](06-viewer.md)

```mermaid
flowchart LR
  subgraph IN["入力"]
    direction TB
    T["テストコード<br/>*.test.ts と *.spec.ts"]
    F["機能ファイル<br/>*.feature"]
    M["関数カタログ<br/>地図の解析"]
  end
  P1["① テストを読む"]
  P2["② 実行して計る"]
  P3["③ 結果と関数に結ぶ"]
  P4["④ PR の差分と検査"]
  P5["⑤ データを書き出す"]
  P6["⑥ テストのページ"]
  P7["⑦ ビルドと CI"]
  T --> P1
  F --> P1
  M --> P1
  T --> P2
  P1 --> P3
  P2 --> P3
  M --> P3
  P3 --> P4
  P3 --> P5
  P4 --> P5
  P5 --> P6
  P7 -. 順に動かす .-> P2
  P7 -.-> P5
  classDef here fill:#fde68a,stroke:#b45309,stroke-width:3px,color:#111
  classDef dim fill:#f3f4f6,stroke:#9ca3af,color:#6b7280
  class P5 here
  class P1,P2,P3,P4,P6,P7 dim
```

| 項目 | 内容 |
|---|---|
| 入力 | ③ のカード（`TestCase[]`、結果と到達つき）と結びつけ（`Joined`）、`measured` と実行の時刻、④ のテストの差分（`TestDiff`）、地図の `MapData`（`flows`、`functions`、`bodies`、`sources`）、作業ツリーの木（`repository.head.trees`）とファイルの本文、観点の表 |
| 出力 | `apps/tests/public/data` の `tests.json`、`outline.json`、`tests/by-file/<hash>.json`、`tests/sources/<hash>.json`、`tests/diff.json` |
| 実装 | `packages/test-catalog/src/build.ts`（`buildTests`、`writeFileCards`、`indexRefs`、`codeOfFrame`、`stepBlocks`、`outlineOf`、`shownFiles`）、`packages/test-catalog/src/model.ts`、`packages/test-catalog/src/join.ts`（`entryOf`、`countTests`）、`packages/map-analysis/src/build.ts`（`writeHashed`、`removeStale`） |

```mermaid
flowchart TB
  S1["⑤-1 ファイルの一覧"]
  S2["⑤-2 書き出しの順"]
  S3["⑤-3 ハッシュの名前"]
  S4["⑤-4 カードのファイル<br/>tests/by-file"]
  S5["⑤-5 フレームと<br/>エンドポイントの参照"]
  S6["⑤-6 コードの範囲"]
  S7["⑤-7 アウトライン<br/>outline.json"]
  S8["⑤-8 本文のファイル<br/>tests/sources"]
  S9["⑤-9 PR の差分のファイル<br/>tests/diff.json"]
  S10["⑤-10 索引<br/>tests.json"]
  S1 --> S2
  S2 --> S3
  S3 --> S4
  S3 --> S8
  S5 --> S7
  S6 --> S7
  S7 -->|"コードのファイル"| S8
  S4 -->|"card の url"| S10
  S5 -->|"frames と endpoints"| S10
  S8 -->|"sources の url"| S10
  S9 -->|"diff"| S10
```

## ⑤-1 ファイルの一覧

テストのページが読むファイルと、その間の参照を示す。

```text
apps/tests/public/data/          gitignore する
├── tests.json                   索引（TestsIndex）
├── outline.json                 アウトライン（TestsOutline）
└── tests/
    ├── by-file/<hash>.json      テストファイルごとのカード（FileTests）
    ├── sources/<hash>.json      ページが見せるファイルの本文（TestSource）
    └── diff.json                PR のビルドだけ（TestDiff）
```

- 型は `packages/test-catalog/src/model.ts` に一つだけ置く
- `model.ts` はコードを持たず、何も import しない
- テストのページが、`@maronn-openid-connect/test-catalog/model` として型だけを読むからである
- JSON は `JSON.stringify` の出力そのままで、字下げしない
- url は、テストのページの根からの相対（`./data/...`）である

```mermaid
classDiagram
  direction LR
  class TestsIndex {
    tests.json
    tests TestEntry[]
    sources パスから url
    diff boolean
  }
  class TestsOutline {
    outline.json
    endpoints OutlineEndpoint[]
    functions id から OutlineFunction
  }
  class FileTests {
    tests/by-file
    key テストファイルのパス
    tests TestCase[]
  }
  class TestSource {
    tests/sources
    path
    text
  }
  class TestDiff {
    tests/diff.json
    added removed renamed modified
    counts frames cards
  }
  TestsIndex --> FileTests : TestEntry.card の url
  TestsIndex --> TestSource : sources の url
  TestsIndex ..> TestDiff : diff が true のとき
  TestsIndex ..> TestsOutline : フレームの id とエンドポイントの鍵
  FileTests ..> TestSource : CodeRef.file
  TestsOutline ..> TestSource : CodeRef.file
```

- 実線は url で指す参照である
- 点線は、id、鍵、パスで名指す参照である
- `CodeRef.file` は、`TestsIndex.sources` の鍵と同じパスである

`model.ts` の型のうち、`RawReach` と `TestRun` はこのデータに書かない。
`RawReach` は、② が報告のディレクトリに書く到達の一行である。
`TestRun` は、③ が報告から組む実行で、その `run` だけを索引に写す（⑤-10）。

このブランチのデータの大きさは次のとおりである（2026-11-07 の値で、例である）。

| ファイル | 数 | 合計のバイト数 | 中央値 | 最大 |
|---|---|---|---|---|
| `tests.json` | 1 | 4,204,350 | | |
| `outline.json` | 1 | 532,823 | | |
| `tests/by-file/` | 465 | 14,108,129 | 15,837 | 326,601 |
| `tests/sources/` | 844 | 6,364,320 | 4,516 | 109,290 |
| `tests/diff.json` | 1 | 91,584 | | |

合計は 25,301,206 バイトである。
最も大きいカードのファイルは、`tests/e2e/specs/dynamic-client-registration.spec.ts`（20 件）のものである。
E2E のカードは実行先ごとに到達を持ち、その関数の列が長い。

ページは、ファイルを次の時に読む（読み方の詳細は ⑥）。

```mermaid
sequenceDiagram
  participant P as テストのページ
  participant D as data
  P->>D: tests.json と outline.json
  Note over P: 開いたときに一度
  P->>D: tests/by-file/ハッシュ.json
  Note over P: テストを開いたとき<br/>E2E の行に対象を出すとき
  P->>D: tests/sources/ハッシュ.json
  Note over P: コードを見せるとき
  P->>D: tests/diff.json
  Note over P: 索引の diff が true のときだけ
```

実装：`packages/test-catalog/src/model.ts`、`packages/test-catalog/package.json`（`exports` の `./model`）、`.gitignore`（`apps/tests/public/data/`）

## ⑤-2 書き出しの順

`buildTests(context, options)` が、ファイルを決まった順に書く。

```ts
interface TestBuildOptions {
  reports?: string; // 報告のディレクトリ（MAP_TEST_REPORTS）。無いか、ディレクトリが無ければ実行なし
  out?: string; // apps/tests/public/data。無ければファイルを一つも書かない
}
```

```mermaid
flowchart TB
  A["① カードを読む<br/>③ 実行を足して結ぶ"]
  B["indexRefs ⑤-5<br/>不足を並べる ⑤-10-c"]
  C["out/tests を作る"]
  D["tests/by-file を書き<br/>古いものを消す ⑤-4"]
  E["stepBlocks と outlineOf<br/>⑤-6 ⑤-7"]
  F["tests/sources を書き<br/>古いものを消す ⑤-8"]
  G{"PR の地図か"}
  H["tests/diff.json を書く<br/>④ ⑤-9"]
  I["tests/diff.json を消す"]
  J["tests.json と<br/>outline.json を書く"]
  A --> B --> C --> D --> E --> F --> G
  G -->|"はい"| H --> J
  G -->|"いいえ"| I --> J
```

- 索引とアウトラインは最後に書く
- 索引が指すカードと本文のファイルは、その時にはもう書き終わっている
- 名前の決まった三つ（`tests.json`、`outline.json`、`tests/diff.json`）は、毎回上書きするか消す
- `out` が無いときも、索引とアウトラインは組み立てる
- そのときはファイルを書かないので、項目の `card` は無く、`sources` は空になる
- 最後にログに一行足す（形は ⑦-2）
- 地図に返すのは `{ sections }` で、PR の地図でなければ空の列である（④-8）

実装：`packages/test-catalog/src/build.ts`（`buildTests`、`TestBuildOptions`）

## ⑤-3 ハッシュの名前

カードと本文のファイルは、中身のハッシュを名前にして書く。
中身が変われば名前も変わるので、キャッシュが古いファイルを返すことは無い。

```ts
function hashed(id: string, content: string): string {
  return `${createHash('sha256').update(id).update('\0').update(content).digest('hex')}.json`;
}
```

| ディレクトリ | `id` | `content` |
|---|---|---|
| `tests/by-file/` | テストファイルのパス | `JSON.stringify({ version: 1, key: パス, tests: カードの列 })` |
| `tests/sources/` | 見せるファイルのパス | `JSON.stringify({ path, text })` |

```mermaid
flowchart TB
  W["writeHashed<br/>ディレクトリ、id、<br/>中身、written"] --> N["名前を hashed で決める"]
  N --> M["ディレクトリを作る<br/>空にはしない"]
  M --> E{"同じ名前の<br/>ファイルがあり<br/>大きさが中身の<br/>バイト数と同じか"}
  E -->|"はい"| K["書かない"]
  E -->|"いいえ"| WR["書く"]
  K --> S["名前を written に足す"]
  WR --> S
  S --> R["ディレクトリの全部を<br/>書いた後で removeStale が<br/>written に無い名前を消す"]
```

- ディレクトリは先に空にしない
- 配っている開発サーバー（vite）は、一度消えたディレクトリに書き直したファイルを見なくなるからである
- 名前が同じなら中身も同じなので、大きさが合えばファイルが丸ごとあるとみなす
- 書かなかったファイルは、更新の時刻も変わらない
- url は `./data/tests/by-file/<名前>` と `./data/tests/sources/<名前>` である

例：`apps/hono/src/app.test.ts` のカードの url は `./data/tests/by-file/f1c19a2e2e0b9358015a15b4944396719e389a6d3f903a79c9a90f164f4f9d34.json` である。
このブランチのデータのファイルの名前は、上の式の値と一致する。

実装：`packages/map-analysis/src/build.ts`（`hashed`、`writeHashed`、`removeStale`）

## ⑤-4 カードのファイル

テストファイルごとに、そのファイルのカードの全文を一つのファイルに書く。

- カードは、カタログの順（ファイルのパス、始まりの行）に並ぶ
- ファイルは、パスの文字列の順に書く
- 索引の各項目は、そのファイルの url を `card` に持つ（⑤-10-a）
- ページはテストを開くと、そのファイルを読み、`id` でカードを探す

```ts
interface FileTests {
  version: 1;
  key: string; // テストファイルのパス
  tests: TestCase[];
}
```

```mermaid
classDiagram
  direction LR
  class FileTests {
    version 1
    key string
  }
  class TestCase {
    id kind root title ja
    source path outcome aspects
    spec errors targets evidence
    skipped digest
  }
  class Subject {
    kind id source how
  }
  class Assertion {
    actual matcher expected
    line text phrase ja
  }
  class RequestShape {
    endpoint method path
    params auth line
  }
  class FeatureStep {
    keyword type text
    phrase ja table line
  }
  class HelperRef {
    name depth
  }
  class CodeRef {
    file
    lines
  }
  class TestResult {
    status
    targets
  }
  class TestReach {
    target functions
    members requests
  }
  FileTests *-- TestCase : tests
  TestCase *-- Subject : subjects
  TestCase *-- Assertion : assertions
  TestCase *-- RequestShape : requests
  TestCase *-- FeatureStep : steps
  TestCase *-- HelperRef : helpers
  TestCase *-- TestResult : result
  TestCase *-- TestReach : reach
  FeatureStep --> CodeRef : definition
  CodeRef <|-- HelperRef
```

### ⑤-4-a カードの型

欄を決める規則は ① と ③ にある。
ここでは、ファイルに書く形を示す。

```ts
type TestKind = 'unit' | 'api' | 'e2e' | 'tool';
type TestOutcome = 'success' | 'failure' | 'unknown';
type Evidence = 'declared' | 'static' | 'coverage';
type TestStatus = 'passed' | 'failed' | 'skipped';

interface TestCase {
  id: string; // ①-10
  kind: TestKind; // ①-9-a
  root: string; // 根の名前、e2e、features、ツールの名前
  source: { file: string; lines: [number, number]; form: 'code' | 'feature' };
  title: string; // it かシナリオの名前（英語）
  ja?: { title?: string }; // 訳
  path: string[]; // describe の列。シナリオはフィーチャー（とアウトライン）の名前
  subjects: Subject[]; // ①-9-b、③
  requests?: RequestShape[]; // ①-5
  outcome: TestOutcome; // ①-9-c
  aspects: string[]; // ①-9-d
  spec: string[]; // 'RFC 6749 §5.2' など
  assertions: Assertion[]; // ①-4
  errors?: string[]; // 期待するエラー（OAuth のエラーコードとエラークラス）
  steps?: FeatureStep[]; // シナリオだけ
  targets?: string[]; // 実行先（hono、nextjs、http）
  evidence: Evidence[];
  skipped?: boolean; // skip、todo、fixme
  digest: string; // 本体（シナリオはステップ）の空白を除いたハッシュ
  result?: TestResult; // ③
  reach?: TestReach[]; // ③
  helpers?: HelperRef[]; // ①-6
}

type Subject =
  | { kind: 'function'; id: string; how: 'describe' | 'call' | 'declared' | 'coverage' }
  | { kind: 'endpoint'; id: string; source: 'hono' | 'nextjs'; how: 'request' | 'declared' | 'coverage' }
  | { kind: 'member'; id: string; how: 'coverage' };

interface Assertion {
  actual: string; // 確かめる値の言葉
  matcher: string; // toBe など。Then のステップは 'step'
  expected?: unknown; // リテラルのときだけ
  negated?: boolean;
  mode?: 'resolves' | 'rejects';
  line: number;
  text: string; // ページに出す英語の一行
  phrase?: string; // 合った訳の表の言い回し
  ja?: string;
}

interface RequestShape {
  endpoint?: string;
  method: string;
  path: string; // 書いたまま（`${TEST_ISSUER}/token` は /token）
  params?: string[]; // ボディかクエリのキー
  auth?: string; // client_secret_basic、client_secret_post、bearer
  line: number;
}

interface CodeRef {
  file: string; // リポジトリのルートからのパス
  lines: [number, number]; // 1 から数え、両端を含む
}

interface HelperRef extends CodeRef {
  name: string;
  depth?: number; // 無ければ 1
}

interface FeatureStep {
  keyword: string; // 'Given ' など、書いたまま
  type: 'context' | 'action' | 'outcome' | 'unknown';
  text: string;
  phrase?: string; // 合ったステップ定義の式
  ja?: string;
  table?: string[][]; // 先頭がヘッダの行
  line: number;
  definition?: CodeRef; // 合ったステップ定義のコード
}

interface TestResult {
  status: TestStatus; // 実行先の中で最も悪いもの
  targets: Record<string, { status: TestStatus; duration: number; attempts: number }>; // Vitest の実行先は ''
}

interface TestReach {
  target?: string; // Vitest には無い
  functions: string[]; // フレームの id
  members?: string[];
  requests?: Array<{ endpoint?: string; method: string; path: string; status: number; error?: string }>;
}
```

- `Subject` の `member` と `TestReach.members` は型にあるが、今のコードは書かない
- 根拠が `coverage` の対象は、③ が到達から足すエンドポイントだけである

### ⑤-4-b 例

このブランチの `packages/core/src/access-token-issuer.test.ts` の最初のカードである。
`reach.functions` は先頭の三つだけを示す。

```json
{
  "id": "0b4e5b687cf195c4",
  "kind": "unit",
  "root": "core",
  "source": { "file": "packages/core/src/access-token-issuer.test.ts", "lines": [40, 47], "form": "code" },
  "title": "should issue a JWT with three dot-separated segments",
  "path": ["createJwtAccessTokenIssuer"],
  "subjects": [{ "kind": "function", "id": "core:access-token-issuer.ts#createJwtAccessTokenIssuer", "how": "describe" }],
  "outcome": "success",
  "aspects": [],
  "spec": [],
  "assertions": [
    {
      "actual": "token.split('.').length",
      "matcher": "toBe",
      "expected": 3,
      "line": 46,
      "text": "`token.split('.').length` is 3",
      "phrase": "{code} is {value}",
      "ja": "`token.split('.').length` が 3 である"
    }
  ],
  "evidence": ["static", "coverage"],
  "digest": "1c323bed1bd35ace",
  "helpers": [{ "name": "buildPayload", "file": "packages/core/src/access-token-issuer.test.ts", "lines": [21, 31], "depth": 1 }],
  "result": { "status": "passed", "targets": { "": { "status": "passed", "duration": 11.079122999999981, "attempts": 1 } } },
  "reach": [{ "functions": ["core:access-token-issuer.ts#createJwtAccessTokenIssuer", "core:access-token.ts#generateAccessToken", "core:access-token.ts#validateAccessTokenExpiration"] }]
}
```

実装：`packages/test-catalog/src/build.ts`（`writeFileCards`）、`packages/test-catalog/src/model.ts`（`FileTests`、`TestCase` と、その中の型）

## ⑤-5 フレームとエンドポイントの参照

索引に、フレームごとの数と、エンドポイントごとのテストの id を書く。

索引はカードを一度ずつ持ち、フレームとエンドポイントは id で名指す。
多くのエンドポイントが届く関数には、計測した実行で千を超えるテストが到達する。
エンドポイントごとにカードを写すと、同じ千のカードがエンドポイントの数だけ並ぶからである。

### ⑤-5-a フレームの数

`frames` には、③ の結びつけで関連するテストが一つ以上あるフレームを、id の順に入れる。

```ts
interface FrameTestsRef {
  unit: number; // describe か宣言でそのフレームを名指すユニットテスト
  success: number; // そのうち正常系
  failure: number; // そのうち異常系
  boundary: number; // そのうち観点に boundary を持つもの
  reached: number; // 計測した実行でそのフレームに到達したテスト
  related: number; // 名指す、確かめるところで呼ぶ、到達したテストの全部
}
```

例：`core:access-token-issuer.ts#createJwtAccessTokenIssuer` は `{ "unit": 12, "success": 10, "failure": 2, "boundary": 1, "reached": 160, "related": 160 }` である。

### ⑤-5-b エンドポイントのテスト

`endpoints` には、③ の結びつけの全部のエンドポイントを、鍵 `<source>:<endpoint>` の順に入れる。

```ts
interface EndpointTestsRef {
  counts: TestCounts; // そのエンドポイントのテスト全部の数
  gaps: number; // そのエンドポイントの不足の数
  tests: string[]; // units に入らないテストの id
  units: Record<string, string[]>; // 届くフレームごとのユニットテストの id
}

interface TestCounts {
  total: number;
  kinds: Partial<Record<TestKind, number>>;
  outcomes: Partial<Record<TestOutcome, number>>;
  aspects: Record<string, number>; // 観点ごと（一枚を、持つ観点のそれぞれに数える）
  evidence: Partial<Record<Evidence, number>>; // 根拠ごと（観点と同じ数え方）
  results: Partial<Record<TestStatus | 'none', number>>; // 結果の無いカードは none
}
```

```mermaid
flowchart LR
  A["エンドポイントの<br/>テスト一つ<br/>③ の結びつけ"] --> U{"ユニットテストで<br/>届くフレームを<br/>名指すか"}
  U -->|"はい"| UN["units の<br/>そのフレームの列に入れる"]
  U -->|"いいえ"| T["tests に入れる"]
```

- 名指すは、`describe` か宣言でそのフレームを対象にすること（③ の `FrameJoin.unit`）である
- 名指す届くフレームが複数あれば、そのすべての列に入れる
- `units` の鍵はフレームの id の順で、テストの列が空のフレームは入れない
- 列の中と `tests` の並びは、カタログの順である
- `units` と `tests` を合わせると、`counts` が数えるテストのすべてになる
- 計測した実行で処理本体を通っただけのユニットテスト（届くフレームを名指さない）は、`tests` に入る
- `counts` は `countTests` が数える
- 種類、期待結果、結果は一枚を一つに数え、観点と根拠は持つものそれぞれに一つずつ数える

例：`hono:token` は、`counts.total` が 1,326（ユニット 1,244、API 23、E2E 59）、不足 69、`tests` 82 件、`units` 173 フレームである。

この規則は `packages/test-catalog/src/__tests__/build.test.ts` の `indexRefs` が確かめる。

実装：`packages/test-catalog/src/build.ts`（`indexRefs`）、`packages/test-catalog/src/join.ts`（`countTests`）

## ⑤-6 コードの範囲

ページが見せるコードを、ファイルのパスと行の範囲（**コードの範囲**、`CodeRef`）で表す。

### ⑤-6-a フレームのコード

`codeOfFrame(data, id)` は、関数か処理本体のコードの範囲を返す。

```mermaid
flowchart TB
  A["フレームの id"] --> B{"関数か処理本体に<br/>source があるか"}
  B -->|"ある"| C["source.file を<br/>MapData.sources の<br/>path にして<br/>start から end まで"]
  B -->|"無い"| D{"処理本体か"}
  D -->|"いいえ"| X["コードなし"]
  D -->|"はい"| E["calls のうち<br/>同じモジュールの<br/>関数の source を集める"]
  E --> F{"一つでもあるか"}
  F -->|"いいえ"| X
  F -->|"はい"| G["最も小さい start から<br/>最も大きい end まで"]
```

- 関数の `source` は、JSDoc とオーバーロードを含む
- 合成の処理本体（複数の handler を持つ本体）は、地図で行の範囲を持たない
- 同じモジュールは、`<本体の package>:<本体の module>` と同じ `source.file` である
- `source.file` が `MapData.sources` に無ければ、`source` が無いのと同じに扱う

例：このブランチの hono の `endpoint:login` は合成の本体である。
同じモジュールの `prepareLogin`（12 行から 42 行）と `submitLogin`（44 行から 97 行）から、`[12, 97]` になる。

### ⑤-6-b ステップのブロック

関数を持たないステップは、エンドポイントのファイルの印 `// [step-id]` が始めるブロックをコードにする。
Next.js のステップはすべてこれで、hono のステップにもある。

`stepBlocks(data, trees, read)` は次の順に動く。

1. 作業ツリーの木を、`tree.file`（`MapData.sources` の鍵）ごとに分ける
2. hono、nextjs の順に、地図のエンドポイントを見る
3. エンドポイントの `source` が無いか、`MapData.sources` にその `path` が無ければ飛ばす
4. そのファイルの木を、エンドポイントの `root` の木を先に、ほかは始まりの行の順に並べる
5. 関数を持たない各ステップについて、木を順に、ノードを前順（ノード、`pre`、`branches` の中）にたどる
6. 最初に見つかった、`kind` が `block` で `step.id` がそのステップの id のノードの行を取る
7. 本文が読めれば、範囲の始まりの空行を飛ばす（地図はブロックに上の空行を含める）
8. `<source>:<endpoint>:<step>` の鍵で返す

- 印の無いステップは、コードなしである
- 同じステップのブロックが Route Handler とその下の関数の両方にあれば、Route Handler のものを取る
- 空行を飛ばすのは、始まりが終わりより前にある間だけである

この規則は `build.test.ts` の `the code of the outline` と `stepBlocks` のテストが確かめる。

実装：`packages/test-catalog/src/build.ts`（`codeOfFrame`、`stepBlocks`）、`packages/map-analysis/src/tree.ts`（`nodesOf`）

## ⑤-7 アウトライン

ページが `map.json` を読まずにテストの対象を名指せるよう、関数カタログの抜き出しを `outline.json` に書く。

```mermaid
classDiagram
  direction LR
  class TestsOutline {
    version 1
  }
  class OutlineEndpoint {
    key source id label summary
    path methods group layer root
  }
  class OutlineStep {
    id label
    function calls
  }
  class OutlineFunction {
    id name package module summary
  }
  class CodeRef {
    file
    lines
  }
  TestsOutline *-- OutlineEndpoint : endpoints
  TestsOutline *-- OutlineFunction : functions
  OutlineEndpoint *-- OutlineStep : steps
  OutlineEndpoint --> CodeRef : code
  OutlineStep --> CodeRef : code
  OutlineFunction --> CodeRef : code
  OutlineStep ..> OutlineFunction : function と calls の id
```

```ts
interface TestsOutline {
  version: 1;
  endpoints: OutlineEndpoint[];
  functions: Record<string, OutlineFunction>; // フレームの id から
}

interface OutlineEndpoint {
  key: string; // '<source>:<endpoint>'。TestsIndex.endpoints の鍵
  source: 'hono' | 'nextjs';
  id: string;
  label: string; // 日本語の名前
  summary?: string;
  path: string;
  methods: string[];
  group: { id: string; label: string };
  layer: 'api' | 'browser' | 'metadata';
  root: string; // トレースが始まるフレーム
  steps: OutlineStep[];
  code?: CodeRef; // root のコード（⑤-6-a）
}

interface OutlineStep {
  id: string;
  label: string; // 日本語の名前
  function?: string; // ステップの関数のフレームの id
  calls?: string[]; // 関数の無いステップだけ（下の規則）
  code?: CodeRef; // 関数のコードか、ブロック（⑤-6-b）
}

interface OutlineFunction {
  id: string;
  name: string;
  package: string;
  module: string;
  summary?: string; // 空でないときだけ
  code?: CodeRef; // ⑤-6-a
}
```

### ⑤-7-a エンドポイントとステップ

- エンドポイントは hono、nextjs の順で、それぞれ地図の順（`flows[source].endpoints`）に並べる
- ③ の結びつけに無いエンドポイントは入れない
- `root` は結びつけのものを使い、無ければ地図のものを使う
- `summary` は、地図のエンドポイントにあるときだけ入れる
- 関数のあるステップ（`functionId`）は、`function` とその関数のコードを持つ
- 関数の無いステップは、あれば `calls` とブロックのコードを持つ

関数の無いステップの `calls` は、ステップにもユニットテストを並べるためにある。

1. 地図のステップの `calls` の重複を除く
2. そのエンドポイントの `EndpointTestsRef.units`（⑤-5-b）に鍵のあるフレームだけを残す
3. 残りが無ければ、`calls` を入れない

### ⑤-7-b 名指す関数

`functions` には、次のフレームを id の順に入れる。

- 索引の `frames` の鍵（関連するテストのあるフレーム）
- 各エンドポイントの `root`
- ステップの `function`
- 関数の無いステップの `calls`

地図の `functions` か `bodies` にあるものだけを入れ、どちらにも無い id は入れない。
`name`、`package`、`module`、`summary` は地図のものである。

### ⑤-7-c 例

このブランチの `hono:token` である。
`summary` は短く切り、`steps` は先頭の一つだけを示す。

```json
{
  "key": "hono:token",
  "source": "hono",
  "id": "token",
  "label": "トークンエンドポイント",
  "summary": "クライアントを認証し、提示されたグラントを検証して、トークンレスポンスで応答する。",
  "path": "/token",
  "methods": ["POST"],
  "group": { "id": "authorization-code", "label": "認可コードフロー" },
  "layer": "api",
  "root": "endpoint:token",
  "steps": [
    {
      "id": "parse-request",
      "label": "トークンリクエストを解析する",
      "function": "hono:oidc-provider/endpoints/token/steps/parse-request.ts#parseTokenRequest",
      "code": { "file": "apps/hono/src/oidc-provider/endpoints/token/steps/parse-request.ts", "lines": [46, 106] }
    }
  ],
  "code": { "file": "apps/hono/src/oidc-provider/endpoints/token/pipeline.ts", "lines": [40, 126] }
}
```

`nextjs:token` の二つ目のステップは、関数を持たずに `calls` とブロックを持つ。

```json
{
  "id": "authenticate-client",
  "label": "クライアントを認証する",
  "calls": [
    "core:client-auth.ts#extractClientCredentials",
    "core:token-request.ts#resolveAuthenticatedTokenClient",
    "core:client-auth.ts#validateClientAuthMethod",
    "core:client-auth.ts#verifyClientSecret"
  ],
  "code": { "file": "apps/nextjs/src/app/token/route.ts", "lines": [138, 162] }
}
```

このブランチでは、エンドポイント 34（hono と nextjs に 17 ずつ）、ステップ 250、関数 1,060 である。
ステップのうちコードの範囲を持つものは 185、`calls` を持つものは 43 である（値は例）。

この規則は `build.test.ts` の `outlineOf` が確かめる。

実装：`packages/test-catalog/src/build.ts`（`outlineOf`）

## ⑤-8 本文のファイル

ページがコードを見せるファイルの本文を、ファイルごとに一つ書く。

```ts
interface TestSource {
  path: string; // リポジトリのルートからのパス
  text: string; // 作業ツリーの本文そのまま
}
```

見せるファイル（`shownFiles`）は次のものの和で、重複を除いてパスの順に並べる。

```mermaid
flowchart LR
  A["テストファイル全部"]
  B["カードの helpers の file"]
  C["シナリオのステップの<br/>definition の file"]
  D["アウトラインの<br/>エンドポイントの<br/>code の file"]
  E["アウトラインの<br/>ステップの code の file"]
  F["アウトラインの<br/>functions の code の file"]
  S["見せるファイル"]
  A --> S
  B --> S
  C --> S
  D --> S
  E --> S
  F --> S
```

- 本文は作業ツリーから読み、読めないファイルは飛ばす
- 書いたファイルの url を、索引の `sources[パス]` に入れる
- 本文に色は付けない（設計では、色を付けると 20 MB を超えるためとしている）
- ページが自分で字句に分けて色を付ける（⑥）

このブランチでは 844 ファイルである（値は例）。
テストファイルが 465、ほか（ヘルパー、ステップ定義、関数、処理本体のファイル）が 379 である。

例：`packages/core/src/access-token-issuer.test.ts` の本文の url は `./data/tests/sources/d2081499fcdc6e2b3a7fc0448030eddc9912fb04296dde7f2d9de5f00b3daee4.json` である。
中身は次の形で、`text` は 5,482 文字ある（先頭だけを示す）。

```json
{ "path": "packages/core/src/access-token-issuer.test.ts", "text": "import { describe, it, expect, beforeAll } from 'vitest';\nimport {\n…" }
```

この規則は `build.test.ts` の次のテストが確かめる。

- `should show the code of every file a card or the outline points at: the tests, the helpers, the step definitions, the functions and the bodies`

実装：`packages/test-catalog/src/build.ts`（`shownFiles`、`buildTests` の本文の部分）

## ⑤-9 PR の差分のファイル

PR の地図のビルドでだけ、④ の `TestDiff` を `tests/diff.json` に書く。

- 名前は決まっていて、ハッシュにしない
- 書いたときは、索引の `diff` を `true` にする
- PR の地図でないビルドは、前のビルドが残したものを消す

```mermaid
classDiagram
  direction LR
  class TestDiff {
    added string[]
    removed string[]
    renamed 前と後の id の組
  }
  class Modified {
    id
    what
    assertions
  }
  class Counts {
    before after
    byKind byEndpoint
  }
  class FrameVerdict {
    frame related touched
    untouched reason
    failuresWithoutTest
    before after
  }
  class DiffCard {
    id kind title outcome aspects
    source path ja examples endpoints
  }
  TestDiff *-- Modified : modified
  TestDiff *-- Counts : counts
  TestDiff *-- FrameVerdict : frames
  TestDiff *-- DiffCard : cards
```

`Modified`、`Counts`、`FrameVerdict`、`DiffCard` は図のための名前で、コードでは `TestDiff` の中の型である。

```ts
interface TestDiff {
  added: string[]; // ④-4-a
  removed: string[];
  renamed: Array<[before: string, after: string]>; // ④-4-b
  modified: Array<{
    id: string;
    what: Array<'title' | 'assertions' | 'subjects' | 'requests' | 'body'>; // ④-4-c
    assertions?: { added: Assertion[]; removed: Assertion[] };
  }>;
  counts: {
    before: number;
    after: number;
    byKind: Record<string, [number, number]>; // ④-4-d
    byEndpoint: Record<string, [number, number]>;
  };
  frames: Array<{
    frame: string; // ④-6
    related: string[];
    touched: string[];
    untouched: boolean;
    reason?: { text: string; note: string };
    failuresWithoutTest: string[];
    before: { outcomes: string[]; aspects: string[]; errors: string[] };
    after: { outcomes: string[]; aspects: string[]; errors: string[] };
  }>;
  cards: Record<
    string,
    Pick<TestCase, 'id' | 'kind' | 'title' | 'outcome' | 'aspects' | 'source' | 'path'> & {
      ja?: string;
      examples?: number;
      endpoints?: string[];
    }
  >; // ④-4-e
}
```

このブランチを `MAP_BASE=origin/main` で作ると、足したテスト 277、ほかは 0、判定 0、カード 277 である。
`counts` は `before` 5,731、`after` 6,008、`byEndpoint` の鍵は 32 個（`hono:token` は `[48, 55]`）である（値は例）。

`cards` の値の例（アウトラインの行）：

```json
{
  "id": "token-missing-required-parameter-1",
  "kind": "api",
  "title": "Reject a request without code with invalid_request",
  "outcome": "failure",
  "aspects": [],
  "source": { "file": "tests/features/token/authorization-code-grant.feature", "lines": [38, 38], "form": "feature" },
  "path": ["The authorization_code grant at the token endpoint", "Reject a request without <parameter> with <error>"],
  "ja": "code のないリクエストを invalid_request で拒否する",
  "examples": 2,
  "endpoints": ["hono:token", "nextjs:token"]
}
```

実装：`packages/test-catalog/src/build.ts`（`buildTests` の PR の部分）、`packages/test-catalog/src/diff.ts`（`diffCatalogs`）

## ⑤-10 索引

ページが最初に読む索引を `tests.json` に書く。
索引は全部のカードを一度ずつ、期待結果とステップを除いて持つ。

```mermaid
classDiagram
  direction LR
  class TestsIndex {
    version 1
    run measured
    counts unknown untranslated
    requiredAspects sources
    aspectLabels diff
  }
  class TestEntry {
    id kind root title ja
    file lines form path
    outcome aspects subjects evidence
    targets skipped result reached card
  }
  class FrameTestsRef {
    unit success failure boundary
    reached related
  }
  class EndpointTestsRef {
    gaps
    tests
    units
  }
  class TestCounts {
    total kinds outcomes
    aspects evidence results
  }
  class Gap {
    kind frame error step
    aspect feature reached text
  }
  TestsIndex *-- TestEntry : tests
  TestsIndex *-- FrameTestsRef : frames
  TestsIndex *-- EndpointTestsRef : endpoints
  TestsIndex *-- TestCounts : counts
  TestsIndex *-- Gap : gaps
  EndpointTestsRef *-- TestCounts : counts
  EndpointTestsRef ..> TestEntry : tests と units の id
```

```ts
interface TestsIndex {
  version: 1;
  run?: { ref?: string; commit?: string; at?: string };
  measured: boolean;
  tests: TestEntry[];
  frames: Record<string, FrameTestsRef>; // ⑤-5-a
  endpoints: Record<string, EndpointTestsRef>; // ⑤-5-b
  counts: TestCounts;
  unknown: { subject: number; outcome: number; aspect: number };
  untranslated: string[];
  gaps: Array<Gap & { source?: string; endpoint?: string; endpoints?: string[] }>;
  requiredAspects: string[];
  sources: Record<string, string>; // パスから本文の url
  aspectLabels: Record<string, string>;
  diff?: boolean;
}
```

| 欄 | 中身 |
|---|---|
| `run` | 報告を読んだときだけ入れる（下の規則） |
| `measured` | 報告の到達の行を一つでも読めば `true` |
| `tests` | カードごとの項目（⑤-10-a）。カタログの順 |
| `counts` | 全部のカードを `countTests` で数えたもの（⑤-5-b） |
| `unknown` | 規則で読めなかったカードの数（⑤-10-b） |
| `untranslated` | 訳の表に日本語の無い言い回し。並べたもの（①） |
| `gaps` | ⑤-10-c |
| `requiredAspects` | 観点の表の `required` |
| `sources` | ⑤-8 |
| `aspectLabels` | 観点の表の id から `label`（`boundary` から `境界値`）。表の順 |
| `diff` | `tests/diff.json` を書いたときだけ `true` |

- `at` は、最初に読んだ Vitest の報告の `startTime` を ISO 8601 にしたものである
- Vitest の報告に無ければ、最初に読んだ Playwright の報告の `stats.startTime` である
- `ref` と `commit` は型にあるが、今のコードは書かない

このブランチでは、`run` が `{ "at": "2026-11-07T13:11:32.141Z" }`、`measured` が `true` である（値は例）。

### ⑤-10-a 索引の項目

カードから期待結果、ステップ、リクエストなどを除き、数とカードの url を足した形である。

```ts
interface TestEntry {
  id: string;
  kind: TestKind;
  root: string;
  title: string;
  ja?: string; // TestCase.ja.title
  file: string; // TestCase.source.file
  lines: [number, number]; // TestCase.source.lines
  form: 'code' | 'feature'; // TestCase.source.form
  path: string[];
  outcome: TestOutcome;
  aspects: string[];
  subjects: Subject[];
  evidence: Evidence[];
  targets?: string[];
  skipped?: boolean; // true のときだけ
  result?: TestStatus; // TestCase.result.status
  reached?: number; // 到達の関数の数。実行先をまたいで重複を除く
  card?: string; // カードのファイルの url（⑤-4）
}
```

- 項目に入れないのは、`spec`、`assertions`、`errors`、`requests`、`steps`、`digest`、`helpers`、実行先ごとの結果、到達の中身である
- これらは、テストを開いたときにカードのファイルから読む

例（このブランチの `apps/hono/src/app.test.ts` の項目）：

```json
{
  "id": "363af334cabbef71",
  "kind": "api",
  "root": "hono",
  "title": "should publish the discovery document of the ISSUER",
  "file": "apps/hono/src/app.test.ts",
  "lines": [17, 28],
  "form": "code",
  "path": ["createServerApp"],
  "outcome": "success",
  "aspects": [],
  "subjects": [{ "kind": "endpoint", "id": "discovery", "source": "hono", "how": "request" }],
  "evidence": ["static"],
  "result": "passed",
  "reached": 52,
  "card": "./data/tests/by-file/f1c19a2e2e0b9358015a15b4944396719e389a6d3f903a79c9a90f164f4f9d34.json"
}
```

### ⑤-10-b 読めなかった数

| 欄 | 数えるカード |
|---|---|
| `subject` | ユニットか API で、対象が一つも無い |
| `outcome` | ツールでなく、期待結果が `unknown` |
| `aspect` | ツールでなく、観点が一つも無い |

このブランチでは、`subject` 332、`outcome` 22、`aspect` 4,062 である（値は例）。

### ⑤-10-c 不足の並べ方

③ はエンドポイントごとに不足を出す。
索引は、同じ関数の「ユニットテストが無い」を一つにまとめる。

```mermaid
flowchart TB
  A["エンドポイントごとの不足<br/>結びつけの順"] --> B{"no-unit-test で<br/>frame があるか"}
  B -->|"いいえ"| D["source と endpoint を<br/>付けて並べる"]
  B -->|"はい"| C["フレームごとに<br/>一つにまとめ<br/>endpoints に鍵を足す"]
  D -->|"一番目"| E["gaps"]
  C -->|"二番目<br/>初めて出た順"| E
  F["機能の不足<br/>feature-without-e2e"] -->|"三番目"| E
```

- まとめた不足は、最初に出たものの欄（`text`、`reached`）を持つ
- `endpoints` は、そのフレームに届くエンドポイントの鍵を、結びつけの順に持つ
- ほかの不足の `source` と `endpoint` は、そのエンドポイントの `hono` か `nextjs` と id である
- 並びは、ほかの不足、まとめた不足、機能の不足の順である
- フレームごとの不足（③ の `FrameJoin.gaps`）は書かない

```ts
interface Gap {
  kind: 'no-unit-test' | 'failure-untested' | 'step-unreached' | 'aspect-missing' | 'feature-without-e2e';
  frame?: string;
  error?: string; // failure-untested
  step?: string; // step-unreached
  aspect?: string; // aspect-missing
  feature?: string; // feature-without-e2e
  reached?: number; // no-unit-test、計測した実行だけ
  text: string; // ページに出す言葉
}
```

不足を決める規則は ③ にある。
このブランチでは 350 件で、`no-unit-test` 321、`failure-untested` 25、`aspect-missing` 2、`feature-without-e2e` 2 である（値は例）。

```json
[
  { "kind": "aspect-missing", "aspect": "authentication", "text": "認証のテストが無い", "source": "hono", "endpoint": "jwks" },
  { "kind": "no-unit-test", "frame": "core:crypto-utils.ts#getJwaAlgorithm", "reached": 1083, "text": "getJwaAlgorithm() にユニットテストが無い（到達するテスト 1083）", "endpoints": ["hono:discovery", "hono:jwks", "hono:authorize", "hono:consent"] },
  { "kind": "feature-without-e2e", "feature": "revocation", "text": "機能 revocation のエンドポイント（revocation）を通る E2E のテストが無い" }
]
```

二つ目の `endpoints` は、18 個のうち先頭の四つだけを示す。

実装：`packages/test-catalog/src/build.ts`（`buildTests` の索引と不足の部分）、`packages/test-catalog/src/join.ts`（`entryOf`、`countTests`）

## この章の出力

- ⑥ は、`apps/tests/public/data` の五種類のファイルを読む
- ⑥ は、型を `@maronn-openid-connect/test-catalog/model` から読む
- ⑦ のビルドで、テストのページの `vite build` が `public/data` を `dist/data` に写し、`copy-tests-viewer.mjs` が地図の `dist/tests/` に写す

[全体像](README.md) ＞ [④ PR の差分と検査](04-pull-request.md) ＞ ⑤ データを書き出す ＞ [⑥ テストのページ](06-viewer.md)
