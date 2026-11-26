/**
 * The live OP at the origin of a Vite server (`@maronn-openid-connect/live-op/vite`):
 * a plugin that answers the OP's paths and the control API (isLivePath)
 * with the Node host (dist/node.js) in the dev server and the preview
 * server alike, as the map's Worker does on Cloudflare (apps/map/worker),
 * and leaves every other path to Vite. The issuer of a workspace is the
 * origin the browser asked (its Host), so the OP's pages and redirects
 * point back to the page's server.
 *
 * Vite loads this file with the config, in Node, outside the bundle of the
 * OP: it is written with types Node strips (no syntax of TypeScript's own),
 * and loads the OP's build (dist/live-op.js and dist/node.js) when the
 * server starts. Without the build the page is still served, and the
 * control API answers that the OP is not built.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import type { LiveOpHost } from './node.js';

/** The options of the plugin: the issuer, when every workspace is to have one whatever origin it is asked at. */
export interface LiveOpOptions {
  issuer?: string;
}

/** What the plugin uses of the OP's build: the paths it answers and the Node host. */
interface LiveOpBuild {
  isLivePath: (pathname: string) => boolean;
  host: LiveOpHost;
}

/** The control API's paths (LIVE_PREFIX of api.ts), which the plugin answers even when the OP's build cannot be loaded, to say so. */
const CONTROL_PREFIX = '/__live/';

/** A web Request from a request Node received: at the origin the browser asked (its Host), with every header and the body. */
async function requestOf(message: IncomingMessage): Promise<Request> {
  const secure = (message.socket as { encrypted?: boolean }).encrypted === true;
  const url = new URL(message.url ?? '/', `${secure ? 'https' : 'http'}://${message.headers.host ?? '127.0.0.1'}`);
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index] ?? '';
    // HTTP/2 gives its pseudo-headers (:authority, …) among the others; a Request takes none.
    if (!name.startsWith(':')) headers.append(name, message.rawHeaders[index + 1] ?? '');
  }
  const method = message.method ?? 'GET';
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const body = ['GET', 'HEAD'].includes(method) || chunks.length === 0 ? undefined : Buffer.concat(chunks);
  return new Request(url, { method, headers, redirect: 'manual', ...(body === undefined ? {} : { body }) });
}

/** Write a web Response to a Node response, every Set-Cookie kept on a header of its own. */
async function write(response: Response, into: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value;
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  // Node's own reason phrase when the response has none.
  if (response.statusText === '') into.writeHead(response.status, headers);
  else into.writeHead(response.status, response.statusText, headers);
  into.end(Buffer.from(await response.arrayBuffer()));
}

/** The plugin (see the module comment). */
export function liveOp(options: LiveOpOptions = {}): Plugin {
  let build: Promise<LiveOpBuild> | undefined;

  /** The OP's build, loaded once (the server starts loading it); loaded again on the next request when it could not be. */
  function buildOf(): Promise<LiveOpBuild> {
    if (build === undefined) {
      // URLs, not specifiers: Vite bundles a config's own files, and must leave the OP's build to Node.
      const op = import(new URL('../dist/live-op.js', import.meta.url).href) as Promise<typeof import('./index.js')>;
      const node = import(new URL('../dist/node.js', import.meta.url).href) as Promise<typeof import('./node.js')>;
      const loading = Promise.all([op, node]).then(([{ isLivePath }, { createLiveOpHost }]) => ({ isLivePath, host: createLiveOpHost(options) }));
      build = loading;
      loading.catch(() => {
        if (build === loading) build = undefined;
      });
    }
    return build;
  }

  /** Answer the live paths with the host; leave every other to the next middleware. */
  const middleware: Connect.NextHandleFunction = (message, response, next) => {
    const path = (message.url ?? '/').split('?')[0] ?? '/';
    void (async () => {
      let answer: Response | undefined;
      try {
        const loaded = await buildOf().catch((error: unknown) => {
          if (!path.startsWith(CONTROL_PREFIX)) return undefined;
          throw new Error(`The live OP is not built (pnpm --filter @maronn-openid-connect/live-op build): ${error instanceof Error ? error.message : String(error)}`);
        });
        if (loaded === undefined || !loaded.isLivePath(path)) {
          next();
          return;
        }
        answer = (await loaded.host.fetch(await requestOf(message))) ?? new Response('Not a path of the live OP.', { status: 404 });
      } catch (error) {
        answer = new Response(error instanceof Error ? (error.stack ?? error.message) : String(error), { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      await write(answer, response);
    })();
  };

  /** Start loading the build with the server, so the first request does not wait for it; say so when it cannot be. */
  function preload(): void {
    buildOf().catch((error: unknown) => {
      console.warn(`[live-op] The live OP is not served: its build could not be loaded (pnpm --filter @maronn-openid-connect/live-op build). ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return {
    name: 'maronn-live-op',
    configureServer(server) {
      preload();
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      preload();
      server.middlewares.use(middleware);
    },
  };
}
