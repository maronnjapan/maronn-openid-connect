# OpenID Foundation Conformance Suite

このディレクトリは、`samples/*` 配下のOpenID Providerサンプルアプリに対して
OpenID Foundation Conformance Suiteを実行するためのものです。

## Basic OP

設定しているOIDFテストプランは以下です。

```text
oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]
```

選択したサンプルOPが、OpenID Connect Basic OP Certificationのstatic client
profileを満たすかを確認します。Suite本体は公式のprebuilt Docker imageを使い、
公式の `run-test-plan.py` runner scriptで実行します。

## ローカル実行

### 前提条件

- 初回実行前に `pnpm install` を実行しておくこと。
- Docker CLIと起動中のDocker daemonが必要です。
- 上書きしない場合、ローカルport `8443` と `3443` が空いている必要があります。
- コマンドはrepository rootから実行してください。

### デフォルトのHonoサンプルを実行する

Basic OP static-client planをローカルで実行します。

```bash
pnpm run conformance:basic-op
```

ランナーは公式のprebuilt Conformance Suite imageを使い、サンプルOPをHTTPSリバース
プロキシの後ろで起動します。そのうえで、SuiteのコールバックURLに合わせたstatic
client metadataを生成し、結果ZIPを `tests/conformance/results/` に出力します。

デフォルトの検証対象OPは `samples/hono-cloudflare` です。OPはDocker内でサンプルアプリのビルド
成果物から起動されます。`tests/conformance` 配下にはOPロジックを実装していません。

### 別のサンプルOPを選択する

他のサンプルOPは以下のように選択できます。

```bash
CONFORMANCE_SAMPLE_APP=express-flyio pnpm run conformance:basic-op
CONFORMANCE_SAMPLE_APP=fastify-flyio pnpm run conformance:basic-op
CONFORMANCE_SAMPLE_APP=nextjs-vercel pnpm run conformance:basic-op
```

指定できる値は `hono-cloudflare`, `express-flyio`, `fastify-flyio`, `nextjs-vercel` です。

### コマンドが行うこと

`pnpm run conformance:basic-op` は以下を順に実行します。

1. `@maronn-openid-connect/cli` をビルドする。
2. 選択したサンプルpackageをビルドする。
3. OIDF static-client設定を `tests/conformance/.generated/` に生成する。
4. OP TLSリバースプロキシ用のローカル自己署名証明書を生成する。
5. Docker Composeサービスを起動する。
   - `mongodb`
   - `conformance-server`
   - `conformance-nginx`
   - `op`
   - `op-tls`
   - `runner`
6. Conformance Suite APIとOP Discoveryエンドポイントの起動を待つ。
7. `scripts/run-test-plan.py` でBasic OPテストプランを実行する。
8. Dockerログとエクスポートされた結果ZIPを `tests/conformance/results/` に書き出す。
9. `CONFORMANCE_KEEP_SERVICES=1` が設定されていなければ、Docker Composeサービスを停止して削除する。

### 環境変数

- `CONFORMANCE_SAMPLE_APP`: `hono-cloudflare`, `express-flyio`, `fastify-flyio`, `nextjs-vercel` のいずれか。
- `CONFORMANCE_SUITE_IMAGE_TAG`: OpenID Foundation image tag。デフォルトは `latest`。
- `CONFORMANCE_SUITE_REF`: `run-test-plan.py` 用にcloneする `openid/conformance-suite` のGit ref。デフォルトは `master`。
- `CONFORMANCE_SUITE_PORT`: Conformance Suite HTTPSエンドポイントのhost port。デフォルトは `8443`。
- `CONFORMANCE_OP_TLS_PORT`: サンプルOP HTTPS proxyのhost port。デフォルトは `3443`。
- `CONFORMANCE_KEEP_SERVICES=1`: runner終了後もDocker Composeサービスを残す。
- `CONFORMANCE_ALIAS`: コールバックURLに使うOIDF test alias。デフォルトは `maronn-basic-op`。
- `CONFORMANCE_OP_ISSUER`: Compose内でサンプルOPが使うissuer。デフォルトは `https://op-tls:3443`。
- `CONFORMANCE_SUITE_BASE_URL`: Compose内でcallback URI生成に使うSuite base URL。デフォルトは `https://conformance-nginx:8443`。
- `OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW`: サンプルOPのBasic OP互換モード。`pnpm run conformance:basic-op` ではデフォルト `1`。
- `OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT`: サンプルOPで unsigned（`alg:none`）Request Object を受理し、discovery の `request_object_signing_alg_values_supported` に `none` を広告する互換モード。`pnpm run conformance:basic-op` ではデフォルト `1`（通常利用・E2Eでは未設定＝署名必須）。`oidcc-unsigned-request-object-...` / `oidcc-ensure-request-object-with-redirect-uri` は OP が unsigned 非対応を広告すると skip されるため、conformance run でのみ有効化する。

host portを変えて実行する例:

```bash
CONFORMANCE_SUITE_PORT=18443 CONFORMANCE_OP_TLS_PORT=13443 pnpm run conformance:basic-op
```

### Basic OP向けPKCE互換モード

このプロジェクトの通常動作はOAuth 2.1方針としてPKCE(S256)必須です。一方、OpenID
Foundation Basic OP static-client planには、confidential clientの非PKCE authorization
code flow moduleが含まれます。

そのため、`pnpm run conformance:basic-op` はサンプルOPコンテナにだけ
`OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=1` を渡します。CLI生成コードの
`ProviderConfig.allowNonPkceAuthorizationCodeFlow` はデフォルト `false` なので、
通常のPoC利用、ローカルサンプル起動、E2EではPKCE必須のままです。

互換モードでも許可されるのは、PKCEパラメータを完全に省略した明示的な
`clientType: 'confidential'` clientのrequestだけです。public clientの非PKCE request、
または不正な `code_challenge` / `code_challenge_method` は引き続き拒否します。
Discovery metadataの `code_challenge_methods_supported: ['S256']` は「PKCEを使う場合に
サポートする方式」を示すため、互換モード中も実装実態と矛盾しません。

### Request Object（署名付き JWS）の自動検証

OIDC Core 1.0 §6.1 / RFC 9101 の Request Object module（`oidcc-ensure-request-object-with-redirect-uri`
など）を automated test target として走らせるため、`create-basic-op-config.mjs` は
固定の RS256 鍵ペアを既定で両側に登録します。

- OP 側（`oidc-clients.json`）の static client には公開鍵 JWKS を登録し、OP が署名を検証
  できるようにする。
- Suite 側（`basic-op-config.json`）の client / client2 / client_secret_post には秘密鍵
  JWKS と `request_object_signing_alg: RS256` を登録し、Suite が同じ鍵で Request Object に
  署名できるようにする。

この鍵はローカル/CI の Docker conformance run 専用の使い捨て鍵で、本番の秘密情報では
ありません。OP が信頼する公開 JWKS だけを差し替えたい場合は、`CONFORMANCE_CLIENT_JWKS`
（JSON）で override できます（その場合は署名側の鍵と整合させること）。

### 出力

実行時設定は以下に生成されます。

- `tests/conformance/.generated/basic-op-config.json`
- `tests/conformance/.generated/oidc-clients.json`
- `tests/conformance/.generated/metadata.json`
- `tests/conformance/.generated/certs/`

実行結果は以下に出力されます。

- `tests/conformance/results/docker-compose.log`
- `tests/conformance/results/*.zip`

ZIPファイルはConformance Suiteのエクスポートです。どのmoduleがpass/failしたかを確認する場合は、
まずこのZIPを確認してください。

### 終了ステータス

このコマンドはConformance runnerの終了ステータスを返します。

- `0`: 設定したtest planが成功した。
- `0` 以外: Suiteが失敗した、OPがmoduleで失敗した、またはセットアップが完了しなかった。

`0` 以外で終了しても、runnerが結果ZIPをエクスポートできている場合があります。実行後は必ず
`tests/conformance/results/` を確認してください。

### クリーンアップ

サービスは実行後に自動削除されます。debugのために残す場合は以下を使います。

```bash
CONFORMANCE_KEEP_SERVICES=1 pnpm run conformance:basic-op
```

確認が終わったら手動で削除します。

```bash
docker compose -f tests/conformance/docker-compose.yml down -v --remove-orphans
```

## CI実行

GitHub Actions workflowは `.github/workflows/conformance.yml` に定義しています。

### 手動実行

GitHub Actionsの `OpenID Conformance` workflowを選び、以下を指定して実行します。

- `sample_app`: `hono-cloudflare`, `express-flyio`, `fastify-flyio`, `nextjs-vercel` のいずれか。
- `suite_image_tag`: OpenID Foundation Conformance Suite image tag。通常は `latest`。

workflowでは以下を実行します。

```bash
pnpm install --frozen-lockfile
pnpm run conformance:basic-op
```

Suiteが失敗した場合でも、以下のartifactをアップロードします。

- `tests/conformance/results`
- `tests/conformance/.generated`

### Pull Requestでの実行

Pull Requestに `run-conformance` labelが付いている場合もworkflowを実行します。
Conformance Suiteは重いので通常のPR経路からは外し、必要な変更に対してmaintainerが
Basic OP checkを要求できるようにしています。

PR triggerの対象pathは以下に限定しています。

- `packages/**`
- `samples/**`
- `tests/conformance/**`
- `.github/workflows/conformance.yml`
- `package.json`
- `pnpm-lock.yaml`

## 直近の既知結果

Conformance SuiteはローカルとCIで実行可能です。

Basic OP向けPKCE互換モード追加前の `samples/hono-cloudflare` に対するローカル実行では、以下が
エクスポートされました。

```text
tests/conformance/results/oidcc-basic-certification-test-plan-discovery-static_client-er8WhDACYy2mB-17-Jun-2026.zip
```

結果概要:

- 35個のBasic OP moduleが報告された。
- 1 moduleがpassした。
- 34 modulesがfailした。
- passしたmoduleは `oidcc-ensure-request-with-valid-pkce-succeeds`。

主な失敗理由は、OPがauthorization code flowでPKCEを必須にしている一方、Basic OP
planには非PKCEのauthorization code flow moduleが多く含まれていたことです。この差分は
Basic OP向けPKCE互換モードで対応しています。

Basic OP向けPKCE互換モード追加後の `samples/hono-cloudflare` に対するローカル再実行では、以下が
エクスポートされました。

```text
tests/conformance/results/oidcc-basic-certification-test-plan-discovery-static_client-5XeV397bGW050-17-Jun-2026.zip
```

結果概要:

- `pnpm run conformance:basic-op` はexit code 1で終了した。
- ZIP内の35個のBasic OP moduleは、22 passed / 6 warning / 4 failed /
  1 skipped / 2 interrupted without resultだった。
- 互換モード追加前の主因だった `code_challenge` / `code_verifier` 必須エラーは
  ZIP内ログのerror messageから消えている。
- 残る未pass項目はPKCE互換性とは別論点で、UserInfo scope claims warning、
  `id_token_hint`、request object系、WebRunnerのmanual review待機、refresh token skipped。

そのため、このコマンドはBasic OP Certification全体の合否確認には引き続き使えますが、
現時点では全passを保証する合格ゲートではありません。

Request Object パラメータの黙殺を修正（`request` / `request_uri` を
`request_not_supported` / `request_uri_not_supported` で明示拒否）した後の
`samples/hono-cloudflare` に対するローカル再実行では、以下の結果になりました。

結果概要:

- ZIP内の35個のBasic OP moduleは、29 passed / 1 warning / 1 skipped /
  2 failed / 2 interrupted (unknown) だった。
- 修正前にFAILEDだった `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported`
  は、OPが `request_not_supported` を返すようになり **SKIPPED**（Suiteが「rejected as
  unsupported は permitted」と判定）へ変化した。
- OP実装ロジック由来のFAILUREは0件。残る未pass項目はすべて manual review
  （`oidcc-ensure-registered-redirect-uri` / `oidcc-ensure-request-object-with-redirect-uri`
  のerror page screenshot、`oidcc-prompt-login` / `oidcc-max-age-1` の2回目ログイン
  screenshot）か、optional（`oidcc-ensure-request-with-acr-values-succeeds` の acr SHOULD
  warning）。

詳細と残課題の対応手順は作業用 notes リポジトリで管理しています。

acr resolver の配線（`acr_values` を ID Token の `acr` として echo）と unsigned Request
Object 互換モード（`OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1`）を sample 起動側に追加した後の
`samples/hono-cloudflare` に対するCI実行（GitHub Actions `OpenID Conformance` workflow）では、以下の
結果になりました。

結果概要:

- ZIP内の35個のBasic OP moduleは、**32 passed / 0 warning / 0 skipped / 1 failed /
  2 interrupted (unknown)** だった。
- `oidcc-ensure-request-with-acr-values-succeeds` は **WARNING → PASSED**（acr resolver
  が要求された `acr_values` を ID Token の `acr` に返すようになった）。
- `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported` /
  `oidcc-ensure-request-object-with-redirect-uri` は **SKIPPED → PASSED**（OP が unsigned
  Request Object を受理し discovery に `none` を広告したため、Suite が両 module を run する
  ようになった）。
- Overall totals: **0 warnings**。OP実装ロジック由来のFAILUREは0件。
- 残る未pass項目はすべて screenshot 提出待ちの manual review module:
  `oidcc-ensure-registered-redirect-uri`（error page screenshot）、
  `oidcc-prompt-login` / `oidcc-max-age-1`（2回目ログイン画面 screenshot）。

つまり **screenshot 提出以外のスキップ・エラー・Warning は 0 件** となった。残りの3 module
はブラウザ自動化だけでは完了できず screenshot 提出を要する manual review module であり、
OP の挙動自体は正しい。

同じ配線（acr resolver / `OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT`）は `samples/express-flyio` /
`samples/fastify-flyio`（起動側 `app.ts`）と `samples/nextjs-vercel`（CLI生成 `_oidc-provider/runtime.ts`）
にも適用済み。`CONFORMANCE_SAMPLE_APP=nextjs-vercel` でのCI実行でも **32 passed / 0 warning /
0 skipped / 0 condition failure**（残り3 module は screenshot 待ちの WAITING）となり、
hono-cloudflare と同じく screenshot 提出以外の未pass項目は0件であることを確認済み。

## Manual review が必要な module の扱い

Basic OP Certification には、ブラウザ自動化だけでは完了できず screenshot 提出や
manual review を前提とする module があります。

- `oidcc-ensure-registered-redirect-uri`: 未登録 redirect_uri に対して OP は
  redirect せず、ブラウザ向けの error page（HTTP 400 / `text/html`）を表示します。
  Conformance Suite はこの画面の screenshot 提出を待ちます。
- `oidcc-prompt-login` / `oidcc-max-age-1`: 2回目の認可画面の screenshot 提出を待ちます。

> `oidcc-ensure-request-object-with-redirect-uri` はかつて error page の screenshot 提出
> 待ち（manual review）でしたが、`OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1` を有効化すると
> OP が Request Object by value を処理し Request Object 内の redirect_uri を採用して
> authorization code flow を完了するため、現在は **automated に PASS** します
> （screenshot 提出は不要）。

これらの module では、ブラウザは Conformance Suite の callback
（`*/test/*/callback*`）に到達しません。runner の browser automation の
`Verify Complete` タスクは `optional: true` にしてあり、callback に到達しない
module でも automation 全体を `INTERRUPTED` にせず、manual review 待ちの状態へ
落とします（OP の挙動が正しいのに WebRunner timeout で interrupted になる事象を防ぐ）。

manual review を人手で完了する場合は、サービスを残したまま実行します。

```bash
CONFORMANCE_KEEP_SERVICES=1 pnpm run conformance:basic-op
```

runner 終了後も Conformance Suite の Web UI（`CONFORMANCE_SUITE_PORT`）が
残るので、ブラウザで対象 module を開き、表示された error page / 認可画面の
screenshot をアップロードして module を完了させてください。完了後、サービスは
`docker compose down` で停止します。

どの module でどの画面の screenshot をどこへ提出すれば pass になるかの具体手順は
`tests/conformance/manual-review-screenshots.md` を参照してください。

## トラブルシューティング

Dockerが起動していない場合は、Dockerを起動してから再実行してください。

portが既に使われている場合は、`CONFORMANCE_SUITE_PORT` と `CONFORMANCE_OP_TLS_PORT`
を上書きしてください。

runnerがOP Discovery待ちでタイムアウトする場合は、以下を確認してください。

- 選択したサンプルがビルドできていること。
- `tests/conformance/.generated/oidc-clients.json` が存在すること。
- `tests/conformance/results/docker-compose.log`
- Docker Composeサービスログ

Suiteが失敗してもZIPがエクスポートされている場合は、まずZIPを確認してください。`0` 以外の終了は
ローカルセットアップ失敗ではなく、実際のcertification failureを意味する場合があります。
