/**
 * The live OP in Node: one process holding the workspaces in memory, for
 * the map's dev server (Vite sends it the OP's paths and the control API),
 * the build of the map's data and the tests. On Workers the same bundle
 * runs in a Durable Object per workspace (apps/map/worker).
 *
 * The issuer of a workspace is the origin its requests were sent to (the
 * Host the browser asked, which Vite's proxy passes on), unless the host is
 * started with one: the OP's pages and redirects then point back where the
 * browser is.
 *
 *   node packages/live-op/dist/node.js [--port 3611] [--host 127.0.0.1] [--issuer http://127.0.0.1:3610]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { isLivePath, LiveWorkspace, workspaceIdOf, answerLive } from './index.js';

/** A Node host of the live OP. */
export interface LiveOpHost {
  /** The workspace of an id under an issuer, made on first use. */
  workspace(issuer: string, id: string): Promise<LiveWorkspace>;
  /** Answer a request for an OP path or the control API (isLivePath); undefined for any other path. */
  fetch(request: Request): Promise<Response | undefined>;
}

/** Make a Node host (see the module comment). */
export function createLiveOpHost(options: { issuer?: string } = {}): LiveOpHost {
  const workspaces = new Map<string, Promise<LiveWorkspace>>();
  const workspace = (issuer: string, id: string): Promise<LiveWorkspace> => {
    const key = `${issuer} ${id}`;
    let made = workspaces.get(key);
    if (made === undefined) {
      made = LiveWorkspace.open(id, issuer);
      workspaces.set(key, made);
      made.catch(() => workspaces.delete(key));
    }
    return made;
  };
  return {
    workspace,
    async fetch(request) {
      const url = new URL(request.url);
      if (!isLivePath(url.pathname)) return undefined;
      const issuer = options.issuer ?? url.origin;
      return answerLive(await workspace(issuer, workspaceIdOf(request)), request);
    },
  };
}

/** A Request of the web from a request Node received, at the origin its Host names. */
async function requestOf(message: IncomingMessage): Promise<Request> {
  const host = message.headers['x-forwarded-host'] ?? message.headers.host ?? '127.0.0.1';
  const protocol = message.headers['x-forwarded-proto'] ?? 'http';
  const url = new URL(message.url ?? '/', `${String(protocol).split(',')[0]}://${String(host).split(',')[0]}`);
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) headers.append(message.rawHeaders[index] ?? '', message.rawHeaders[index + 1] ?? '');
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const body = chunks.length === 0 || ['GET', 'HEAD'].includes(message.method ?? 'GET') ? undefined : Buffer.concat(chunks);
  return new Request(url, { method: message.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
}

/** Write a Response of the web to a Node response, every Set-Cookie kept. */
async function write(response: Response, into: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) if (name !== 'set-cookie') headers[name] = value;
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  into.writeHead(response.status, response.statusText, headers);
  into.end(Buffer.from(await response.arrayBuffer()));
}

/** Serve a host over HTTP: the live paths to the workspaces, any other answered 404. */
export function serveLiveOp(options: { port: number; host?: string; issuer?: string }): Promise<{ close: () => Promise<void>; url: string }> {
  const host = createLiveOpHost(options.issuer === undefined ? {} : { issuer: options.issuer });
  const server = createServer((message, response) => {
    void (async () => {
      try {
        const answered = await host.fetch(await requestOf(message));
        await write(answered ?? new Response('Not a path of the live OP.', { status: 404 }), response);
      } catch (error) {
        await write(new Response(String(error instanceof Error ? error.stack : error), { status: 500 }), response);
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      resolve({
        url: `http://${options.host ?? '127.0.0.1'}:${options.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The value of a command-line option. */
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const port = Number(option(args, '--port') ?? process.env['LIVE_OP_PORT'] ?? 3611);
  const issuer = option(args, '--issuer') ?? process.env['LIVE_OP_ISSUER'];
  const served = await serveLiveOp({ port, host: option(args, '--host') ?? '127.0.0.1', ...(issuer === undefined ? {} : { issuer }) });
  console.log(`Live OP listening on ${served.url}${issuer === undefined ? ' (issuer: the origin of each request)' : ` (issuer ${issuer})`}`);
}
