/**
 * ログイン画面に埋め込む「Google でログイン」ボタン（GIS HTML API, redirect mode）の生成。
 *
 * Google のドキュメント「Google ログインからの移行」の redirect mode に従い、
 * `g_id_onload` 要素に `data-ux_mode="redirect"` と `data-login_uri` を指定する。
 * ユーザーがアカウントを選ぶと、ブラウザは `login_uri` へ ID トークンを POST する
 * （`redirect-credential.ts` がその POST を処理する）。
 *
 * `data-nonce` には {@link issueGoogleLoginNonce} で発行した nonce を渡す。Google は
 * この値を ID トークンの `nonce` クレームに載せて返すため、login_uri 側で
 * どの認証トランザクションのログインかを復元できる。
 */

/** GIS クライアントライブラリの URL。 */
export const GOOGLE_GSI_CLIENT_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

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

/** `g_id_signin` 要素（ボタンの見た目）の属性。GIS のボタン属性に対応する。 */
export interface GoogleSignInButtonOptions {
  type?: 'standard' | 'icon';
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'large' | 'medium' | 'small';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  logoAlignment?: 'left' | 'center';
  /** ボタンの幅（ピクセル）。 */
  width?: number;
  /** ボタンの表示言語（BCP 47）。OIDC の `ui_locales` から渡せる。 */
  locale?: string;
}

export interface GoogleSignInMarkupOptions {
  /** Google Cloud コンソールで発行した OAuth 2.0 クライアント ID。 */
  clientId: string;
  /**
   * ID トークンの POST 先。Google Cloud コンソールの「承認済みのリダイレクト URI」に
   * 登録した値と完全一致させる。HTTPS の絶対 URL（開発用の localhost は HTTP 可）。
   */
  loginUri: string;
  /** {@link issueGoogleLoginNonce} で発行した nonce。 */
  nonce: string;
  /** アカウント選択を事前入力するメールアドレスなど。OIDC の `login_hint` を渡せる。 */
  loginHint?: string;
  /** アカウント選択を Google Workspace のドメインに絞る（`data-hd`）。検証は別途 `hostedDomain` で行うこと。 */
  hostedDomain?: string;
  /** セッションが 1 つだけのとき確認無しで自動選択する（`data-auto_select`）。既定は false。 */
  autoSelect?: boolean;
  /** 画面の文脈に合わせた文言（`data-context`）。 */
  context?: 'signin' | 'signup' | 'use';
  /** ITP 対応ブラウザ向けのアップグレード UX を有効にする（`data-itp_support`）。 */
  itpSupport?: boolean;
  /** ボタンの見た目。 */
  button?: GoogleSignInButtonOptions;
  /** GIS クライアントの `<script>` を含める。既定は true。ページで別途読み込む場合は false。 */
  includeClientScript?: boolean;
}

/**
 * HTML 属性値として安全になるようエスケープする。
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function attribute(name: string, value: string | number | boolean | undefined): string {
  if (value === undefined) return '';
  return ` ${name}="${escapeHtmlAttribute(String(value))}"`;
}

/**
 * 「Google でログイン」ボタンの HTML を生成する。
 *
 * 生成コードのログイン画面（views）に、通常のログインフォームと並べて埋め込む想定。
 * 返す HTML は次の 3 要素からなる（`includeClientScript: false` なら最初の要素を省く）。
 *
 * 1. GIS クライアントの `<script>`
 * 2. `#g_id_onload`（クライアント ID、redirect mode、login_uri、nonce などの設定）
 * 3. `.g_id_signin`（ボタン本体。GIS クライアントがこの要素をボタンに置き換える）
 *
 * @throws {TypeError} `clientId` / `nonce` が空、または `loginUri` が条件を満たさない場合
 */
export function buildGoogleSignInMarkup(options: GoogleSignInMarkupOptions): string {
  if (!options.clientId) {
    throw new TypeError('clientId must not be empty');
  }
  if (!options.nonce) {
    throw new TypeError('nonce must not be empty');
  }
  assertGoogleLoginUri(options.loginUri);

  const button = options.button ?? {};
  const parts: string[] = [];

  if (options.includeClientScript !== false) {
    parts.push(`<script src="${GOOGLE_GSI_CLIENT_SCRIPT_URL}" async></script>`);
  }

  parts.push(
    '<div id="g_id_onload"' +
      attribute('data-client_id', options.clientId) +
      attribute('data-ux_mode', 'redirect') +
      attribute('data-login_uri', options.loginUri) +
      attribute('data-nonce', options.nonce) +
      attribute('data-login_hint', options.loginHint) +
      attribute('data-hd', options.hostedDomain) +
      attribute('data-auto_select', options.autoSelect === true ? 'true' : undefined) +
      attribute('data-context', options.context) +
      attribute('data-itp_support', options.itpSupport === true ? 'true' : undefined) +
      '></div>',
  );

  parts.push(
    '<div class="g_id_signin"' +
      attribute('data-type', button.type ?? 'standard') +
      attribute('data-theme', button.theme) +
      attribute('data-size', button.size) +
      attribute('data-text', button.text) +
      attribute('data-shape', button.shape) +
      attribute('data-logo_alignment', button.logoAlignment) +
      attribute('data-width', button.width) +
      attribute('data-locale', button.locale) +
      '></div>',
  );

  return parts.join('\n');
}
