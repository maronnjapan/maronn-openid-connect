import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export function toWebRequest(
  incoming: IncomingMessage & { originalUrl?: string },
  baseUrl = 'http://localhost',
  bodyOverride?: BodyInit | null,
): Request {
  const path = incoming.originalUrl ?? incoming.url ?? '/';
  // Only the path is taken from the incoming request; the origin comes from
  // baseUrl (config.issuer via applyOidc). URLs the OP builds for itself —
  // the /login and /consent redirect Locations — therefore never depend on
  // the Host header (OIDC Discovery 1.0 §3 / RFC 9700 §2.1).
  const url = new URL(path, baseUrl);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const method = incoming.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
  };
  if (hasBody) {
    if (bodyOverride !== undefined) {
      init.body = bodyOverride;
    } else {
      init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      init.duplex = 'half';
    }
  }
  return new Request(url, init);
}

export async function writeWebResponse(
  outgoing: ServerResponse,
  response: Response,
): Promise<void> {
  outgoing.statusCode = response.status;
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) {
    outgoing.setHeader('Set-Cookie', setCookies);
  }
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return;
    outgoing.setHeader(name, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.end(body);
}
