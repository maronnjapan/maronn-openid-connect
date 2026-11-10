# OpenID Foundation Conformance Suite

このディレクトリは、`samples/*` 配下のOpenID Providerサンプルアプリに対して
OpenID Foundation Conformance Suiteを実行するためのものです。

## 対象のテストプラン

OpenID Connect Core の認定プランのうち、次の5つを実行できます。

| プラン | コマンド | OIDF テストプラン |
|---|---|---|
| Basic OP | `pnpm run conformance:basic-op` | `oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]` |
| Implicit OP | `pnpm run conformance:implicit-op` | `oidcc-implicit-certification-test-plan[server_metadata=discovery][client_registration=static_client]` |
| Hybrid OP | `pnpm run conformance:hybrid-op` | `oidcc-hybrid-certification-test-plan[server_metadata=discovery][client_registration=static_client]` |
| Dynamic OP | `pnpm run conformance:dynamic-op` | `oidcc-dynamic-certification-test-plan[response_type=code]` |
| Config OP | `pnpm run conformance:config-op` | `oidcc-config-certification-test-plan` |

Basic OP、Implicit OP、Hybrid OP は、選択したサンプルOPが OpenID Connect Conformance Profiles の static client profile を満たすかを確認します。
Dynamic OP は、Suite が自分でクライアントを動的登録し（RFC 7591）、そのクライアントが private_key_jwt で認証するプロファイルです。
Config OP は、discovery の文書と JWKS だけを確認します。
Dynamic OP の認定は、Basic OP、Implicit OP、Config OP への適合を前提とします。
Suite本体は公式のprebuilt Docker imageを使い、公式の `run-test-plan.py` runner scriptで実行します。

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

## Dynamic OP

Dynamic OP のプランは、次の23個の module からなります（Suite の `OIDCCDynamicTestPlan`）。

| 種類 | module |
|---|---|
| 自動（16個） | `oidcc-idtoken-rs256`、`oidcc-idtoken-unsigned`、`oidcc-userinfo-rs256`、`oidcc-redirect-uri-query-OK`、`oidcc-redirect-uri-regfrag`、`oidcc-discovery-endpoint-verification`、`oidcc-server`、`oidcc-registration-jwks-uri`、`oidcc-registration-sector-uri`、`oidcc-registration-sector-bad`、`oidcc-refresh-token-rp-key-rotation`、`oidcc-request-uri-unsigned`、`oidcc-request-uri-signed-rs256`、`oidcc-ensure-request-object-with-redirect-uri`、`oidcc-refresh-token`、`oidcc-ensure-client-assertion-with-iss-aud-succeeds` |
| screenshot 提出（6個） | `oidcc-ensure-redirect-uri-in-authorization-request`、`oidcc-redirect-uri-query-mismatch`、`oidcc-redirect-uri-query-added`、`oidcc-registration-logo-uri`、`oidcc-registration-policy-uri`、`oidcc-registration-tos-uri` |
| 手動開始（1個） | `oidcc-server-rotate-keys` |

自動の16個のうち3個は、OP が対応しない機能を確かめる module なので、Suite が SKIPPED にします。
認定ではどれも許容されます。

- `oidcc-idtoken-unsigned`：OP は `alg=none` の ID Token を発行せず、`id_token_signing_alg_values_supported` に `none` を広告しない（OAuth 2.1 寄りの方針）
- `oidcc-registration-sector-uri`、`oidcc-registration-sector-bad`：OP は pairwise の subject を持たず、`subject_types_supported` は `public` だけ

`run-test-plan.py` は、知らされていない SKIPPED があると、FAILURE と WARNING が 0 でも 0 以外で終わります（`** SOME TEST MODULES WERE UNEXPECTEDLY SKIPPED **`）。
そのため `create-op-config.mjs` は、この3つを `expected-skips.json` に書き、`scripts/run-suite-runner.sh` が `--expected-skips-file` で渡します（Suite 自身の CI の `.gitlab-ci/expected-skips-*.json` と同じ形）。
`run-test-plan.py` は、書いた module が SKIPPED にならなかったときも 0 以外で終わるので、pairwise を実装して2つの module が動くようになったら、一覧から外します。
ほかのプランの一覧は空です。

このプランのクライアントは、どれも Suite が module ごとに `POST /register` で登録します。
登録は `token_endpoint_auth_method: private_key_jwt` と、Suite が作った RS256 の鍵（module によっては `jwks` の代わりに Suite が公開する `jwks_uri`）を送り、トークンエンドポイントでは Suite がその鍵で署名したクライアントアサーションで認証します（OpenID Connect Core 1.0 §9）。
`create-op-config.mjs` は OP に static client を登録せず（`oidc-clients.json` は空の配列）、Suite の設定には登録に使う `client_name` だけを書きます。
そのため、`fastify-flyio` と `nextjs-vercel` のサンプルも `--enable dynamic-client-registration` で生成しています（`hono-cloudflare` と `express-flyio` は以前から有効）。

このプランの検査と、それを満たす OP の機能は次のとおりです。

| module | OP の機能 |
|---|---|
| `oidcc-server`、`oidcc-refresh-token`、`oidcc-ensure-client-assertion-with-iss-aud-succeeds` | private_key_jwt のクライアント認証。`aud` にトークンエンドポイントの URL か issuer を含むアサーションを受け付け、`jti` の再利用を拒否する |
| `oidcc-registration-jwks-uri`、`oidcc-refresh-token-rp-key-rotation` | `jwks_uri` の鍵でアサーションを検証し、見慣れない `kid` では `jwks_uri` を取り直す（既定で30秒に1回まで。Suite は60秒待ってから新しい鍵で署名する） |
| `oidcc-request-uri-unsigned`、`oidcc-request-uri-signed-rs256` | `request_uri` から Request Object を取得する（OpenID Connect Core 1.0 §6.2）。Suite は `request_uris` をランダムなフラグメント付きで登録し、OP はフラグメントを除いて GET する |
| `oidcc-registration-logo-uri`、`oidcc-registration-policy-uri`、`oidcc-registration-tos-uri` | ログイン画面と同意画面が、登録した `client_name`、`logo_uri`、`policy_uri`、`tos_uri` を表示する |
| `oidcc-server-rotate-keys` | サンプルの `POST /operator/signing-keys/rotate` で、新しい鍵を JWKS の先頭に足し、古い鍵を残す（OpenID Connect Core 1.0 §10.1.1） |

プランのバリアントのうち、`server_metadata=discovery`、`client_registration=dynamic_client`、`client_auth_type=private_key_jwt`、`response_mode=default` はプラン自身が module ごとに決めます（Suite の `OIDCCDynamicTestPlan`）。
Suite はこれらを重ねて指定したプランを作らない（`Variant 'client_auth_type' has been set by user, but test plan already sets this variant`）ので、テストプランの文字列には、試験者が選ぶ `response_type=code` だけを付けます。

Dynamic OP のプランは Basic OP と同じく PKCE 無しで認可コードを交換するので、`pnpm run conformance:dynamic-op` は Basic OP 向けPKCE互換モードを有効にします。
`oidcc-request-uri-unsigned` と `oidcc-ensure-request-object-with-redirect-uri` は unsigned の Request Object を送るので、unsigned Request Object の互換モードも Basic OP と同じく有効にします。

### OP からの外向き TLS

このプランでは、OP が Suite の URL を取得します。
`jwks_uri`（`oidcc-registration-jwks-uri`、`oidcc-refresh-token-rp-key-rotation`）と `request_uri`（`oidcc-request-uri-*`）は、どれも `https://conformance-nginx:8443/...` です。
Suite の nginx の image が持つ証明書は `CN=localhost` の自己署名で、`conformance-nginx` の名前を含みません。
そのため、`scripts/ensure-op-tls-cert.sh` が実行ごとの使い捨ての CA（`.generated/certs/ca.crt`）を作り、次の2つの証明書をその CA で発行します。

- `op-tls.crt`：サンプルOPの HTTPS プロキシ（`op-tls:3443`）の証明書。`op-tls`、`localhost`、`127.0.0.1` を含む
- `conformance-nginx.crt`：Suite の HTTPS プロキシ（`conformance-nginx:8443`）の証明書。`docker-compose.yml` が nginx の image の自己署名証明書の位置にマウントする

`op` サービスは `NODE_EXTRA_CA_CERTS` でこの CA を信頼します。
Node.js で動く `express-flyio`、`fastify-flyio`、`nextjs-vercel` は Node.js がこの変数を読み、`wrangler dev` で動く `hono-cloudflare` は Miniflare がこの変数の証明書を workerd に渡します（`trustedCertificates`）。
TLS の検証は止めません（`NODE_TLS_REJECT_UNAUTHORIZED=0` は使いません）。
CA と鍵はこの実行のためだけのもので、ほかの何の秘密でもありません。
既にあるファイルは作り直さないので、続けて実行しても同じ CA を使います。

### discovery の拡張メタデータ

Dynamic OP と Config OP のプランの `oidcc-discovery-endpoint-verification` は、RFC 8414 と OpenID Connect Discovery 1.0 に無い discovery の項目を WARNING にします（`CheckForUnexpectedParametersInServerMetadata`）。
`hono-cloudflare` は `--enable id-jag` で生成しているので、discovery に Identity Assertion JWT Authorization Grant（draft-ietf-oauth-identity-assertion-authz-grant §7）の `identity_chaining_requested_token_types_supported` と `authorization_grant_profiles_supported` が入ります。
Suite は、試験者がこうした拡張の項目の名前を設定の `server.allow_unexpected_metadata_fields` に並べると、その項目だけを警告から外します。
`create-op-config.mjs` は、この module を含むプランで、サンプルが意図して出す拡張の項目（`hono-cloudflare` ではこの2つ）だけをここに並べます。
ほかの項目が増えれば、これまでどおり WARNING になります。
ほかの3つのサンプルは拡張の項目を出さないので、何も並べません。

## Config OP

Config OP のプランは、`oidcc-discovery-endpoint-verification` の1個の module からなり、discovery の文書と JWKS を確かめます。
バリアント（`server_metadata=discovery`、`client_registration=static_client`）はプラン自身が決めるので、テストプランの文字列にバリアントを付けません。
OP にクライアントは要らないので、`create-op-config.mjs` は static client を登録しません（`oidc-clients.json` は空の配列）。
認可コードを交換しないので、`pnpm run conformance:config-op` は Basic OP 向けPKCE互換モードを有効にしません。

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

Dynamic OP と Config OP のプランは次のコマンドで実行します。

```bash
pnpm run conformance:dynamic-op
pnpm run conformance:config-op
```

ランナーは公式のprebuilt Conformance Suite imageを使い、サンプルOPをHTTPSリバース
プロキシの後ろで起動します。そのうえで、SuiteのコールバックURLに合わせたstatic
client metadata（Dynamic OP と Config OP では空）を生成し、結果ZIPを `tests/conformance/results/` に出力します。

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
ほかのプランも同じ指定でサンプルOPを選べます（例：`CONFORMANCE_SAMPLE_APP=nextjs-vercel pnpm run conformance:dynamic-op`）。

### コマンドが行うこと

`pnpm run conformance:<plan>-op` は、以下を順に実行します（`scripts/run-op.sh`）。

1. `@maronn-openid-connect/cli` をビルドする。
2. 選択したサンプルpackageをビルドする。
3. プランのOIDF設定を `tests/conformance/.generated/` に生成する（`scripts/create-op-config.mjs`）。
4. 実行用の CA と、それが発行する OP TLSリバースプロキシと Suite の nginx の証明書を生成する（`scripts/ensure-op-tls-cert.sh`。[OP からの外向き TLS](#op-からの外向き-tls) を参照）。
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

- `CONFORMANCE_PLAN`: `basic`、`implicit`、`hybrid`、`dynamic`、`config` のいずれか。`pnpm run conformance:<plan>-op` は、それぞれのプランを `scripts/run-op.sh` の引数で渡します。
- `CONFORMANCE_SAMPLE_APP`: `hono-cloudflare`, `express-flyio`, `fastify-flyio`, `nextjs-vercel` のいずれか。
- `CONFORMANCE_SUITE_IMAGE_TAG`: OpenID Foundation image tag。デフォルトは `latest`。
- `CONFORMANCE_SUITE_REF`: `run-test-plan.py` 用にcloneする `openid/conformance-suite` のGit ref。デフォルトは `master`。
- `CONFORMANCE_SUITE_PORT`: Conformance Suite HTTPSエンドポイントのhost port。デフォルトは `8443`。
- `CONFORMANCE_OP_TLS_PORT`: サンプルOP HTTPS proxyのhost port。デフォルトは `3443`。
- `CONFORMANCE_SKIP_MANUAL_REVIEW`: `1` のとき、manual review が必要な module（下記。Basic OP では3つ、Implicit OP では response type ごとに実行される6個、Hybrid OP では9個、Dynamic OP では screenshot 提出の6個と `oidcc-server-rotate-keys`、Config OP では無し）を除いてプランを実行します。CI（`.github/workflows/conformance.yml`）は `1` で実行します。デフォルトはすべての module を実行します。
- `CONFORMANCE_KEEP_SERVICES=1`: runner終了後もDocker Composeサービスを残す。
- `CONFORMANCE_ALIAS`: コールバックURLに使うOIDF test alias。デフォルトは `maronn-basic-op`（Implicit OP では `maronn-implicit-op`、Hybrid OP では `maronn-hybrid-op`、Dynamic OP では `maronn-dynamic-op`、Config OP では `maronn-config-op`）。
- `CONFORMANCE_OP_ISSUER`: Compose内でサンプルOPが使うissuer。デフォルトは `https://op-tls:3443`。
- `CONFORMANCE_SUITE_BASE_URL`: Compose内でcallback URI生成に使うSuite base URL。デフォルトは `https://conformance-nginx:8443`。
- `OIDC_ALLOW_NON_PKCE_AUTHORIZATION_CODE_FLOW`: サンプルOPのBasic OP互換モード。`pnpm run conformance:basic-op`、`pnpm run conformance:hybrid-op`、`pnpm run conformance:dynamic-op` ではデフォルト `1`、`pnpm run conformance:implicit-op` と `pnpm run conformance:config-op` ではデフォルト `0`。
- `OIDC_ALLOW_UNSIGNED_REQUEST_OBJECT`: サンプルOPで unsigned（`alg:none`）Request Object を受理し、discovery の `request_object_signing_alg_values_supported` に `none` を広告する互換モード。どのプランでもデフォルト `1`（通常利用と E2E では未設定＝署名必須）。`oidcc-unsigned-request-object-...` / `oidcc-ensure-request-object-with-redirect-uri` / `oidcc-request-uri-unsigned` は OP が unsigned 非対応を広告すると skip されるため、conformance run でのみ有効化する。
- `OIDC_SIGNING_KEY_ROTATION_TOKEN`: サンプルOPの `POST /operator/signing-keys/rotate`（OP の署名鍵のローテーション）を呼ぶ Bearer トークン。デフォルトは `conformance-rotation-token`。この実行のためだけの値で、`oidcc-server-rotate-keys` を人手で進めるときに使う（`manual-review-screenshots.md`）。
- `NODE_EXTRA_CA_CERTS`: `op` サービスに `docker-compose.yml` が渡す、実行用の CA（`.generated/certs/ca.crt`）。上書きしません。

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

- `tests/conformance/.generated/<plan>-op-config.json`（`basic-op-config.json`、`implicit-op-config.json`、`hybrid-op-config.json`、`dynamic-op-config.json`、`config-op-config.json`）
- `tests/conformance/.generated/oidc-clients.json`
- `tests/conformance/.generated/metadata.json`
- `tests/conformance/.generated/test-plan.txt`（`run-test-plan.py` に渡すテストプランの文字列）
- `tests/conformance/.generated/expected-skips.json`（Suite が SKIPPED にしてよい module。Dynamic OP の3つのほかは空）
- `tests/conformance/.generated/certs/`（実行用の CA と、`op-tls`、`conformance-nginx` の証明書）

実行結果は以下に出力されます。

- `tests/conformance/results/docker-compose.log`
- `tests/conformance/results/*.zip`

ZIPファイルはConformance Suiteのエクスポートです。どのmoduleがpass/failしたかを確認する場合は、
まずこのZIPを確認してください。

### 終了ステータス

このコマンドはConformance runnerの終了ステータスを返します。

- `0`: 設定したtest planが成功した（FAILURE と WARNING が 0 で、SKIPPED は `expected-skips.json` の module だけ）。
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

- `plan`: `basic`、`implicit`、`hybrid`、`dynamic`、`config` のいずれか。デフォルトは `basic`。
- `sample_app`: `hono-cloudflare`, `express-flyio`, `fastify-flyio`, `nextjs-vercel` のいずれか。
- `suite_image_tag`: OpenID Foundation Conformance Suite image tag。通常は `latest`。

workflowでは以下を実行します（`<plan>` は選んだプラン）。manual review が必要な module は除きます（`CONFORMANCE_SKIP_MANUAL_REVIEW=1`、[実行時間](#実行時間)を参照）。

```bash
pnpm install --frozen-lockfile
CONFORMANCE_SKIP_MANUAL_REVIEW=1 pnpm run conformance:<plan>-op
```

Suiteが失敗した場合でも、以下を `oidf-<plan>-op-conformance` artifactとしてアップロードします。

- `tests/conformance/results`
- `tests/conformance/.generated`

### Pull Requestでの実行

Pull Requestに `run-conformance` labelが付いている場合もworkflowを実行します。
Conformance Suiteは重いので通常のPR経路からは外し、必要な変更に対してmaintainerが
Basic OP checkを要求できるようにしています。
このときは Basic OP、Implicit OP、Hybrid OP、Dynamic OP、Config OP の5つのプランを、別々のjob（`basic-op`、`implicit-op`、`hybrid-op`、`dynamic-op`、`config-op`）で実行します。

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

### Dynamic OP（2026-11-06、CI）

`oidcc-dynamic-certification-test-plan[response_type=code]` は、GitHub Actions の `OpenID Conformance` workflow の手動実行（`plan: dynamic`）で、4つのサンプルのそれぞれについて確認した。
Conformance Suite は、`registry.gitlab.com/openid/conformance-suite:latest` の Docker image を使った。
手元の環境では Suite の image を取得できなかったので（GitLab のレジストリへの接続が拒否された）、ローカルでは実行していない。

| サンプル | 自動の16 module | manual review の7 module |
|---|---|---|
| `hono-cloudflare` | 13 PASSED、3 SKIPPED（想定どおり）。condition は 823 SUCCESS、FAILURE 0、WARNING 0 | 未実行 |
| `express-flyio` | exit 0（FAILURE 0、WARNING 0、SKIPPED は想定の3つだけ） | 未実行 |
| `fastify-flyio` | exit 0（FAILURE 0、WARNING 0、SKIPPED は想定の3つだけ） | 未実行 |
| `nextjs-vercel` | exit 0（FAILURE 0、WARNING 0、SKIPPED は想定の3つだけ） | 未実行 |

SKIPPED の3つは、`oidcc-idtoken-unsigned`、`oidcc-registration-sector-uri`、`oidcc-registration-sector-bad` である（[Dynamic OP](#dynamic-op) を参照）。
`oidcc-refresh-token-rp-key-rotation` は、Suite がクライアントの鍵を入れ替えた後の60秒の待ちを含めて、PASSED だった（`jwks_uri` の取り直し）。
manual review が必要な7個の module は、CI では `CONFORMANCE_SKIP_MANUAL_REVIEW=1` で除いている。
screenshot の提出と `oidcc-server-rotate-keys` の手動開始は、まだ行っていない。
手順は `manual-review-screenshots.md` にある。

最初の実行では、2つの構成の不具合が見つかり、直した。

- テストプランの文字列に `server_metadata`、`client_registration`、`client_auth_type`、`response_mode` を付けていたため、Suite がプランを作らなかった（`Variant 'client_auth_type' has been set by user, but test plan already sets this variant`）。これらはプラン自身が決めるので、`response_type=code` だけを付けるようにした
- 想定どおりの3つの SKIPPED を `run-test-plan.py` が予期しない skip として扱い、FAILURE と WARNING が 0 でも 0 以外で終わった。`expected-skips.json` を渡すようにした

### Config OP（2026-11-06、CI）

`oidcc-config-certification-test-plan` は、同じ workflow の手動実行（`plan: config`）で、4つのサンプルのそれぞれについて確認した。
どのサンプルでも `oidcc-discovery-endpoint-verification` が PASSED で、exit 0 だった。
最初の `hono-cloudflare` の実行では、id-jag の2つの discovery の項目に `CheckForUnexpectedParametersInServerMetadata` の WARNING が1つ出た（43 SUCCESS、0 FAILURE）。
この2つを `server.allow_unexpected_metadata_fields` に並べてからは、WARNING は 0 になった（[discovery の拡張メタデータ](#discovery-の拡張メタデータ) を参照）。

### Basic OP、Implicit OP、Hybrid OP（2026-11-06、CI）

Dynamic OP の変更の後も、3つのプランは4つのサンプルのどれでも exit 0（manual review を除く module で FAILURE 0、WARNING 0、予期しない SKIPPED 0）だった。

### 後方互換の配慮を外した後の再実行（2026-11-07、CI）

クライアントの保存の形（`--db sql` の `client_auths` と `clients` の列、`--db kv` のレコード）、ログイン画面と同意画面の値、PAR と動的登録の experimental の API を変えた後に、5つのプランを4つのサンプルのそれぞれで実行し直した（`0ec2ba90`）。
20の実行はどれも exit 0 だった。
`hono-cloudflare` の Dynamic OP は、前と同じく 13 PASSED、3 SKIPPED（想定どおり）、823 SUCCESS / 0 FAILURE / 0 WARNING だった。

### main を取り込んだ後の再実行（2026-11-09、CI）

main（ログイン画面と同意画面のトランザクションを URL とフォームに束縛する変更、pnpm の固定の解除など）を取り込んだ後に、5つのプランを4つのサンプルのそれぞれで実行し直した。
`469a3b0` では、`express-flyio` と `fastify-flyio` の10の実行はどれも exit 0 だった。
`hono-cloudflare` と `nextjs-vercel` の10の実行は、どのプランでも Suite の前に OP のコンテナが止まった（[トラブルシューティング](#トラブルシューティング) の `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`）。
op サービスに `pnpm_config_verify_deps_before_run: "false"` を渡した `1f4e852` で、この10を実行し直した。
この10の実行も、どれも exit 0 だった（`469a3b0` から `1f4e852` までの変更は、op サービスの環境変数と、失敗した実行の最後に出すログだけである）。
`hono-cloudflare` の Dynamic OP は、取り込む前と同じく 13 PASSED、3 SKIPPED（想定どおり）、823 SUCCESS / 0 FAILURE / 0 WARNING だった。
`express-flyio` の Dynamic OP は、13 PASSED、3 SKIPPED（想定どおり）、821 SUCCESS / 0 FAILURE / 0 WARNING だった。

## 実行時間

- `op` サービスは Discovery に応答するまで healthy にならず、`op-tls` と `runner` は healthy になってから起動します。OP が起動しない場合は、約3分で `docker compose up` が失敗します。
- `op` サービスはリポジトリを読み取り専用でマウントするので、`wrangler dev`（`hono-cloudflare`）が書き込む `samples/<サンプル>/.wrangler/` だけを tmpfs にしています。マウントポイントは `run-op.sh` が作ります。
- OP のデータは `/tmp` に置きます。`hono-cloudflare` の D1 は `OIDC_D1_PERSIST_PATH`、node:sqlite を使う `express-flyio`、`fastify-flyio`、`nextjs-vercel` のデータベースは `OIDC_SQLITE_PATH` で指定します（既定の `.data/oidc.sqlite` は読み取り専用のリポジトリの中なので、OP が起動しません）。
- manual review が必要な module は screenshot の提出を待つので、`run-test-plan.py` は1つにつき240秒待ってから打ち切ります。`CONFORMANCE_SKIP_MANUAL_REVIEW=1` はこの待ち時間（Basic OP は3つで約12分、Implicit OP は6つで約24分、Hybrid OP は9つで約36分、Dynamic OP は7つで約28分）を省きます。`oidcc-server-rotate-keys` は人が Start を押すまで始まらないので、無人の実行では必ず打ち切られます。
- Dynamic OP の `oidcc-refresh-token-rp-key-rotation` は、Suite がクライアントの鍵を入れ替えてから60秒待つので、1分ほどかかります。
- 設定は `alias` を持つので、`run-test-plan.py` は module を並列に実行しません。

## Manual review が必要な module の扱い

Basic OP Certification には、ブラウザ自動化だけでは完了できず screenshot 提出や
manual review を前提とする module があります。

- `oidcc-ensure-registered-redirect-uri`: 未登録 redirect_uri に対して OP は
  redirect せず、ブラウザ向けの error page（HTTP 400 / `text/html`）を表示します。
  Conformance Suite はこの画面の screenshot 提出を待ちます。
- `oidcc-prompt-login` / `oidcc-max-age-1`: 2回目の認可画面の screenshot 提出を待ちます。

Implicit OP のプランにも同じ3つの module があり、Suite はそれぞれを `response_type=id_token` と `id_token token` で実行します。
Hybrid OP のプランでは、`response_type=code id_token`、`code token`、`code id_token token` の3通りで実行します。

Dynamic OP のプランでは、次の7つの module が人手を要します。

- `oidcc-ensure-redirect-uri-in-authorization-request`: `redirect_uris` を2つ登録したクライアントが `redirect_uri` 無しで要求します。OP は redirect せず、`redirect_uri is required when multiple redirect URIs are registered` の error page を表示します。
- `oidcc-redirect-uri-query-mismatch` / `oidcc-redirect-uri-query-added`: 登録した `redirect_uri` のクエリを変えた（足した）値で要求します。OP は完全一致で照合するので redirect せず、error page を表示します。
- `oidcc-registration-logo-uri` / `oidcc-registration-policy-uri` / `oidcc-registration-tos-uri`: ログイン画面に、登録したロゴ、プライバシーポリシーのリンク、利用規約のリンクが出ている screenshot を提出します。
- `oidcc-server-rotate-keys`: module を作った後、試験者が OP の鍵をローテーションしてから Start を押します。Suite は前後の JWKS を比べ、新しい `kid` と鍵素材の鍵が増えていること（無ければ FAILURE）と、古い鍵が残っていること（無ければ WARNING）を確かめます。

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

manual review を人手で完了する場合は、サービスを残したまま実行します（Implicit OP では `conformance:implicit-op`、Hybrid OP では `conformance:hybrid-op`、Dynamic OP では `conformance:dynamic-op`）。

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

OPのコンテナがすぐに止まる（`dependency failed to start: container ...-op-1 exited (1)`）場合は、`run-op.sh` が失敗した実行の最後に出す op サービスのログの末尾を確認してください。
`hono-cloudflare` と `nextjs-vercel` は、コンテナの中で `pnpm start` を使って起動します。
ワークスペースは、ホストで依存を入れたものを別のパス（`/workspace`）に読み取り専用でマウントしています。
pnpm 11 以降は、スクリプトの実行前に `node_modules` と lockfile が合っているかを確かめます。
このワークスペースは合っていないと判定され、`ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` で止まります。
そのため、`docker-compose.yml` は op サービスにだけ `pnpm_config_verify_deps_before_run: "false"` を渡しています。

Suiteが失敗してもZIPがエクスポートされている場合は、まずZIPを確認してください。`0` 以外の終了は
ローカルセットアップ失敗ではなく、実際のcertification failureを意味する場合があります。
