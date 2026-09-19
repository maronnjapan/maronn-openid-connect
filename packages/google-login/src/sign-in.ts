/**
 * フロント側（ログイン画面）に置く Sign in with Google（GIS HTML API, redirect mode）の設定。
 *
 * このモジュールは UI を生成しない。ログイン画面をどう描くか（プレーン HTML / React / Vue など）は
 * 利用側の責務で、ここでは redirect mode に必要な `g_id_onload` 要素の属性だけを組み立てる。
 * 属性名は GIS の HTML API そのままなので、同じオブジェクトを React の spread、Vue の `v-bind`、
 * 文字列テンプレート（{@link googleSignInAttributesToHtml}）のどれにもそのまま渡せる。
 *
 * Node の API にも他のモジュールにも依存しないので、`@maronn-openid-connect/google-login/sign-in`
 * としてブラウザ向けバンドルや React の client component から import できる
 * （package 本体は google-auth-library を含む Node 専用）。
 *
 * 忘れると動かない、または安全でなくなる設定はここで強制する。
 * - `data-ux_mode="redirect"`: ID トークンを `login_uri` へ POST させる
 * - `data-login_uri`: Google Cloud コンソールに登録したリダイレクト URI と完全一致させる
 * - `data-nonce`: サーバー側の `issueGoogleLoginNonce` で発行した nonce。Google が ID トークンの
 *   `nonce` クレームに載せて返すので、login_uri 側で認証トランザクションを復元できる
 *
 * 参照: https://developers.google.com/identity/gsi/web/guides/migration#redirect-mode_1
 */

/** GIS クライアントライブラリの URL。ログイン画面で `<script src async>` として読み込む。 */
export const GOOGLE_GSI_CLIENT_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/** 設定を載せる要素の `id`。GIS はこの id の要素から設定を読む。 */
export const GOOGLE_SIGN_IN_ONLOAD_ID = 'g_id_onload';

/** ボタンになる要素の `class`。GIS はこの class の要素をボタンに置き換える。 */
export const GOOGLE_SIGN_IN_BUTTON_CLASS = 'g_id_signin';

/**
 * GIS を動かすために Content-Security-Policy へ追加が必要なソース。
 *
 * ログイン画面に CSP を設定している OP は、各ディレクティブにこれらを足す。
 */
export const GOOGLE_SIGN_IN_CSP_SOURCES = {
  scriptSrc: 'https://accounts.google.com/gsi/client',
  frameSrc: 'https://accounts.google.com/gsi/',
  connectSrc: 'https://accounts.google.com/gsi/',
  styleSrc: 'https://accounts.google.com/gsi/style',
} as const;

export interface GoogleSignInOptions {
  /** Google Cloud コンソールで発行した OAuth 2.0 クライアント ID。 */
  clientId: string;
  /**
   * ID トークンの POST 先。Google Cloud コンソールの「承認済みのリダイレクト URI」に
   * 登録した値と完全一致させる。HTTPS の絶対 URL（開発用の localhost は HTTP 可）。
   */
  loginUri: string;
  /** サーバー側の `issueGoogleLoginNonce` で発行した nonce。 */
  nonce: string;
  /** アカウント選択を事前入力するメールアドレスなど。OIDC の `login_hint` を渡せる。 */
  loginHint?: string;
  /** アカウント選択を Google Workspace のドメインに絞る（`data-hd`）。検証は別途サーバー側の `hostedDomain` で行うこと。 */
  hostedDomain?: string;
}

/**
 * `g_id_onload` 要素に付ける属性。キーは GIS の HTML API の属性名そのもの。
 *
 * これ以外の GIS 属性（`data-auto_select` / `data-context` / `data-itp_support` など）は
 * 利用側で要素に足す。ボタンの見た目は `g_id_signin` 要素の属性（`data-theme` など）で指定する。
 */
export interface GoogleSignInAttributes {
  id: typeof GOOGLE_SIGN_IN_ONLOAD_ID;
  'data-client_id': string;
  'data-ux_mode': 'redirect';
  'data-login_uri': string;
  'data-nonce': string;
  'data-login_hint'?: string;
  'data-hd'?: string;
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `login_uri` が GIS の redirect mode で使える形であることを検証する。
 *
 * - 絶対 URL であること
 * - HTTPS であること（localhost / 127.0.0.1 / [::1] は HTTP を許す）
 * - fragment を含まないこと
 *
 * @throws {TypeError} 条件を満たさない場合
 */
export function assertGoogleLoginUri(loginUri: string): void {
  let url: URL;
  try {
    url = new URL(loginUri);
  } catch {
    throw new TypeError(`loginUri must be an absolute URL: ${loginUri}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname))) {
    throw new TypeError(`loginUri must use https (http is allowed only for localhost): ${loginUri}`);
  }
  if (url.hash !== '') {
    throw new TypeError(`loginUri must not contain a fragment: ${loginUri}`);
  }
}

/**
 * `g_id_onload` 要素の属性を組み立てる。
 *
 * redirect mode に必要な `data-ux_mode="redirect"` / `data-login_uri` / `data-nonce` を
 * 必ず含める。返り値は属性名をキーにしたプレーンなオブジェクトなので、そのまま
 * React の `<div {...attributes} />`、Vue の `<div v-bind="attributes" />`、
 * 文字列テンプレートの `<div ${googleSignInAttributesToHtml(attributes)}></div>` に渡せる。
 * 値が無い任意属性はキーごと省く。
 *
 * @throws {TypeError} `clientId` / `nonce` が空、または `loginUri` が条件を満たさない場合
 */
export function buildGoogleSignInAttributes(options: GoogleSignInOptions): GoogleSignInAttributes {
  if (!options.clientId) {
    throw new TypeError('clientId must not be empty');
  }
  if (!options.nonce) {
    throw new TypeError('nonce must not be empty');
  }
  assertGoogleLoginUri(options.loginUri);

  const attributes: GoogleSignInAttributes = {
    id: GOOGLE_SIGN_IN_ONLOAD_ID,
    'data-client_id': options.clientId,
    'data-ux_mode': 'redirect',
    'data-login_uri': options.loginUri,
    'data-nonce': options.nonce,
  };
  if (options.loginHint !== undefined) {
    attributes['data-login_hint'] = options.loginHint;
  }
  if (options.hostedDomain !== undefined) {
    attributes['data-hd'] = options.hostedDomain;
  }
  return attributes;
}

/** HTML の属性名として妥当な文字列（属性値ではなく属性名側のインジェクションを防ぐ）。 */
const HTML_ATTRIBUTE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 属性オブジェクトを、文字列テンプレートの要素に埋め込める `name="value"` の列にする。
 *
 * React / Vue のように属性オブジェクトを直接受け取る仕組みが無い、プレーンな HTML 文字列を
 * 組み立てる場面向け。値は HTML 属性としてエスケープし、`undefined` の属性は省く。
 * {@link buildGoogleSignInAttributes} の結果に他の GIS 属性を足したものも渡せる。
 *
 * @throws {TypeError} 属性名に HTML の属性名として使えない文字が含まれる場合
 */
export function googleSignInAttributesToHtml(
  attributes: GoogleSignInAttributes | Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (!HTML_ATTRIBUTE_NAME.test(name)) {
      throw new TypeError(`Invalid HTML attribute name: ${name}`);
    }
    parts.push(`${name}="${escapeHtmlAttribute(String(value))}"`);
  }
  return parts.join(' ');
}
