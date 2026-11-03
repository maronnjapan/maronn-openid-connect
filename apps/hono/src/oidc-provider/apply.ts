import type { Hono } from 'hono';
import { createApp, type OidcProviderOptions } from './app.js';

export type ApplyOidcOptions = OidcProviderOptions;

/**
 * 既存の Hono のアプリに OP のルートを組み込む。
 *
 * `createApp()` が作る OP のルーターを、アプリの最上位のパス（`/`）に組み込む。
 * アプリに OP の機能を加えるときに呼ぶ。
 *
 * @example
 * ```ts
 * import { Hono } from 'hono';
 * import { applyOidc } from './oidc-provider/apply.js';
 *
 * const app = new Hono();
 * app.get('/', (c) => c.text('Hello World'));
 * applyOidc(app, { signingKeyProvider: yourProvider });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOidc(app: Hono<any>, options: ApplyOidcOptions): void {
  app.route('/', createApp(options));
}
