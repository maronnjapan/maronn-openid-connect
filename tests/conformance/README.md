# OpenID Foundation Conformance Suite

このディレクトリは、`samples/*` 配下のOpenID Providerサンプルアプリに対して
OpenID Foundation Conformance Suiteを実行するためのものです。

## 対象のテストプラン

OpenID Connect Core の認定プランのうち、次の3つを static client で実行できます。

| プラン | コマンド | OIDF テストプラン |
|---|---|---|
| Basic OP | `pnpm run conformance:basic-op` | `oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]` |
| Implicit OP | `pnpm run conformance:implicit-op` | `oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]` |
| Hybrid OP | `pnpm run conformance:hybrid-op` | `oidcc-hybrid-certification-test-plan[server_metadata=discovery][client_registration=static_client]` |

どれも、選択したサンプルOPが OpenID Connect Conformance Profiles の static client profile を満たすかを確認します。
Suite本体は公式のprebuilt Docker imageを使い、公式の `run-test-plan.py` runner scriptで実行します。

同じ3つのプランを、Suite が自分でクライアントを登録する dynamic client registration の変種でも実行できます（後述の「Dynamic client registration で実行する」）。
`CONFORMANCE_CLIENT_REGISTRATION=dynamic` を付けると、テストプランの `client_registration` が `dynamic_client` になります。

| プラン | コマンド | OIDF テストプラン |
|---|---|---|
| Basic OP | `CONFORMANCE_CLIENT_REGISTRATION=dynamic pnpm run conformance:basic-op` | `oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=dynamic_client]` |
| Implicit OP | `CONFORMANCE_CLIENT_REGISTRATION=dynamic pnpm run conformance:implicit-op` | `oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=dynamic_client]` |
| Hybrid OP | `CONFORMANCE_CLIENT_REGISTRATION=dynamic pnpm run conformance:hybrid-op` | `oidcc-hybrid-certification-test-plan[server_metadata=discovery][client_registration=dynamic_client]` |

## Implicit OP

Implicit OP のプランは、Basic OP と同じ種類の module の多くを、`response_type=id_token` と `id_token token` の2通りで実行します（OpenID Connect Core 1.0 §3.2）。
UserInfo の3つの module と `oidcc-response-type-missing` は、`id_token token` で1回だけ実行します。
`oidcc-idtoken-signature` と `oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported` は static client を対象にしないので、Suite はプランからこの2つを外します。
そのため1回の実行は、自動で完了する48個の module と、manual review が必要な6個の module（後述の3つを response type ごとに）からなります。

このプランの module が使うクライアントは、Suite の設定の `client` だけです。
`create-op-config.mjs` は、OP に次の static client を登録します。

- `clientId`：`oidf-implicit-client`
- `responseTypes`：`id_token` と `id_token token`
- `grantTypes`：`implicit`（OpenID Connect Dynamic Client Registration 1.0 §2 で Implicit Flow の response type と組になる grant type）
- `tokenEndpointAuthMethods`：`none`。Implicit Flow のクライアントはトークンエンドポイントを使わないので、client secret を持たない public client として登録する

Implicit OP のプランは認可コードを発行しないので、`pnpm run conformance:implicit-op` は Basic OP 向けPKCE互換モード（後述）を有効にしません。
Request Object の module はこのプランにもあるので、unsigned Request Object の互換モードは Basic OP と同じく有効にします。

## Hybrid OP

Hybrid OP のプランは、Basic OP と同じ種類の module を、`response_type=code id_token`、`code token`、`code id_token token` の3通りで実行します（OpenID Connect Core 1.0 §3.3）。
`oidcc-response-type-missing`、`oidcc-alternate-happy-flow`、`oidcc-ensure-request-with-valid-pkce-succeeds` は `code id_token` の回だけで実行します。
nonce の module は response type で変わります。
認可エンドポイントが ID Token を返す `code id_token` と `code id_token token` では、nonce の無い要求を拒否する `oidcc-ensure-request-without-nonce-fails` を、ID Token を返さない `code token` では、nonce の無い要求が成功する `oidcc-ensure-request-without-nonce-succeeds-for-code-flow` を実行します（OpenID Connect Core 1.0 §3.3.2.11 と errata の NonceNotes）。
`oidcc-idtoken-signature` と `oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported` は、Implicit OP と同じく static client を対象にしないので、Suite はプランから外します。
そのため1回の実行は、自動で完了する87個の module（`code id_token` で31個、`code token` と `code id_token token` で28個ずつ）と、manual review が必要な9個の module（後述の3つを response type ごとに）からなります。

このプランの module が使うクライアントは、Basic OP と同じく Suite の設定の `client`、`client2`（`oidcc-refresh-token` の2つ目のクライアント）、`client_secret_post`（`oidcc-server-client-secret-post` のクライアント）です。
`create-op-config.mjs` は、OP に次の static client を3つ登録します。

- `clientId`：`oidf-hybrid-client`、`oidf-hybrid-client-2`、`oidf-hybrid-post-client`
- `responseTypes`：`code id_token`、`code token`、`code id_token token`
- `grantTypes`：`authorization_code`、`implicit`、`refresh_token`（OpenID Connect Dynamic Client Registration 1.0 §2 で Hybrid Flow の response type と組になる grant type）
- `tokenEndpointAuthMethods`：`client_secret_basic`（`oidf-hybrid-post-client` は `client_secret_post`）。認可コードをトークンエンドポイントで交換するので、client secret を持つ confidential client として登録する

Hybrid OP のプランは Basic OP と同じく PKCE 無しで認可コードを交換するので、`pnpm run conformance:hybrid-op` は Basic OP 向けPKCE互換モードを有効にします。
unsigned Request Object の互換モードも Basic OP と同じく有効にします。
CI での結果は、後述の「Hybrid OP（2026-10-20、CI）」に記します。

## Dynamic client registration で実行する

`CONFORMANCE_CLIENT_REGISTRATION=dynamic` を付けた実行では、`create-op-config.mjs` は OP に static client を登録しません（`oidc-clients.json` は空の配列になります）。
Suite は module ごとに、OP の discovery が公表する `registration_endpoint`（`POST /register`）へ自分のクライアントを登録してから module を実行します（OpenID Connect Dynamic Client Registration 1.0）。
Suite の設定の `client`、`client2`、`client_secret_post` には `client_name` だけを置き、`client_secret` と `jwks` はこの変種では Suite が自分で用意します。
`initial_access_token` は置かないので、OP は open registration（既定）で受け付けます。

Suite が登録リクエストに載せるメタデータは、`OIDCCCreateDynamicClientRegistrationRequest` が組み立てる次のものです。

- `client_name`、`redirect_uris`（Suite のコールバック URL）、`contacts`
- `response_types` と `token_endpoint_auth_method`（module の変種の値）
- `grant_types`。`code` を含む response type では `authorization_code`、`token` か `id_token` を含む response type では `implicit`。`oidcc-refresh-token` はこれに `refresh_token` を足す
- `jwks`。Suite が module ごとに生成した RS256 の公開鍵で、OP はこれを `request_object` の用途の鍵として登録し、Request Object の module ではこの鍵で署名を検証する
- `request_uris`。`oidcc-request-uri-*` の module が、Request Object を置く Suite の URL（`<Suite のベース URL>/test/a/<alias>/requesturi/<乱数>#<乱数の SHA-256>`）を登録する
- `id_token_signed_response_alg: none`。`oidcc-idtoken-unsigned` だけが足すが、この module は OP の `id_token_signing_alg_values_supported` に `none` が無ければ登録の前に自分を skip する

static client では Suite がプランから外す次の module が、この変種では実行されます。

| module | 内容 | この OP の挙動 |
|---|---|---|
| `oidcc-idtoken-signature` | alg を指定せずに登録したクライアントの ID Token が RS256 で署名され、ヘッダに `kid` を持つこと | 既定の `id_token_signed_response_alg` は RS256 で、署名鍵の `kid` をヘッダに載せるので PASS する |
| `oidcc-idtoken-unsigned` | `id_token_signed_response_alg: none` を登録して署名無しの ID Token を受け取ること | OP は `none` を広告せず登録も拒否するので、Suite は登録前に SKIPPED にする（認定上は許容される） |
| `oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported` | 登録した `request_uris` の URL に置いた unsigned Request Object を `request_uri` で渡して認可が完了するか、`request_uri_not_supported` で拒否されること | OP は登録済みの `request_uri` を GET して Request Object を検証し、認可を完了する（OIDC Core 1.0 §6.2）。unsigned を受理する互換モード `OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1` は static client と同じく既定で有効 |

そのため1回の実行の自動の module は、Basic OP で 35 個（static client の 32 個に `oidcc-idtoken-signature` と `oidcc-request-uri-unsigned-...` が加わり、`oidcc-idtoken-unsigned` は skip）、Implicit OP で 52 個、Hybrid OP で 93 個になります。
manual review の module は static client と同じ 3 個（Implicit OP は 6 個、Hybrid OP は 9 個）です。

この変種で OP 側に必要な設定は、`docker-compose.yml` が `op` サービスに渡します。

- `OIDC_DCR_MAX_CLIENTS=1000`。Suite は module ごとにクライアントを登録し（`oidcc-refresh-token` は 2 つ）、登録を削除しない（OP は RFC 7592 を実装せず、Suite は `registration_client_uri` が無ければ削除を飛ばす）ので、生成コードの既定の上限 100 を Hybrid OP の実行が超える
- `NODE_EXTRA_CA_CERTS=/workspace/tests/conformance/.generated/certs/conformance-nginx.crt`。`request_uri` の module では OP が Suite の nginx（`https://conformance-nginx:8443`）から Request Object を GET する。Suite の nginx image の証明書は `CN=localhost` で subject alternative name を持たないので、`ensure-op-tls-cert.sh` が `conformance-nginx` 向けの自己署名証明書を作り、`docker-compose.yml` が nginx image の証明書と鍵（`/etc/ssl/certs/nginx-selfsigned.crt`、`/etc/ssl/private/nginx-selfsigned.key`）の上にマウントする。Node.js の fetch も `wrangler dev`（miniflare は `NODE_EXTRA_CA_CERTS` の証明書を workerd の trusted certificates に渡す）もこの証明書を信頼する

この変種を実行できるのは、`--enable dynamic-client-registration` で生成した `hono-cloudflare` と `express-flyio` です。
`fastify-flyio` と `nextjs-vercel` を指定すると `create-op-config.mjs` がエラーで止まります。

### Dynamic OP の認定プランとの関係

OpenID Connect Conformance Profiles v3.0 の Dynamic OP は、Basic OP、Implicit OP、Config OP に加えて、OpenID Connect Discovery 1.0 と Dynamic Client Registration 1.0 の OP 機能（OpenID Connect Core 1.0 §15.2 の Mandatory to Implement Features for Dynamic OpenID Providers）を要求する別のプロファイルで、Suite では `oidcc-dynamic-certification-test-plan` です。
上の変種はこのプランではなく、Basic / Implicit / Hybrid OP の認定プランを dynamic client で通すものです。
`oidcc-dynamic-certification-test-plan` の module のうち、この OP がまだ満たさないものは次のとおりです。

- `private_key_jwt`。プランの大半の module は `client_auth_type=private_key_jwt` で走るが、生成コードのトークンエンドポイントは `client_secret_basic` / `client_secret_post` / `none` だけを検証する
- `oidcc-registration-jwks-uri`。`jwks_uri` を登録して OP が鍵を取得しに行くことを求める。登録エンドポイントは `jwks_uri` を受理し、OP は署名の検証のときにその URL から鍵を取得するので、この点は満たす。ただし module は `client_auth_type=private_key_jwt` でだけ走る
- `oidcc-registration-sector-uri` / `oidcc-registration-sector-bad`。`sector_identifier_uri` と pairwise の `subject_type` を求めるが、OP は `public` だけを広告する
- `oidcc-server-rotate-keys`。OP の署名鍵の手動ローテーションを求める
- `oidcc-refresh-token-rp-key-rotation`。`private_key_jwt` のクライアント鍵のローテーションを求める

`oidcc-request-uri-signed-rs256`（RS256 で署名した Request Object を `request_uri` で渡す）、`oidcc-request-uri-unsigned`、`oidcc-ensure-request-object-with-redirect-uri`、`oidcc-registration-jwks-uri`、`oidcc-registration-logo-uri` / `-policy-uri` / `-tos-uri`（登録した URL を同意画面に表示する SHOULD）は、`private_key_jwt` を除けばこの OP の実装で満たせます。

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

Implicit OP static-client planは次のコマンドで実行します。

```bash
pnpm run conformance:implicit-op
```

Hybrid OP static-client planは次のコマンドで実行します。

```bash
pnpm run conformance:hybrid-op
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
Implicit OP のプランも同じ指定でサンプルOPを選べます（例：`CONFORMANCE_SAMPLE_APP=nextjs-vercel pnpm run conformance:implicit-op`）。

### コマンドが行うこと

`pnpm run conformance:basic-op` と `pnpm run conformance:implicit-op` は、以下を順に実行します（`scripts/run-op.sh`）。

1. `@maronn-openid-connect/cli` をビルドする。
2. 選択したサンプルpackageをビルドする。
3. プランのOIDF static-client設定を `tests/conformance/.generated/` に生成する（`scripts/create-op-config.mjs`）。
4. OP TLSリバースプロキシ用と、Suite の nginx 用のローカル自己署名証明書を生成する（`scripts/ensure-op-tls-cert.sh`）。
5. Docker Composeサービスを起動する。
   - `mongodb`
   - `conformance-server`
   - `conformance-nginx`
   - `op`
   - `op-tls`
   - `runner`
6. Conformance Suite APIとOP Discoveryエンドポイントの起動を待つ。
7. `scripts/run-test-plan.py` でテストプランを実行する。
8. Dockerログとエクスポートされた結果ZIPを `tests/conformance/results/` に書き出す。
9. `CONFORMANCE_KEEP_SERVICES=1` が設定されていなければ、Docker Composeサービスを停止して削除する。

### 環境変数

- `CONFORMANCE_PLAN`: `basic`、`implicit`、`hybrid` のいずれか。`pnpm run conformance:basic-op`、`pnpm run conformance:implicit-op`、`pnpm run conformance:hybrid-op` は、それぞれのプランを `scripts/run-op.sh` の引数で渡します。
- `CONFORMANCE_CLIENT_REGISTRATION`: `static`（デフォルト）か `dynamic`。`dynamic` はテストプランの `client_registration` を `dynamic_client` にし、OP に static client を登録せず、Suite が `POST /register` で登録したクライアントで module を実行します（「Dynamic client registration で実行する」を参照）。`hono-cloudflare` と `express-flyio` だけが指定できます。
- `CONFORMANCE_SAMPLE_APP`: `hono-cloudflare`, `express-flyio`, `fastify-flyio`, `nextjs-vercel` のいずれか。
- `CONFORMANCE_SUITE_IMAGE_TAG`: OpenID Foundation image tag。デフォルトは `latest`。
- `CONFORMANCE_SUITE_REF`: `run-test-plan.py` 用にcloneする `openid/conformance-suite` のGit ref。デフォルトは `master`。
- `CONFORMANCE_SUITE_PORT`: Conformance Suite HTTPSエンドポイントのhost port。デフォルトは `8443`。
- `CONFORMANCE_OP_TLS_PORT`: サンプルOP HTTPS proxyのhost port。デフォルトは `3443`。
- `CONFORMANCE_SKIP_MANUAL_REVIEW`: `1` のとき、manual review が必要な3つの module（下記。Implicit OP では response type ごとに実行される6個、Hybrid OP では9個）を除いてプランを実行します。CI（`.github/workflows/conformance.yml`）は `1` で実行します。デフォルトはすべての module を実行します。
- `CONFORMANCE_KEEP_SERVICES=1`: runner終了後もDocker Composeサービスを残す。
- `CONFORMANCE_ALIAS`: コールバックURLに使うOIDF test alias。デフォルトは `maronn-basic-op`（Implicit OP では `maronn-implicit-op`、Hybrid OP では `maronn-hybrid-op`）。
- `CONFORMANCE_OP_ISSUER`: Compose内でサンプルOPが使うissuer。デフォルトは `https://op-tls:3443`。
- `CONFORMANCE_SUITE_BASE_URL`: Compose内でcallback URI生成に使うSuite base URL。デフォルトは `https://conformance-nginx:8443`。
- `OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW`: サンプルOPのBasic OP互換モード。`pnpm run conformance:basic-op` と `pnpm run conformance:hybrid-op` ではデフォルト `1`、`pnpm run conformance:implicit-op` ではデフォルト `0`。
- `OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT`: サンプルOPで unsigned（`alg:none`）Request Object を受理し、discovery の `request_object_signing_alg_values_supported` に `none` を広告する互換モード。`pnpm run conformance:basic-op`、`pnpm run conformance:implicit-op`、`pnpm run conformance:hybrid-op` ではデフォルト `1`（通常利用と E2E では未設定＝署名必須）。`oidcc-unsigned-request-object-...` / `oidcc-ensure-request-object-with-redirect-uri` は OP が unsigned 非対応を広告すると skip されるため、conformance run でのみ有効化する。dynamic client registration では `oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported` も同じ条件で実行される。
- `OIDC_DCR_MAX_CLIENTS`: サンプルOPの動的登録クライアントの上限。`docker-compose.yml` のデフォルトは `1000`（生成コードの既定は 100。dynamic client registration では Suite が module ごとに登録するため）。

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
など）を automated test target として走らせるため、`create-op-config.mjs` は
固定の RS256 鍵ペアを既定で両側に登録します。

- OP 側（`oidc-clients.json`）の static client には公開鍵 JWKS を登録し、OP が署名を検証
  できるようにする。
- Suite 側（`basic-op-config.json` の client / client2 / client_secret_post、`implicit-op-config.json` の client）には秘密鍵
  JWKS と `request_object_signing_alg: RS256` を登録し、Suite が同じ鍵で Request Object に
  署名できるようにする。

この鍵はローカル/CI の Docker conformance run 専用の使い捨て鍵で、本番の秘密情報では
ありません。OP が信頼する公開 JWKS だけを差し替えたい場合は、`CONFORMANCE_CLIENT_JWKS`
（JSON）で override できます（その場合は署名側の鍵と整合させること）。

### 出力

実行時設定は以下に生成されます。

- `tests/conformance/.generated/basic-op-config.json`（Implicit OP では `implicit-op-config.json`）
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

- `plan`: `basic`、`implicit`、`hybrid` のいずれか。デフォルトは `basic`。
- `client_registration`: `static`（デフォルト）か `dynamic`。`dynamic` は `hono-cloudflare` と `express-flyio` だけで実行できます。
- `sample_app`: `hono-cloudflare`, `express-flyio`, `fastify-flyio`, `nextjs-vercel` のいずれか。
- `suite_image_tag`: OpenID Foundation Conformance Suite image tag。通常は `latest`。

workflowでは以下を実行します（`<plan>` は選んだプラン、`<client_registration>` は選んだクライアント登録）。manual review が必要な module は除きます（`CONFORMANCE_SKIP_MANUAL_REVIEW=1`、[実行時間](#実行時間)を参照）。

```bash
pnpm install --frozen-lockfile
CONFORMANCE_SKIP_MANUAL_REVIEW=1 CONFORMANCE_CLIENT_REGISTRATION=<client_registration> pnpm run conformance:<plan>-op
```

Suiteが失敗した場合でも、以下を `oidf-<plan>-op-<client_registration>-conformance` artifactとしてアップロードします。

- `tests/conformance/results`
- `tests/conformance/.generated`

### Pull Requestでの実行

Pull Requestに `run-conformance` labelが付いている場合もworkflowを実行します。
Conformance Suiteは重いので通常のPR経路からは外し、必要な変更に対してmaintainerが
Basic OP checkを要求できるようにしています。
このときは Basic OP、Implicit OP、Hybrid OP の3つのプランを、static client と dynamic client registration の両方で、別々のjob（`basic-op-static`、`basic-op-dynamic`、`implicit-op-static`、`implicit-op-dynamic`、`hybrid-op-static`、`hybrid-op-dynamic`）で実行します。
sample_app は `hono-cloudflare` です。

PR triggerの対象pathは以下に限定しています。

- `packages/**`
- `apps/**`
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
`samples/fastify-flyio`（起動側 `app.ts`）と `samples/nextjs-vercel`（CLI生成 `_oidc-provider/provider.ts`）
にも適用済み。`CONFORMANCE_SAMPLE_APP=nextjs-vercel` でのCI実行でも **32 passed / 0 warning /
0 skipped / 0 condition failure**（残り3 module は screenshot 待ちの WAITING）となり、
hono-cloudflare と同じく screenshot 提出以外の未pass項目は0件であることを確認済み。

### Implicit OP（2026-10-20、ローカル実行）

`oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]` は、ローカル実行で確認した。
Conformance Suite は、`openid/conformance-suite` の master（`aff94d6`）をソースからビルドしたものを使った。

`samples/hono-cloudflare` に対する最初の実行では、manual review を除く48個の module のうち47個が PASSED、1個が WARNING だった。
WARNING は `response_type=id_token` の `oidcc-claims-essential` で、`claims` パラメータの `id_token` メンバーで要求された `name` が ID Token に入っていなかった（OpenID Connect Core 1.0 §5.5）。
`response_type=id_token` はアクセストークンを発行しないので、このクレームを返せるのは ID Token だけである。
`implicit-flow` が core の `applyRequestedIdTokenClaims()` でこのクレームを ID Token に入れるようにした後の結果は、次のとおり。

| サンプル | 自動の48 module | manual review の6 module |
|---|---|---|
| `hono-cloudflare` | 48 PASSED（FAILURE 0、WARNING 0） | FAILURE 0 のまま screenshot 提出待ち |
| `express-flyio` | 48 PASSED（FAILURE 0、WARNING 0） | 未実行 |
| `fastify-flyio` | 48 PASSED（FAILURE 0、WARNING 0） | 未実行 |
| `nextjs-vercel` | 48 PASSED（FAILURE 0、WARNING 0） | 未実行 |

`hono-cloudflare` の manual review の module は、どれも screenshot の提出だけが残った。
`oidcc-prompt-login` と `oidcc-max-age-1` は、2回目のログイン画面の表示と、2回目の認可で返った ID Token の検証（`auth_time` が新しくなっていること）までが SUCCESS だった。
`oidcc-ensure-registered-redirect-uri` は、OP がリダイレクトせずに error page（HTTP 400）を表示するところまでが SUCCESS だった。

この実行では、conformance の構成の不具合も2つ見つかり、直した。
どちらもプランによらない不具合で、Basic OP の実行にも影響する。

- `oidcc-ensure-registered-redirect-uri` が WebRunner の timeout で INTERRUPTED になっていた。browser automation の `Verify Complete` の URL パターン `*/test/*/callback*` が、`redirect_uri` クエリにコールバック URL を含む OP の error page の URL にも一致していたためである。パターンを Suite のベース URL から始めるようにしてからは、Basic OP の同じ module も screenshot 提出待ちで止まる
- `express-flyio`、`fastify-flyio`、`nextjs-vercel` の OP が起動しなかった。読み取り専用でマウントしたリポジトリの中に、node:sqlite のデータベース（`.data/oidc.sqlite`）を作ろうとしたためである。`OIDC_SQLITE_PATH` で `/tmp` に置くようにしてから、上表の結果になった（`express-flyio` の Basic OP も、manual review を除く32 module が PASSED）

### Hybrid OP（2026-10-20、CI）

`oidcc-hybrid-certification-test-plan[server_metadata=discovery][client_registration=static_client]` は、GitHub Actions の `OpenID Conformance` workflow で確認した。
`samples/hono-cloudflare` は Pull Request #148 に `run-conformance` label を付けた実行で、ほかの3つのサンプルは `plan: hybrid` の手動実行で確かめた。
Conformance Suite は、`registry.gitlab.com/openid/conformance-suite:latest` の Docker image を使った。

4つのサンプルのどれでも、manual review を除く87個の module がすべて PASSED だった。
Suite が数えた condition は、どのサンプルでも 6264 個の SUCCESS で、FAILURE と WARNING は 0 だった。

| サンプル | 自動の87 module | manual review の9 module |
|---|---|---|
| `hono-cloudflare` | 87 PASSED（FAILURE 0、WARNING 0） | 未実行 |
| `express-flyio` | 87 PASSED（FAILURE 0、WARNING 0） | 未実行 |
| `fastify-flyio` | 87 PASSED（FAILURE 0、WARNING 0） | 未実行 |
| `nextjs-vercel` | 87 PASSED（FAILURE 0、WARNING 0） | 未実行 |

response type ごとの内訳は、次のとおり。

| response type | 自動の module | 結果 |
|---|---|---|
| `code id_token` | 31 | 31 PASSED（FAILURE 0、WARNING 0） |
| `code token` | 28 | 28 PASSED（FAILURE 0、WARNING 0） |
| `code id_token token` | 28 | 28 PASSED（FAILURE 0、WARNING 0） |

module の実行には合計 130 秒ほどかかり、そのうち 90 秒は `oidcc-codereuse-30seconds` が3回待つ時間である。

Hybrid Flow に固有の検査も、この実行で通った。
`oidcc-server` は、認可エンドポイントが返した ID Token の `c_hash` と `at_hash`、認可レスポンスがフラグメントだけに載ること、両エンドポイントの ID Token の `sub` が一致することを検査する。
`oidcc-codereuse` は、再利用された認可コードを `invalid_grant` で拒否し、フラグメントで返した Access Token も失効することを検査する。
nonce の module は、`code id_token` と `code id_token token` で nonce の無い要求が `invalid_request` になり、`code token` で成功することを検査する。

manual review が必要な9個の module は、CI では `CONFORMANCE_SKIP_MANUAL_REVIEW=1` で除いている。
screenshot の提出までは、まだ確かめていない。
手順は `manual-review-screenshots.md` にある。

### Dynamic client registration（未実行）

dynamic client registration の変種は、この README を書いた時点ではまだ実行していません（実装した環境に Docker が無かったためです）。
`run-conformance` label を付けた Pull Request、または `client_registration: dynamic` の手動実行で結果を確かめ、ここに記録してください。
確かめる点は次のとおりです。

- Suite の登録リクエストを `POST /register` が 201 で受け付け、`request_uris` と `jwks` が登録されること
- `oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported` が、OP が Suite の `request_uri` を取得して PASSED になること（`request_uri_not_supported` で SKIPPED にならないこと）
- `oidcc-idtoken-signature` が PASSED、`oidcc-idtoken-unsigned` が SKIPPED になること
- static client で PASSED だった module が、dynamic client でも同じ結果になること

## 実行時間

- `op` サービスは Discovery に応答するまで healthy にならず、`op-tls` と `runner` は healthy になってから起動します。OP が起動しない場合は、約3分で `docker compose up` が失敗します。
- `op` サービスはリポジトリを読み取り専用でマウントするので、`wrangler dev`（`hono-cloudflare`）が書き込む `samples/<サンプル>/.wrangler/` だけを tmpfs にしています。マウントポイントは `run-op.sh` が作ります。
- OP のデータは `/tmp` に置きます。`hono-cloudflare` の D1 は `OIDC_D1_PERSIST_PATH`、node:sqlite を使う `express-flyio`、`fastify-flyio`、`nextjs-vercel` のデータベースは `OIDC_SQLITE_PATH` で指定します（既定の `.data/oidc.sqlite` は読み取り専用のリポジトリの中なので、OP が起動しません）。
- manual review が必要な module は screenshot の提出を待つので、`run-test-plan.py` は1つにつき240秒待ってから打ち切ります。`CONFORMANCE_SKIP_MANUAL_REVIEW=1` はこの待ち時間（Basic OP は3つで約12分、Implicit OP は6つで約24分、Hybrid OP は9つで約36分）を省きます。
- static client の設定は `alias` を持つので、`run-test-plan.py` は module を並列に実行しません。

## Manual review が必要な module の扱い

Basic OP Certification には、ブラウザ自動化だけでは完了できず screenshot 提出や
manual review を前提とする module があります。

- `oidcc-ensure-registered-redirect-uri`: 未登録 redirect_uri に対して OP は
  redirect せず、ブラウザ向けの error page（HTTP 400 / `text/html`）を表示します。
  Conformance Suite はこの画面の screenshot 提出を待ちます。
- `oidcc-prompt-login` / `oidcc-max-age-1`: 2回目の認可画面の screenshot 提出を待ちます。

Implicit OP のプランにも同じ3つの module があり、Suite はそれぞれを `response_type=id_token` と `id_token token` で実行します。
Hybrid OP のプランでは、`response_type=code id_token`、`code token`、`code id_token token` の3通りで実行します。

> `oidcc-ensure-request-object-with-redirect-uri` はかつて error page の screenshot 提出
> 待ち（manual review）でしたが、`OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT=1` を有効化すると
> OP が Request Object by value を処理し Request Object 内の redirect_uri を採用して
> authorization code flow を完了するため、現在は **automated に PASS** します
> （screenshot 提出は不要）。

`oidcc-ensure-registered-redirect-uri` では、ブラウザは Conformance Suite の callback
（`<Suite のベース URL>/test/*/callback*`）に到達しません。runner の browser automation の
`Verify Complete` タスクは `optional: true` にしてあり、callback に到達しない
module でも automation 全体を `INTERRUPTED` にせず、manual review 待ちの状態へ
落とします（OP の挙動が正しいのに WebRunner timeout で interrupted になる事象を防ぐ）。
このパターンを Suite のベース URL から始めるのは、認可リクエストの `redirect_uri` クエリにもコールバック URL が入るためです。
`*/test/*/callback*` だと OP の error page の URL にも一致し、browser automation は届かない `submission_complete` を待って timeout します。

manual review を人手で完了する場合は、サービスを残したまま実行します（Implicit OP では `conformance:implicit-op`、Hybrid OP では `conformance:hybrid-op`）。

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

dynamic client registration の `oidcc-request-uri-*` module で OP が `invalid_request_uri`（`request_uri could not be retrieved`）を返す場合は、OP が Suite の nginx の証明書を信頼できていません。
`tests/conformance/.generated/certs/conformance-nginx.crt` があること、`docker-compose.yml` が `conformance-nginx` にその証明書と鍵をマウントし、`op` に `NODE_EXTRA_CA_CERTS` で渡していることを確認してください。
証明書は 30 日で失効するので、古い `.generated/certs/` を消して作り直します。

portが既に使われている場合は、`CONFORMANCE_SUITE_PORT` と `CONFORMANCE_OP_TLS_PORT`
を上書きしてください。

runnerがOP Discovery待ちでタイムアウトする場合は、以下を確認してください。

- 選択したサンプルがビルドできていること。
- `tests/conformance/.generated/oidc-clients.json` が存在すること。
- `tests/conformance/results/docker-compose.log`
- Docker Composeサービスログ

Suiteが失敗してもZIPがエクスポートされている場合は、まずZIPを確認してください。`0` 以外の終了は
ローカルセットアップ失敗ではなく、実際のcertification failureを意味する場合があります。
