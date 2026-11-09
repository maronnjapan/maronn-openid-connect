/** @jsxImportSource hono/jsx */
/**
 * UI Views for OpenID Connect Provider (hono/jsx).
 *
 * This file contains the default markup of the login, consent and error
 * screens, written as JSX. The screen routes deliver these views (the login
 * page renders <views.loginPage {...params} />, and so on); the logic of the
 * endpoints never renders anything — it returns outcomes the pages turn into
 * HTTP. Customize these components to match your application's design, or
 * change how a screen is delivered in its page module. The screens a feature
 * adds (the device flow, CIBA, logout) are in the views.tsx of that feature,
 * and use the building blocks exported here.
 *
 * Every view is a hono/jsx component: it receives typed parameters as its
 * props and returns a JSX element (ViewResult), which renderView turns into
 * the Response the page sends. To control the Response itself (status,
 * headers, a body from another renderer), change the render*Page() helper of
 * the screen instead.
 *
 * JSX escapes every value interpolated with {...}, in text and in attributes,
 * so untrusted input (login_hint, error_description, binding_message, ...) is
 * rendered safely without manual escaping. Never hand such a value to raw()
 * or dangerouslySetInnerHTML.
 *
 * Compiling this file needs JSX enabled in tsconfig.json:
 *   "jsx": "react-jsx", "jsxImportSource": "hono/jsx"
 */
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { raw } from 'hono/html';
import { buildTransactionPath } from '@maronn-openid-connect/core';

// ============================================================
// View Parameter Types
// ============================================================

export interface LoginPageParams {
  /** The cookie and URL ID; preserve it in the form action and hidden transaction_id. */
  transactionId: string;
  /** The stored token; preserve the hidden csrf_token field. */
  csrfToken: string;
  /** Error message from a previous failed attempt */
  error?: string;
  /** Number of remaining login attempts */
  remainingAttempts?: number;
  /**
   * OIDC Core 1.0 §3.1.2.1 login_hint: untrusted external value the OP MAY use to
   * pre-fill the login form. Treated as a hint only (initial display); it MUST be
   * HTML-attribute escaped before rendering since it is unauthenticated input.
   */
  loginHint?: string;
  /**
   * The other ways to sign in that the features offer (the login methods of
   * features/feature.ts, such as Sign in with Google), already rendered.
   * Shown below the password form.
   */
  loginMethods?: ViewResult[];
}

export interface ConsentPageParams {
  /** The cookie and URL ID; preserve it in the form action and hidden transaction_id. */
  transactionId: string;
  /** The stored token; preserve the hidden csrf_token field. */
  csrfToken: string;
  /** Scopes requested by the client */
  scopes: string[];
  /** Client ID requesting authorization */
  clientId: string;
}

/**
 * OAuth 2.0 Form Post Response Mode §2: the authorization response the browser
 * posts to the client. The view must keep the form as it is — method POST,
 * action and the fields exactly as given — and may only change what is
 * around it.
 */
export interface FormPostPageParams {
  /** The client's redirect URI: the action of the form. */
  action: string;
  /** The authorization response parameters, one hidden field each. */
  fields: Record<string, string>;
}

export interface ErrorPageParams {
  /** Error message to display (OAuth error code for authorization errors) */
  error: string;
  /** Optional human-readable detail (OAuth error_description) */
  errorDescription?: string;
  /** HTTP status code */
  statusCode: number;
}

// ============================================================
// Views Interface
// ============================================================

/**
 * What a view returns: a JSX element. A component may be async, and markup
 * built elsewhere can be returned through hono/html — html`...` escapes its
 * interpolations, raw() trusts its string as is, so only hand it HTML that is
 * already escaped.
 */
export type ViewResult = JSX.Element;

/**
 * The views the views option of createApp() / applyOidc() may replace. A
 * feature adds the views of its screens to this interface, as optional
 * members (`declare module '../../views.js'` in its views.tsx), and falls back
 * to its own defaults for the ones left out.
 */
export interface Views {
  /** Render the login page (and login error page when error is set) */
  loginPage(params: LoginPageParams): ViewResult;
  /** Render the consent/authorization page */
  consentPage(params: ConsentPageParams): ViewResult;
  /** Render a generic error page */
  errorPage(params: ErrorPageParams): ViewResult;
  /** Render the auto-submitting form of a form_post authorization response */
  formPostPage(params: FormPostPageParams): ViewResult;
}

/** Options applied when renderView turns a view into a Response. */
export interface RenderViewInit {
  /** HTTP status code for the generated Response (defaults to 200). */
  status?: number;
  /**
   * Headers of the generated Response, set over the defaults
   * (Content-Type: text/html; charset=UTF-8 and Cache-Control: no-store).
   * Cookies are attached with withCookies() (pages/respond.ts) instead.
   */
  headers?: HeadersInit;
}

/**
 * 描画したビューを HTML のレスポンスにして返す。
 *
 * ステータスコードは `init.status`（既定は 200）である。
 * ヘッダーは、既定の `Content-Type: text/html; charset=UTF-8` と `Cache-Control: no-store` を、`init.headers` で上書きしたものである。
 *
 * ビューはここで HTML の文字列にする。
 * 非同期のコンポーネントを含むビューは HTML の `Promise` になり、その HTML はできあがってからストリームで送る。
 * そのため、レスポンス（とページがそれに付ける Cookie）は、その場で同期的に作れる。
 *
 * Screens are specific to the transaction or session in this browser’s cookie.
 * 保存された写しがあると、あるトランザクションの `csrf_token`、`login_hint`、クライアントを、別のブラウザやあとのフローに見せてしまう。
 * そのため既定では、ブラウザにも中継サーバーにもページを保存させない（RFC 9111 §5.2.2.5）。
 * キャッシュの扱いが違う画面は、`init.headers` で自分の `Cache-Control` を渡す。
 */
export function renderView(view: ViewResult, init?: RenderViewInit): Response {
  const html = serializeView(view);
  const headers = new Headers({ 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' });
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return new Response(typeof html === 'string' ? html : streamWhenResolved(html), {
    status: init?.status ?? 200,
    headers,
  });
}

/**
 * ビューの HTML を、文字列かその `Promise` で返す。
 *
 * `JSX.Element` の型は文字列だが、実行時の `hono/jsx` の要素は `toString()` で HTML になるオブジェクトであり、非同期のビューはその `Promise` である。
 * `Promise` なら、中の要素を HTML にする `Promise` を返す。
 */
function serializeView(view: ViewResult): string | Promise<string> {
  if (view instanceof Promise) {
    return view.then(serializeView);
  }
  return (view as { toString(): string | Promise<string> }).toString();
}

/**
 * HTML ができてから一度に送るストリームを返す。
 *
 * `html` から HTML の文字列が得られたら、UTF-8 に符号化して一つのチャンクで送り、ストリームを閉じる。
 * `html` が拒否されると、ストリームはエラーになる。
 */
function streamWhenResolved(html: Promise<string>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(await html));
      controller.close();
    },
  });
}

// ============================================================
// Building blocks of the default views
// ============================================================

/**
 * `title` と `children` を入れた HTML 文書を描画する。
 *
 * 既定のビューは、どれもこの文書の中に描画する。
 * JSX には DOCTYPE を書く構文がないので、`raw()` で書く。
 * `raw()` に渡すのは固定の文字列で、ユーザーの入力は渡さない。
 */
export function Layout(props: { title: string; children?: Child }): JSX.Element {
  return (
    <>
      {raw('<!DOCTYPE html>')}
      <html>
        <head>
          <title>{props.title}</title>
        </head>
        <body>{props.children}</body>
      </html>
    </>
  );
}

/**
 * フォームのエラーメッセージを描画する。
 *
 * 残りの試行回数がわかれば、メッセージのあとに続ける。
 * `error` がなければ何も描画しない（`null` を返す）。
 */
export function FormError(props: { error?: string; remainingAttempts?: number }): JSX.Element | null {
  if (!props.error) return null;
  return (
    <p style="color: red;">
      {props.error}
      {props.remainingAttempts !== undefined ? <>. Attempts remaining: {props.remainingAttempts}</> : null}
    </p>
  );
}

/**
 * ユーザー名とパスワードの入力欄を描画する。
 *
 * どのログインフォームでも使う。
 * ユーザー名の欄には `username` を初期値として入れる。
 */
export function CredentialFields(props: { username?: string }): JSX.Element {
  return (
    <>
      <div>
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" value={props.username} required />
      </div>
      <div>
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" required />
      </div>
    </>
  );
}

/**
 * 要求されたスコープの一覧を描画する。
 *
 * クライアントが要求したスコープごとに、リストの項目（`li`）を一つ描画する。
 */
export function ScopeList(props: { scopes: string[] }): JSX.Element {
  return (
    <ul>
      {props.scopes.map((scope) => (
        <li>{scope}</li>
      ))}
    </ul>
  );
}

/**
 * ユーザーが選んだ承認か拒否の結果を描画する。
 *
 * `approved` が `true` なら承認した旨を、`false` なら拒否した旨を、`clientId` とともに表示する。
 */
export function DecisionOutcome(props: { approved: boolean; clientId: string }): JSX.Element {
  return props.approved ? (
    <p>You approved <strong>{props.clientId}</strong>.</p>
  ) : (
    <p>You denied <strong>{props.clientId}</strong>.</p>
  );
}

// ============================================================
// Default Views Implementation
// Replace the components below to customize the UI.
// ============================================================

/**
 * `/login` へ送るログインフォームの画面を描画する。
 *
 * フォームは、ユーザー名とパスワードを、隠しフィールドの `csrf_token` とともに `/login` へ POST する。
 * フォームの下には、機能が加えるほかのログイン方法（Google でのログインなど）を並べる。
 *
 * ユーザー名の欄には `login_hint` を初期値として入れる。
 * 前の試行が失敗していれば、フォームの上にエラーと、わかる場合は残りの試行回数を表示する。
 */
function defaultLoginPage(params: LoginPageParams): JSX.Element {
  // ユーザー名の欄に `login_hint` を初期値として入れた画面を返す（OIDC Core 1.0 §3.1.2.1）。
  // `login_hint` は認証されていない入力だが、JSX の属性に入れるとエスケープされる。
  return (
    <Layout title="Login">
      <h1>Login</h1>
      <FormError error={params.error} remainingAttempts={params.remainingAttempts} />
      <form method="post" action={buildTransactionPath('/login', params.transactionId)}>
        <input type="hidden" name="transaction_id" value={params.transactionId} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <CredentialFields username={params.loginHint ?? ''} />
        <button type="submit">Login</button>
      </form>
      {(params.loginMethods ?? []).map((method) => (
        <>
          <hr />
          {method}
        </>
      ))}
    </Layout>
  );
}

// The submit buttons below carry the authorization decision (OIDC Core 1.0
// Section 3.1.2.4). The consent handler accepts exactly two values — 'approve'
// and 'deny' — and rejects everything else with 400, so customizing this markup
// must keep both button values as they are: renaming 'approve' makes every
// approval fail, and renaming 'deny' makes the Deny button rejected as well.
// See the validate-decision step of endpoints/consent/.
/**
 * クライアントと要求されたスコープの同意画面を描画する。
 *
 * 承認と拒否のボタンは、`action=approve` か `action=deny` を、`csrf_token` とともに `/consent` へ POST する。
 * 同意のハンドラは `approve` と `deny` 以外の値を 400 で拒否するので、画面を作り変えるときもボタンの値は変えない。
 *
 * @spec OIDC Core 1.0 §3.1.2.4
 */
function defaultConsentPage(params: ConsentPageParams): JSX.Element {
  return (
    <Layout title="Consent">
      <h1>Authorize Application</h1>
      <p>Client <strong>{params.clientId}</strong> is requesting access to the following scopes:</p>
      <ScopeList scopes={params.scopes} />
      <form method="post" action={buildTransactionPath('/consent', params.transactionId)}>
        <input type="hidden" name="transaction_id" value={params.transactionId} />
        <input type="hidden" name="csrf_token" value={params.csrfToken} />
        <button type="submit" name="action" value="approve">Approve</button>
        <button type="submit" name="action" value="deny">Deny</button>
      </form>
    </Layout>
  );
}

/**
 * エラーと、あればその説明を表示する画面を描画する。
 *
 * ステータスコードは表示しない。
 */
function defaultErrorPage(params: ErrorPageParams): JSX.Element {
  return (
    <Layout title="Error">
      <h1>Error</h1>
      <p>{params.error}</p>
      {params.errorDescription ? <p>{params.errorDescription}</p> : null}
    </Layout>
  );
}

// OAuth 2.0 Form Post Response Mode §2: the action of the form MUST be the
// client's redirect URI and its method MUST be POST; any technique may submit
// it. The script submits it as soon as it is parsed (Appendix A does the same
// from body onload), and the button inside noscript lets a browser without
// JavaScript continue. The script is a fixed literal, never input.
/**
 * 認可レスポンスを自動で POST するフォームを描画する。
 *
 * フォームは、レスポンスのパラメータを隠しフィールドに入れて、クライアントのリダイレクト URI へ POST する。
 * ページを読み込むとすぐにスクリプトがフォームを送信し、JavaScript が動かないブラウザでは `Continue` のボタンで送信する。
 *
 * @spec OAuth 2.0 Form Post Response Mode §2
 */
function defaultFormPostPage(params: FormPostPageParams): JSX.Element {
  return (
    <Layout title="Submit This Form">
      <form method="post" action={params.action}>
        {Object.entries(params.fields).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
        <noscript>
          <button type="submit">Continue</button>
        </noscript>
      </form>
      {raw('<script>document.forms[0].submit();</script>')}
    </Layout>
  );
}

/**
 * Default Views used when no custom views are injected.
 * These render minimal, unstyled HTML so the flow works out of the box.
 */
export const defaultViews: Views = {
  loginPage: defaultLoginPage,
  consentPage: defaultConsentPage,
  errorPage: defaultErrorPage,
  formPostPage: defaultFormPostPage,
};

/**
 * 既定のビューを、渡したビューで上書きして返す。
 *
 * `overrides` に含まれるビューだけを置き換え、含まれないものは既定のビューのまま残す。
 * `overrides` がなければ `defaultViews` をそのまま返す。
 * 独自の画面は、このファイルを編集せずに、`createApp()` の `views` オプションで渡す（例を参照）。
 *
 * @example
 * ```tsx
 * // 同意画面とエラー画面は既定のまま、ログイン画面だけを独自のものにする。
 * createApp({
 *   signingKeyProvider,
 *   views: {
 *     loginPage: (params) => <MyLoginPage {...params} />,
 *   },
 * });
 * ```
 */
export function createViews(overrides?: Partial<Views>): Views {
  if (!overrides) return defaultViews;
  return { ...defaultViews, ...overrides };
}
