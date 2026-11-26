/**
 * The HTTP face of a workspace: the OP's own paths, which any browser or
 * client sends requests to as it would to a deployed OP (each answered and
 * recorded as an exchange, the response naming it in EXCHANGE_HEADER), and
 * the control API of the pages under LIVE_PREFIX:
 *
 * - `POST /__live/run` `{ request }`: send a request a reader wrote; gives the exchange
 * - `POST /__live/preview` `{ request }`: what a request would do, run on a copy of the workspace's state and not kept
 * - `POST /__live/scenario` `{ id }`: prepare a case's request (PreparedScenario)
 * - `POST /__live/grant` `{ plan }`: run an authorization as a browser and a client (GrantResult)
 * - `GET /__live/exchanges[?after=<id>]`: the exchanges kept, oldest first (summaries)
 * - `GET /__live/exchanges/<id>`: one exchange, whole
 * - `GET /__live/state`, `POST /__live/reset`, `POST /__live/clock` `{ advanceSeconds }`
 * - `GET /__live/probes`: the probe table the traces index
 * - `GET /__live/callback`: the page a browser that signed in comes back to
 *
 * A host (apps/map/worker on Workers, node.ts in Node) finds the workspace
 * of a request (workspaceIdOf) and hands it the request. Before anything
 * runs, a request is refused (refusalOf, answerLive):
 *
 * - 413 for a body past REQUEST_BODY_LIMIT or a URL past REQUEST_URL_LIMIT,
 *   the playground's limits, not the OP's
 * - 400 for a WORKSPACE_HEADER that is not a workspace id
 * - for a request to the control API that changes something (not GET or
 *   HEAD), 403 when the browser says another site made it
 *   (`Sec-Fetch-Site` other than `same-origin` or `none`), and 415 for a
 *   body that is not `application/json`, which a form of another site
 *   cannot send; the control API takes its workspace from the header only,
 *   which such a form cannot set either, so another site cannot reset or
 *   drive a reader's workspace
 */
import {
  EXCHANGE_HEADER,
  isWorkspaceId,
  LIVE_PREFIX,
  PUBLIC_WORKSPACE,
  REQUEST_BODY_LIMIT,
  REQUEST_URL_LIMIT,
  WORKSPACE_COOKIE,
  WORKSPACE_HEADER,
  type GrantPlan,
  type LiveRequest,
} from './api.js';
import { runGrant } from './grant.js';
import { probeTable } from './recorder.js';
import { prepareRecipe } from './scenario-runtime.js';
import { RECIPES } from './scenarios/index.js';
import { LIVE_CALLBACK_PATH } from './seed.js';
import type { LiveWorkspace } from './workspace.js';

/**
 * The paths the OP answers (apps/hono's server app with every feature),
 * as patterns: an exact path, or a prefix ending in `/*`. A host sends a
 * request for one of them, or for LIVE_PREFIX, to a workspace, and every
 * other to the map's pages. `/` and `/health` of the server app are left
 * to the map: the page is at `/`.
 */
export const OP_ROUTES: readonly string[] = [
  '/.well-known/*',
  '/authorize',
  '/login',
  '/login/*',
  '/consent',
  '/token',
  '/userinfo',
  '/introspect',
  '/revoke',
  '/par',
  '/register',
  '/register/*',
  '/device_authorization',
  '/device',
  '/device/*',
  '/backchannel_authentication',
  '/ciba',
  '/ciba/*',
  '/logout',
  '/logout/*',
];

/** Whether a path is one a workspace answers: an OP route (OP_ROUTES) or the control API. */
export function isLivePath(pathname: string): boolean {
  if (pathname.startsWith(LIVE_PREFIX)) return true;
  return OP_ROUTES.some((route) => (route.endsWith('/*') ? pathname.startsWith(route.slice(0, -1)) : pathname === route));
}

/**
 * The workspace a request names: by WORKSPACE_HEADER; for a path of the OP
 * (a browser's own request, a login page opened in a tab), else by
 * WORKSPACE_COOKIE; else PUBLIC_WORKSPACE. The control API does not read the
 * cookie, which a browser sends with a request another site makes it send.
 * A cookie that is not a workspace id names the public workspace; a header
 * that is not one is refused (refusalOf), and named the public one here.
 */
export function workspaceIdOf(request: Request): string {
  const named = request.headers.get(WORKSPACE_HEADER);
  if (named !== null) return isWorkspaceId(named) ? named : PUBLIC_WORKSPACE;
  if (new URL(request.url).pathname.startsWith(LIVE_PREFIX)) return PUBLIC_WORKSPACE;
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === WORKSPACE_COOKIE) {
      const id = value.join('=');
      return isWorkspaceId(id) ? id : PUBLIC_WORKSPACE;
    }
  }
  return PUBLIC_WORKSPACE;
}

/** A JSON response of the control API. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** The answer to a request past the playground's limits (413). */
function tooLarge(): Response {
  return json({
    error: 'content_too_large',
    error_description: `地図の OP（遊び場）の制限を超えています。ボディは ${REQUEST_BODY_LIMIT / 1024} KiB、URL は ${REQUEST_URL_LIMIT / 1024} KiB までです。OP（apps/hono）の制限ではありません。`,
  }, 413);
}

/**
 * The answer to a request refused before anything runs (see the module
 * comment), from its URL and headers alone; undefined for one taken. A
 * host calls it before it finds the workspace, and answerLive again, with
 * the body read too (a body sent without a Content-Length).
 */
export function refusalOf(request: Request): Response | undefined {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (request.url.length > REQUEST_URL_LIMIT || contentLength > REQUEST_BODY_LIMIT) return tooLarge();
  const named = request.headers.get(WORKSPACE_HEADER);
  if (named !== null && !isWorkspaceId(named)) {
    return json({ error: 'invalid_request', error_description: `${WORKSPACE_HEADER} must be a workspace id: 1 to 64 letters, digits, - and _.` }, 400);
  }
  const method = request.method.toUpperCase();
  if (!new URL(request.url).pathname.startsWith(LIVE_PREFIX) || method === 'GET' || method === 'HEAD') return undefined;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return json({ error: 'forbidden', error_description: `The control API takes requests of the map's own pages only (Sec-Fetch-Site: ${site}).` }, 403);
  }
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return json({ error: 'unsupported_media_type', error_description: `A ${method} of the control API takes a JSON body (content-type: application/json).` }, 415);
  }
  return undefined;
}

/** Whether a request's body is larger than REQUEST_BODY_LIMIT: read from a copy (the request is read whole after), no further than the limit. */
async function bodyTooLarge(request: Request): Promise<boolean> {
  const copy = request.body === null ? null : request.clone().body;
  if (copy === null) return false;
  const reader = copy.getReader();
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return false;
    length += value.byteLength;
    if (length > REQUEST_BODY_LIMIT) {
      // Not awaited: the copy is a branch of a tee, whose cancel settles only once the request's own branch is cancelled too.
      reader.cancel().catch(() => undefined);
      return true;
    }
  }
}

/** The body of a control request as JSON; an error for one that is not. */
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Not JSON.
  }
  throw new LiveRequestError('The body must be a JSON object.');
}

/** A control request that cannot be done, answered 400. */
class LiveRequestError extends Error {}

/** A control request past the playground's limits (a request to relay whose URL is past REQUEST_URL_LIMIT), answered 413. */
class LiveLimitError extends Error {}

/** Whether a value is a request a reader wrote (LiveRequest). */
function isLiveRequest(value: unknown): value is LiveRequest {
  if (value === null || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return typeof request['method'] === 'string'
    && typeof request['path'] === 'string'
    && request['path'].startsWith('/')
    && Array.isArray(request['headers'])
    && request['headers'].every((header) => Array.isArray(header) && header.length === 2 && header.every((part) => typeof part === 'string'))
    && (request['body'] === undefined || typeof request['body'] === 'string');
}

/** Text for HTML. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** The page a browser that signed in comes back to: what the OP sent the client, and where to read it on the map. */
function callbackPage(url: URL): Response {
  const rows = [...url.searchParams].map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td><code>${escapeHtml(value)}</code></td></tr>`).join('');
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live OP callback</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:44rem;padding:0 1rem;color:#1f2328}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #d0d7de;padding:.4rem;text-align:left;vertical-align:top}code{word-break:break-all}</style></head>
<body><h1>クライアントへの応答</h1><p>地図の OP がこのクライアント（<code>${escapeHtml(LIVE_CALLBACK_PATH)}</code>）へ返した値です。</p>
<table id="query">${rows === '' ? '<tr><td>クエリはありません。</td></tr>' : rows}</table><h2>フラグメント</h2><table id="fragment"><tr><td>ありません。</td></tr></table>
<p><a href="/#hono--token;p">トークンエンドポイントの地図を開く</a>（この認可コードは「最近のリクエスト」から使えます）</p>
<script>const f=new URLSearchParams(location.hash.slice(1));if([...f].length){const t=document.getElementById('fragment');t.textContent='';for(const [k,v] of f){const r=t.insertRow();r.insertCell().textContent=k;r.insertCell().textContent=v;}}</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Answer a control request of a workspace (see the module comment). */
async function control(workspace: LiveWorkspace, request: Request, url: URL): Promise<Response> {
  const route = url.pathname.slice(LIVE_PREFIX.length);
  const method = request.method.toUpperCase();
  if (route === 'run' && method === 'POST') {
    const body = await bodyOf(request);
    if (!isLiveRequest(body['request'])) throw new LiveRequestError('request must be { method, path, headers, body? } with a path of the OP.');
    if (new URL(body['request'].path, workspace.issuer).href.length > REQUEST_URL_LIMIT) throw new LiveLimitError();
    const { exchange } = await workspace.send(body['request'], 'relay');
    return json(exchange);
  }
  if (route === 'preview' && method === 'POST') {
    const body = await bodyOf(request);
    if (!isLiveRequest(body['request'])) throw new LiveRequestError('request must be { method, path, headers, body? } with a path of the OP.');
    if (new URL(body['request'].path, workspace.issuer).href.length > REQUEST_URL_LIMIT) throw new LiveLimitError();
    return json(await workspace.preview(body['request']));
  }
  if (route === 'scenario' && method === 'POST') {
    const id = (await bodyOf(request))['id'];
    const recipe = typeof id === 'string' ? RECIPES[id] : undefined;
    if (typeof id !== 'string' || recipe === undefined) throw new LiveRequestError(`No case ${String(id)}.`);
    return json(await prepareRecipe(workspace, id, recipe));
  }
  if (route === 'grant' && method === 'POST') {
    const plan = (await bodyOf(request))['plan'] as GrantPlan | undefined;
    if (plan === undefined || typeof plan !== 'object' || typeof plan.authorize !== 'object' || typeof plan.username !== 'string') throw new LiveRequestError('plan must be { authorize, username, exchange, codeVerifier? }.');
    const { browser: _browser, ...result } = await runGrant(workspace, plan);
    return json(result);
  }
  if (route === 'exchanges' && method === 'GET') return json(workspace.summaries(url.searchParams.get('after') ?? undefined));
  if (route.startsWith('exchanges/') && method === 'GET') {
    const exchange = await workspace.exchange(route.slice('exchanges/'.length));
    return exchange === undefined ? json({ error: 'not_found' }, 404) : json(exchange);
  }
  if (route === 'state' && method === 'GET') return json(workspace.state());
  if (route === 'reset' && method === 'POST') {
    await workspace.reset();
    return json(workspace.state());
  }
  if (route === 'clock' && method === 'POST') {
    const seconds = (await bodyOf(request))['advanceSeconds'];
    if (typeof seconds !== 'number') throw new LiveRequestError('advanceSeconds must be a number.');
    await workspace.advanceClock(seconds);
    return json(workspace.state());
  }
  if (route === 'probes' && method === 'GET') {
    const table = probeTable();
    return new Response(JSON.stringify(table), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', etag: `"${table.hash}"` } });
  }
  if (route === 'callback' && method === 'GET') return callbackPage(url);
  return json({ error: 'not_found' }, 404);
}

/**
 * Answer a request a host gave a workspace: the control API, or the OP
 * (recorded, its response naming the exchange). A request refused before
 * anything runs (refusalOf, a body past the limit) is answered so, and a
 * control request that cannot be done 400 with what is wrong.
 */
export async function answerLive(workspace: LiveWorkspace, request: Request): Promise<Response> {
  const refused = refusalOf(request) ?? ((await bodyTooLarge(request)) ? tooLarge() : undefined);
  if (refused !== undefined) return refused;
  const url = new URL(request.url);
  if (url.pathname.startsWith(LIVE_PREFIX)) {
    try {
      return await control(workspace, request, url);
    } catch (error) {
      if (error instanceof LiveRequestError) return json({ error: 'invalid_request', error_description: error.message }, 400);
      if (error instanceof LiveLimitError) return tooLarge();
      return json({ error: 'server_error', error_description: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
  const { response, exchange } = await workspace.answer(request, 'http');
  const headers = new Headers(response.headers);
  headers.set(EXCHANGE_HEADER, exchange.id);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
