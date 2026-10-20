# Basic OP Conformance: manual review module の screenshot 提出手順

OpenID Connect Basic OP static-client profile の Conformance Suite には、ブラウザ自動化
だけでは `FINISHED` まで到達せず、**人手での screenshot 提出 / manual review** を前提と
する module が含まれます。OP の実装が正しくても、これらの module は screenshot を
アップロードするまで Suite 上で PASS（緑）になりません。

このドキュメントは、`tests/conformance` のローカル実行で残る manual review module に対し、
どの画面の screenshot を、どこに提出すれば各 module が pass 扱いになるかの手順をまとめます。

> 前提知識・実行の全体像は `tests/conformance/README.md` を参照してください。本書はその
> 「Manual review が必要な module の扱い」節の操作手順を具体化したものです。

## 直近の実行結果（2026-06-25, `samples/hono-cloudflare`, CI）

`oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]`
を `samples/hono-cloudflare`（`OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW=1` /
`OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1` の Basic OP 互換モード）に対し GitHub Actions
`OpenID Conformance` workflow で実行した結果は次のとおりで、**OP 実装ロジック由来の
FAILURE は 0 件**、かつ **screenshot 提出以外のスキップ・エラー・Warning は 0 件**です。

| 結果 | 数 | 内容 |
|---|---|---|
| PASSED | 32 | 主要フロー（authorization code / token / userinfo / scope / prompt=none / max-age-10000 / id_token_hint / refresh_token / codereuse / client_secret_post）＋ **acr_values**（acr resolver 配線後 PASSED）＋ **request object 2件**（unsigned 互換モードで PASSED） |
| SKIPPED | 0 | （以前 skip だった request object 2 module は PASSED に変化） |
| WARNING | 0 | （以前 warning だった acr module は PASSED に変化） |
| FAILED (manual) | 1 | `oidcc-ensure-registered-redirect-uri`（error page 表示は正しく、唯一の FAILURE は `Web Runner Exception: Timed out waiting: submission_complete`=callback 未到達の WebRunner timeout） |
| INTERRUPTED (manual) | 2 | `oidcc-prompt-login` / `oidcc-max-age-1`（2回目ログイン・token 交換まで SUCCESS、REVIEW=screenshot 待ち） |

下表の 3 module はいずれも OP が正しく動作したうえで screenshot 提出待ち / manual review に
落ちたものです。本手順で screenshot を提出すれば各 module を pass にできます。

> `oidcc-ensure-registered-redirect-uri` の WebRunner timeout は、OP ではなく browser automation の設定が原因でした。
> `Verify Complete` の URL パターン `*/test/*/callback*` は、`redirect_uri` クエリにコールバック URL を含む認可リクエストの URL（OP の error page の URL）にも一致します。
> そのため browser automation は error page の上で、届かない `submission_complete` を待っていました。
> 現在のパターンは Suite のベース URL から始まる（`https://conformance-nginx:8443/test/*/callback*`）ので、この module もほかの 2 つと同じく screenshot 提出待ちで止まります。

## 対象 module

`samples/hono-cloudflare`（および他 sample）の OP に対する Basic OP static-client plan で、manual
review が必要なのは次の module です。

| module | Suite が要求する screenshot | OP が表示する画面 |
|---|---|---|
| `oidcc-ensure-registered-redirect-uri` | 未登録 `redirect_uri` に対する **error page** | `<title>Error</title>` / `<h1>Error</h1>`（HTTP 400, `text/html`）に OAuth error code を表示 |
| `oidcc-prompt-login` | **2回目のログイン画面** | `<title>Login</title>` / `<h1>Login</h1>` の login form（`prompt=login` で再認証を強制） |
| `oidcc-max-age-1` | **2回目のログイン画面** | 同上の login form（`max_age=1` の経過で再認証を強制） |

> `oidcc-ensure-request-object-with-redirect-uri` はかつて error page screenshot 提出待ち
> でしたが、`OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1` で OP が Request Object by value を
> 処理し authorization code flow を完了するため、現在は automated に PASS します（screenshot
> 不要）。

いずれも OP の挙動自体は正しく、

- error page module: OP は未登録／不正 `redirect_uri` に **redirect せず** error page を
  表示する（redirect すると open redirect になるため正しい）。ブラウザは Suite の callback
  （`https://conformance-nginx:8443/test/*/callback*`）に到達しないので、browser automation の `Verify Complete` は
  optional 化してある（README 参照）。そのため module は INTERRUPTED ではなく manual
  review 待ち（FAILED/UNKNOWN 表示のまま screenshot 提出待ち）で止まる。
- login 画面 module: 2回目の認可・token exchange までは自動で成功するが、Suite は
  「2回目に確かに login 画面が再表示されたこと」の視覚的証跡として screenshot を要求する。

Implicit OP static-client plan（`pnpm run conformance:implicit-op`）にも同じ 3 つの module があります。
Suite はそれぞれを `response_type=id_token` と `id_token token` で実行するので、manual review が必要な module は 6 つになります。
OP が表示する画面は上表と同じです。
login 画面 module では token exchange の代わりに、2回目の認可でフラグメントに返った ID Token（`id_token token` では Access Token も）を Suite が自動で検証し、screenshot だけが残ります。

## 手順

### 1. サービスを残したまま Suite を実行する

runner 終了後も Conformance Suite の Web UI を残すため、`CONFORMANCE_KEEP_SERVICES=1` を
付けて実行します（repository root で実行）。

```bash
CONFORMANCE_KEEP_SERVICES=1 pnpm run conformance:basic-op
```

Implicit OP のプランでは、次のコマンドで実行します。

```bash
CONFORMANCE_KEEP_SERVICES=1 pnpm run conformance:implicit-op
```

- 自動 module（authorization code / token / userinfo / scope / prompt=none / id_token_hint /
  refresh_token / code reuse など）は runner が自動で `FINISHED` にします。
- 上表の manual review module は screenshot 提出待ちで残ります。
- runner の exit code は manual review が未完のため `0` 以外になります。これは **OP の
  failure ではなく**、screenshot 未提出を表します（`results/*.zip` と本手順で切り分け）。

### 2. Suite Web UI を開く

ブラウザで Suite の host ポート（既定 `https://localhost:8443/`、`CONFORMANCE_SUITE_PORT`
で変更可）を開きます。自己署名証明書なので警告は許可して進みます。

実行した test plan を開くと、各 module の状態（PASSED / WARNING / REVIEW / FAILED など）が
一覧表示されます。上表の module は緑になっていないはずです。

### 3. error page module の screenshot を提出する

対象 module（`oidcc-ensure-registered-redirect-uri` /
`oidcc-ensure-request-object-with-redirect-uri`）のログ詳細
（`log-detail.html?log=<id>`、runner ログにも URL が出力される）を開きます。

1. ログ中の REVIEW ステップ（`Show redirect URI error page` 相当）に、ブラウザが最後に
   到達した URL（OP の authorization endpoint）が記録されています。
2. その URL を新しいタブで開くと、OP が `<h1>Error</h1>` の error page（HTTP 400）を
   表示します。表示される OAuth error code（例: `invalid_request` / `redirect_uri` の
   不一致）と error_description が読めることを確認します。
3. その error page をブラウザで screenshot に撮ります（URL バーと本文が写るようにする）。
4. Suite のログ詳細画面の screenshot アップロード欄（`Upload an image` / file 選択）に
   撮った画像をアップロードし、コメントを添えて提出します。

提出後、module は manual review 完了として PASS（または REVIEW 済み）に遷移します。

### 4. login 画面 module の screenshot を提出する

対象 module（`oidcc-prompt-login` / `oidcc-max-age-1`）のログ詳細を開きます。

1. ログには 1回目・2回目の authorization request が記録されています。2回目は
   `prompt=login` もしくは `max_age=1` により OP が **再ログインを要求**します。
2. ログの該当ステップに記録された 2回目 authorization request の URL を開くと、OP は
   既存 session があっても `<h1>Login</h1>` の login form を再表示します（これが検証点）。
3. その login 画面を screenshot に撮ります。
4. Suite のログ詳細画面の screenshot アップロード欄にアップロードして提出します。

提出後、module は manual review 完了として PASS に遷移します。

### 5. 全 module が緑になったことを確認する

Web UI の plan 画面で、上表の 4 module が PASS（または許容される REVIEW 済み）になり、
残りの自動 module と合わせて、OP failure（赤の FAILED で原因が OP ロジック）の module が
0 件であることを確認します。

確認できたら、results にエクスポートされた ZIP（`tests/conformance/results/*.zip`）を
証跡として保管します。

### 6. サービスを停止する

```bash
docker compose -f tests/conformance/docker-compose.yml down -v --remove-orphans
```

## acr / request object module（現在は PASS）

以下はかつて WARNING / SKIPPED だったが、sample 起動側の配線追加で **PASSED** になった
（screenshot 不要）。

- `oidcc-ensure-request-with-acr-values-succeeds`: sample OP に `acr_values` の最優先値を
  `acr` として返す `AcrResolver` を配線したため PASSED（以前は SHOULD 未対応で WARNING）。
- `oidcc-unsigned-request-object-...` / `oidcc-ensure-request-object-with-redirect-uri`:
  `OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1` で OP が unsigned Request Object を受理し discovery
  に `none` を広告するため、Suite が両 module を run して PASSED（以前は unsigned 非対応の
  ため SKIPPED）。

## 判定の考え方

manual review module の未完は **OP 実装の不合格ではありません**。OP failure は
`results/*.zip` 内 test-log の `result: "FAILED"` かつ原因が OP の応答（state/nonce 不一致、
署名不正、必須 claim 欠落など）である場合を指します。上表の module は OP が正しく error
page / login 画面を返したうえで Suite が screenshot を待っている状態なので、本手順の
screenshot 提出で完了します。
