/**
 * EXPERIMENTAL — Client Registration Endpoint (RFC 7591 §3).
 *
 * Generated because the OP was created with
 * `--enable dynamic-client-registration`. Backed by @maronn-openid-connect/experimental,
 * whose API is NOT stable: it may change in a breaking way between releases.
 * Do not build production code on it without pinning the version.
 *
 * The client POSTs its metadata here as JSON — optionally bundled in a signed
 * software statement of a publisher this OP trusts — and receives a freshly
 * minted client_id (and, for confidential clients, a client_secret) that works
 * on /authorize and /token right away. Registration is open by default
 * (RFC 7591 §3.1 SHOULD) and a software_statement is ignored (§3.1.1); set
 * verifyInitialAccessToken / verifySoftwareStatement of
 * dynamicClientRegistrationConfig
 * (_oidc-provider/features/dynamic-client-registration/config.ts) to require
 * them and verify them with functions of your own — this code verifies
 * neither. Metadata beyond the standard fields is accepted through
 * customClientMetadata of the same config.
 *
 * NOTE (RFC 7591 §5): per-IP rate limiting is deliberately left to the
 * deployment layer (reverse proxy / platform); this endpoint only enforces the
 * inventory and body-size caps of that config.ts. Open registration grants no
 * trust: what an issued client can do stays bounded by the same validation as
 * a static client (PKCE, exact redirect_uri match, client authentication).
 */
import { getJwaAlgorithm, hashClientSecret, responseTypeIncludes, type SigningKey } from '@maronn-openid-connect/core';
import {
  applySoftwareStatement,
  buildClientRegistrationResponse,
  buildRegisteredClient,
  ClientRegistrationError,
  isClientRegistrationError,
  parseClientRegistrationBody,
  readBearerToken,
  validateClientMetadata,
  type ParsedClientRegistration,
} from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { responseTypesOf, tokenGrantsOf } from '../../_oidc-provider/feature';
import { features } from '../../_oidc-provider/features';
import {
  dynamicClientRegistrationConfig,
  type DynamicClientRegistrationConfig,
} from '../../_oidc-provider/features/dynamic-client-registration/config';
import {
  dynamicClientStore,
  toClientRegistration,
} from '../../_oidc-provider/features/dynamic-client-registration/store';
import { clientCors, corsPreflight, signingKeysUnavailable, withCors } from '../../_oidc-provider/http';
import { loadSigningKeys } from '../../_oidc-provider/provider';
import { CUSTOM_SCOPES, STANDARD_SCOPES } from '../../_oidc-provider/scopes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 登録の応答に CORS のヘッダーを付けて返す。
 *
 * `POST /register` のリクエストを `registerClient()` で処理し、その応答（登録できれば 201、できなければエラー）に `clientCors` のヘッダーを付けて返す。
 */
export async function POST(request: Request): Promise<Response> {
  return withCors(request, clientCors, await registerClient(request));
}

/**
 * CORS のプリフライトに、ボディなしの 204 で応答する。
 *
 * 対象は `/register` で、応答には `clientCors` のヘッダー（許可するオリジン、メソッド、ヘッダー、キャッシュしてよい秒数）を付ける。
 */
export function OPTIONS(request: Request): Response {
  return corsPreflight(request, clientCors);
}

/**
 * メタデータでクライアントを登録し、201 で応答する。
 *
 * 201 のボディには、`client_id`、`client_secret` で認証する方式を登録したクライアントには発行した `client_secret`、登録したすべてのメタデータを入れ、キャッシュを禁止して返す。
 * ストアに保存するクライアントは、シークレットをハッシュでだけ持つ。
 *
 * 失敗したときは次のように応答する。
 * - `verifyInitialAccessToken` を設定していて `Bearer` トークンがないときは、エラーコードのない 401
 * - 設定の関数がトークンを拒否したときは、`invalid_token` の 401
 * - ボディが `application/json` でないか大きすぎるとき、メタデータが検証を通らないとき、ソフトウェアステートメントを拒否したときは 400（`invalid_client_metadata`、`invalid_redirect_uri`、`invalid_software_statement`、`unapproved_software_statement`）
 * - 登録数が `maxRegisteredClients` に達しているときは、429 の `too_many_registrations`
 * - 署名鍵を読み込めないときは 503
 * - それ以外の失敗は、500 の `server_error`
 *
 * @spec RFC 7591 §3
 */
async function registerClient(request: Request): Promise<Response> {
  const config = dynamicClientRegistrationConfig;

  // 設定に `verifyInitialAccessToken` があれば、リクエストが登録してよいかを確かめる。
  // 設定になければ、誰でも登録できる状態として、すべてのリクエストを通す（RFC 7591 §3.1 の SHOULD）。
  // 設定にあれば、リクエストは `Bearer` トークンを送らなければならない（RFC 6750 §2.1）。
  // トークンがなければ、エラーコードのない 401 で応答する（認証情報のないリクエストへの応答として RFC 6750 §3.1 が求める形）。
  // トークンがあれば設定の関数が判定し、拒否したら `error="invalid_token"` の 401 で応答する。
  // ここではトークンそのものを検証せず、どちらのレスポンスにも期待するトークンについての情報を含めない。
  if (config.verifyInitialAccessToken !== undefined) {
    const token = readBearerToken(request.headers.get('Authorization'));
    if (token === undefined) return registration401('Bearer');
    if (!(await config.verifyInitialAccessToken(token, config))) {
      return registration401('Bearer error="invalid_token"');
    }
  }

  // `Content-Type` が `application/json` でなければ、400 の `invalid_client_metadata` で応答する（RFC 7591 §3.1）。
  // `charset` などのパラメータは付いていてもよい。
  // メディアタイプを限ると、CORS のプリフライトなしで送れる別オリジンの `text/plain` のフォーム送信で、JSON の形をしたボディを作られることも防げる。
  if (!isJson(request.headers.get('Content-Type') ?? '')) {
    return registrationJson(
      { error: 'invalid_client_metadata', error_description: 'registration requests must use application/json' },
      400,
    );
  }

  // `Content-Length` が `maxRegistrationBodyBytes` より大きい値を宣言していれば、ボディを読む前に 400 の `invalid_client_metadata` で応答する。
  // こうすると、大きすぎるリクエストをメモリに読み込まずに済む。
  // ヘッダーの値は偽れるので、最終的な判定は、ボディそのものの UTF-8 のバイト数で `parseClientRegistrationBody()` が行う。
  const declaredLength = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > config.maxRegistrationBodyBytes) {
    return registrationJson(
      { error: 'invalid_client_metadata', error_description: 'request body must not exceed the configured maximum size' },
      400,
    );
  }

  // 署名鍵を読み込み、読み込めなければ 503 で応答する。
  // クライアントが登録できる署名アルゴリズムは、ディスカバリーが公開するのと同じく、署名鍵のアルゴリズムである。
  const keys = await loadSigningKeys().catch(() => null);
  if (!keys) return signingKeysUnavailable();

  try {
    // ボディを読む。
    // 読み取りを `try` の中に置くので、転送が中断されたり壊れていたりしても、Next.js の既定の 500 ではなく、Hono 版のパイプラインと同じく、キャッシュを禁止した固定の `server_error` の JSON で応答する。
    const rawBody = await request.text();

    // ボディの大きさと JSON の形を確かめ、`software_statement`（RFC 7591 §2.3）をそれ以外のメタデータから分ける。
    const registration = parseClientRegistrationBody(rawBody, { maxBodyBytes: config.maxRegistrationBodyBytes });

    // JSON の値にソフトウェアステートメントを重ねた、登録するメタデータを得る（RFC 7591 §3.1.1）。
    // 設定に `verifySoftwareStatement` がなければ、この OP はソフトウェアステートメントに対応せず、`software_statement` を無視する（RFC 7591 §3.1.1 が許す扱い）。
    // 設定にあれば、すべての登録に `software_statement` を求め、なければ `invalid_client_metadata` で拒否する。
    // 検証は設定の関数が行い、拒否するときは `ClientRegistrationError`（`invalid_software_statement` か `unapproved_software_statement`）を投げる（RFC 7591 §3.2.2）。
    // RFC 7591 は信頼の基準をサーバーに任せているので、ここではソフトウェアステートメントの中身を確かめない。
    // ソフトウェアステートメントそのものは、レスポンスで変えずに返す（RFC 7591 §3.2.1）。
    const metadata = await resolveRegistrationMetadata(config, registration);

    // メタデータを検証して既定値を適用し、登録するクライアントを作る。
    // 検証は `@maronn-openid-connect/experimental/dynamic-client-registration` の副作用のない関数が行う。
    // 理解するフィールドだけを選んで値を検証し、RFC 7591 §2 と OIDC Registration 1.0 §2 の既定値（`application_type` は `web`、`id_token_signed_response_alg` は `RS256`）を適用する。
    // 適用した既定値も登録し、レスポンスで返す（OIDC Registration 1.0 §3.2）。
    // アプリケーションの種類ごとの `redirect_uris` の制約と、`grant_types` と `response_types` の整合（RFC 7591 §2.1）も確かめる。
    // 受け付ける値は、この OP が応答できるもの（設定の認証方式とグラントタイプ、機能のレスポンスタイプ、scopes.ts のスコープ、署名鍵のアルゴリズム、設定の独自のメタデータ）に限る。
    // 理解しないメタデータは黙って無視し（RFC 7591 §2 の MUST）、`error_description` はどれもリクエストの値を含まない固定の ASCII の文字列にする。
    const responseTypes = ['code', ...responseTypesOf(features)];
    const validated = validateClientMetadata(metadata, {
      tokenEndpointAuthMethods: config.tokenEndpointAuthMethods,
      grantTypes: registrableGrantTypes(config.grantTypes, responseTypes),
      responseTypes,
      scopes: registrableScopes(),
      idTokenSigningAlgValuesSupported: signingAlgsOf(keys.idToken),
      userinfoSigningAlgValuesSupported: signingAlgsOf(keys.userinfo),
      customMetadata: config.customClientMetadata,
    });
    const client = buildRegisteredClient(validated);

    // 登録数がすでに `maxRegisteredClients` に達していれば、固定のボディの 429 で応答する（RFC 7591 §5）。
    // メタデータには誤りがないので、`invalid_client_metadata` にはしない。
    // そう応答すると、クライアントがメタデータを直して送り直す繰り返しを招き、上限で防ぎたいサービス妨害攻撃の負荷をかえって増やす。
    // `Retry-After` も付けない。
    // 上限は登録の総数に対するもので時間あたりの頻度の制限ではないので、いつ登録できるようになるかを約束できない。
    if ((await dynamicClientStore.count()) >= config.maxRegisteredClients) {
      return registrationJson(
        { error: 'too_many_registrations', error_description: 'registration limit reached' },
        429,
      );
    }

    // `client_secret` をハッシュにしてから、クライアントをストアに保存する。
    // 保存するレコード（`toClientRegistration()`）は、静的に登録したクライアント（_oidc-provider/db の `registerClient()`）と同じく `client_secret` をハッシュでだけ持ち、`jwks` の鍵を設定の用途ごとに持つ。
    // 下の 201 のレスポンスはメモリ上のクライアントから組み立てるので、平文のシークレットをストアに置く必要はない。
    const clientSecretHash = client.clientSecret === undefined ? undefined : await hashClientSecret(client.clientSecret);
    await dynamicClientStore.save(toClientRegistration(client, { clientSecretHash, jwksPurposes: config.jwksPurposes }));
    // 保存したあとに登録数を数え直し、上限を超えていればこの登録を削除して 429 で応答する。
    // 同時に届いたリクエストは、上の `await` の間に処理が入れ替わり、そろって最初の確認を通ることがあるためである。
    // これで上限を超えた登録が残ることはない（同時に削除し合って、上限より少ないまま終わることはある）。
    if ((await dynamicClientStore.count()) > config.maxRegisteredClients) {
      await dynamicClientStore.delete(client.clientId);
      return registrationJson(
        { error: 'too_many_registrations', error_description: 'registration limit reached' },
        429,
      );
    }

    // 登録のメタデータと発行した `client_secret` は、ログに出さない。

    // 発行した値と、登録したすべてのメタデータ（既定値を適用したもの）を 201 で返す（RFC 7591 §3.2.1）。
    // `client_secret_expires_at` の 0 は、シークレットに有効期限がないことを表す。
    return registrationJson(buildClientRegistrationResponse(client), 201);
  } catch (error) {
    // 登録のエラーには、400 で `error` と `error_description` の JSON を返す（RFC 7591 §3.2.2）。
    // エラーは、クラスではなく形で見分ける。
    // config.ts の検証関数はアプリの起動時（instrumentation.ts）に設定されることがあり、Next.js はそれをこのルートハンドラとは別にバンドルするので、その関数が投げる `ClientRegistrationError` は別のクラスの複製になるためである。
    if (isClientRegistrationError(error)) {
      return registrationJson({ error: error.error, error_description: error.errorDescription }, 400);
    }
    return registrationJson({ error: 'server_error' }, 500);
  }
}

/**
 * JSON の値にソフトウェアステートメントを重ねて返す。
 *
 * 返すのは登録するメタデータで、検証したソフトウェアステートメントが示す値を JSON の値より優先する（RFC 7591 §3.1.1）。
 *
 * 設定に `verifySoftwareStatement` がなければ、この OP はソフトウェアステートメントに対応しないので、リクエストの `software_statement` を無視して JSON の値をそのまま返す（RFC 7591 §3.1.1 が許す扱い）。
 * 設定にあれば、すべての登録に `software_statement` を求め、なければ `invalid_client_metadata` を投げる。
 * `software_statement` は設定の関数が検証し、拒否するときは `ClientRegistrationError`（`invalid_software_statement` か `unapproved_software_statement`）を投げる（RFC 7591 §3.2.2）。
 * RFC 7591 は信頼の基準をサーバーに任せているので、この関数はソフトウェアステートメントの中身を確かめない。
 * ソフトウェアステートメントそのものも登録するメタデータに残すので、201 のレスポンスはそれを変えずに返す（RFC 7591 §3.2.1）。
 *
 * @spec RFC 7591 §3.1.1
 * @throws {ClientRegistrationError} `invalid_client_metadata`: 設定に関数があり、`software_statement` がないとき
 */
async function resolveRegistrationMetadata(
  config: DynamicClientRegistrationConfig,
  registration: ParsedClientRegistration,
): Promise<Record<string, unknown>> {
  if (config.verifySoftwareStatement === undefined) {
    return registration.metadata;
  }
  if (registration.softwareStatement === undefined) {
    throw new ClientRegistrationError('invalid_client_metadata', 'software_statement is required');
  }
  const verified = await config.verifySoftwareStatement(registration.softwareStatement, config);
  return applySoftwareStatement(registration.metadata, registration.softwareStatement, verified);
}

/**
 * 設定のグラントタイプのうち、OP が応答するものを返す。
 *
 * OP が応答するのは、`authorization_code`、生成された機能がトークンエンドポイントで応答するグラントタイプ、`responseTypes` に `token` か `id_token` を含むレスポンスタイプがあるときの `implicit` である（`implicit` とこれらのレスポンスタイプの対応は OIDC Registration 1.0 §2 による）。
 * 応答しないグラントタイプは、設定にあっても登録させない。
 * 登録できても、そのクライアントはそのグラントタイプを使えないからである。
 *
 * @spec RFC 7591 §2
 */
export function registrableGrantTypes(configured: readonly string[], responseTypes: readonly string[]): string[] {
  const offered = ['authorization_code', ...tokenGrantsOf(features)];
  const answersImplicit = responseTypes.some(
    (responseType) => responseTypeIncludes(responseType, 'token') || responseTypeIncludes(responseType, 'id_token'),
  );
  if (answersImplicit) offered.push('implicit');
  return configured.filter((grantType) => offered.includes(grantType));
}

/**
 * 登録できるスコープの一覧か `undefined` を返す。
 *
 * scopes.ts に独自のスコープを宣言していれば、標準のスコープと宣言したスコープの一覧を返す（`/authorize` で `findUnsupportedScopes()` が受け付けるスコープと同じ）。
 * 宣言していなければ一覧はなく `undefined` を返すので、構文が正しいスコープならどれでも登録できる。
 */
export function registrableScopes(): readonly string[] | undefined {
  return CUSTOM_SCOPES.length === 0 ? undefined : [...STANDARD_SCOPES, ...CUSTOM_SCOPES];
}

/**
 * 署名鍵の集合の JWA アルゴリズムを、重複なく返す。
 *
 * ディスカバリーがその鍵の集合について公開するアルゴリズムと同じ値になる。
 */
function signingAlgsOf(keys: readonly SigningKey[]): string[] {
  return [...new Set(keys.map((key) => getJwaAlgorithm(key.privateKey)))];
}

/**
 * メディアタイプが `application/json` なら true を返す。
 *
 * `Content-Type` の値の `;` より前の部分を小文字にして比べるので、`charset` などのパラメータが付いていても true を返す。
 * 登録リクエストのボディは `application/json` でなければならない（RFC 7591 §3.1）。
 *
 * @spec RFC 7591 §3.1
 */
function isJson(contentType: string): boolean {
  const [mediaType = ''] = contentType.toLowerCase().split(';');
  return mediaType.trim() === 'application/json';
}

/**
 * キャッシュを禁止した JSON のレスポンスを返す。
 *
 * 201 のボディには `client_secret` が含まれることがあるので、登録エンドポイントのレスポンスはどれも `Cache-Control: no-store` と `Pragma: no-cache` を付けてキャッシュさせない。
 */
function registrationJson(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

/**
 * ボディなしの 401 のレスポンスを返す。
 *
 * `WWW-Authenticate` ヘッダーには `wwwAuthenticate` を設定し、キャッシュを禁止するヘッダー（`Cache-Control: no-store`、`Pragma: no-cache`）も付ける。
 *
 * @spec RFC 6750 §3.1
 */
function registration401(wwwAuthenticate: string): Response {
  return new Response(null, {
    status: 401,
    headers: {
      'WWW-Authenticate': wwwAuthenticate,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}
