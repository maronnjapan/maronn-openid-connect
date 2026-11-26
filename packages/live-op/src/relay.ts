/**
 * The HTTP face of a workspace: the OP's own paths, which any browser or
 * client sends requests to as it would to a deployed OP (each answered and
 * recorded as an exchange, the response naming it in EXCHANGE_HEADER), and
 * the control API of the pages under LIVE_PREFIX:
 *
 * - `POST /__live/run` `{ request }`: send a request a reader wrote; gives the exchange
 * - `POST /__live/scenario` `{ id }`: prepare a case's request (PreparedScenario)
 * - `POST /__live/grant` `{ plan }`: run an authorization as a browser and a client (GrantResult)
 * - `GET /__live/exchanges[?after=<id>]`: the exchanges kept, oldest first (summaries)
 * - `GET /__live/exchanges/<id>`: one exchange, whole
 * - `GET /__live/state`, `POST /__live/reset`, `POST /__live/clock` `{ advanceSeconds }`
 * - `GET /__live/probes`: the probe table the traces index
 * - `GET /__live/callback`: the page a browser that signed in comes back to
 *
 * A host (apps/map/worker on Workers, node.ts in Node) finds the workspace
 * of a request (workspaceIdOf) and hands it the request.
 */
import { EXCHANGE_HEADER, isWorkspaceId, LIVE_PREFIX, PUBLIC_WORKSPACE, WORKSPACE_COOKIE, WORKSPACE_HEADER, type GrantPlan, type LiveRequest } from './api.js';
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

/** The workspace a request names: by WORKSPACE_HEADER, else by WORKSPACE_COOKIE, else PUBLIC_WORKSPACE. A name that is not a workspace id is the public one. */
export function workspaceIdOf(request: Request): string {
  const named = request.headers.get(WORKSPACE_HEADER);
  if (named !== null) return isWorkspaceId(named) ? named : PUBLIC_WORKSPACE;
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
    const { exchange } = await workspace.send(body['request'], 'relay');
    return json(exchange);
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
 * (recorded, its response naming the exchange). A control request that
 * cannot be done is answered 400 with what is wrong.
 */
export async function answerLive(workspace: LiveWorkspace, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith(LIVE_PREFIX)) {
    try {
      return await control(workspace, request, url);
    } catch (error) {
      if (error instanceof LiveRequestError) return json({ error: 'invalid_request', error_description: error.message }, 400);
      return json({ error: 'server_error', error_description: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
  const { response, exchange } = await workspace.answer(request, 'http');
  const headers = new Headers(response.headers);
  headers.set(EXCHANGE_HEADER, exchange.id);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
