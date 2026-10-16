---
'@maronn-openid-connect/cli': minor
---

生成される OP を箱と矢印の図にする `graph` コマンドと、その図の元になるフロー文書から生成する `--flow` を追加し、生成コードの各エンドポイントを図の箱 1 つ = export 関数 1 つの形に分ける

`maronn-oidc graph [framework]` は、`generate` と同じ `--enable` / `--disable` / `--scope` / `--db` から、生成される OP を Mermaid の flowchart（既定）か JSON のフロー文書（`--format json`）として標準出力（`-o` でファイル）に書く。何も生成しない。

- 既定（`--detail endpoints`）は箱がエンドポイント、矢印はエンドポイントの間でコードやトークンが渡る向き。`--detail steps` は各エンドポイントの中を生成コードの export 関数 1 つにつき箱 1 つで描き、箱にはステップの ID、関数名、根拠の仕様節を載せる。`--endpoint <ids>` で描くエンドポイントを絞り、`--no-error-edges` でエラー応答への破線を省く
- フロー文書には、エンドポイントとステップの一覧、各ステップが読む値と作る値（`consumes` / `produces`）、消せるかどうか（`removable`）、描いたときの `features` / `scopes` / `db` が入る。framework を付けると、各エンドポイントの生成先ファイル（`module`）も入る

`generate` / `setup` / `graph` の `--flow <file>` は、このフロー文書（編集済みでもよい）を機能フラグの代わりに読む。`--enable` / `--disable` / `--scope` / `--db` との併用はエラーになる。

- 文書で変えられるのは、`removable: true` のステップを消す、値のやり取りが無いステップを並べ替える、エンドポイントを並べ替える、`features` / `scopes` / `db` を変える、の 4 つ。消したステップが作っていた値を後のステップが読むときは、生成コードが既定値（ID Token なら `undefined`）で補う
- `removable: false` のステップや `feature` 付きのステップを消す、値を作るステップより前にそれを読むステップを置く、`after` / `before` の制約に反する、画面のエンドポイント（`login` / `login-google` / `consent` / `device` / `ciba` / `logout`）のステップ列を変える、必須のエンドポイントを外す、といった文書は、何も書き込まずにエラーで止まる
- 並べ替えたステップは Hono / Express / Fastify の生成コードに反映する。Next.js は Route Handler に処理を直接書く構成のため、`steps` を変えた文書はエラーにし、エンドポイントと機能の変更だけを受け付ける
- `.maronn-openid-connect.json` に `steps`（並べ替えたエンドポイントごとのステップ ID の列）と `endpointOrder`（エンドポイントの順番）を追加した。並べ替えていなければ `null`。エンドポイントの順番は記録だけで、生成コードのマウント順は変えない

生成コードの `routes/*.ts` は、図の箱と 1 対 1 で対応する export 関数（`routes/token.ts` なら `parseTokenRequest()` → `authenticateTokenClient()` → … → `respondToken()`）に分け、ハンドラーはそれらをステップ ID のコメント（`// [parse-request] …`）を添えて順に呼ぶ形にした。対象は Hono / Express / Fastify の `authorize` / `token` / `userinfo` / `introspection` / `revocation` / `discovery` / `jwks`、experimental の `par` / `register` / `device-authorization` / `backchannel-authentication`、画面の `login` / `consent`（`prepareLogin()` / `submitLogin()` / `completeGoogleLogin()` / `prepareConsent()` / `submitConsent()` が箱ごとの関数を決まった順で呼ぶ）。`pages/` が呼ぶ入口（`tokenApp`、`processAuthorizationRequest()`、`prepareLogin()` など）と outcome の型は変えていないので、画面を差し替えている生成コードはそのまま動く。`device` / `ciba` / `logout` の生成コードと Next.js の生成物は変わらない（Next.js はマニフェストの 2 項目だけが増える）。
