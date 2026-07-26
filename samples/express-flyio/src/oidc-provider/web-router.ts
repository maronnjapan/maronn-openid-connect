export type WebHandler = (c: WebContext) => Response | Promise<Response>;
export type WebMiddleware = (
  c: WebContext,
  next: () => Promise<Response>,
) => Response | void | Promise<Response | void>;

interface Route {
  method: string;
  path: string;
  handler: WebHandler;
}

interface MiddlewareEntry {
  path: string;
  handler: WebMiddleware;
}

interface MountEntry {
  prefix: string;
  router: WebRouter;
}

export class WebRequest {
  constructor(readonly raw: Request) {}

  get method(): string {
    return this.raw.method;
  }

  get url(): string {
    return this.raw.url;
  }

  header(name: string): string | undefined {
    return this.raw.headers.get(name) ?? undefined;
  }

  query(name: string): string | undefined {
    return new URL(this.raw.url).searchParams.get(name) ?? undefined;
  }

  text(): Promise<string> {
    return this.raw.text();
  }

  async parseBody(): Promise<Record<string, string | File>> {
    const contentType = this.raw.headers.get('Content-Type') ?? '';
    const mediaType = contentType.toLowerCase().split(';')[0]?.trim() ?? '';

    if (mediaType === 'application/x-www-form-urlencoded') {
      const params = new URLSearchParams(await this.raw.text());
      return Object.fromEntries(params);
    }

    if (mediaType === 'multipart/form-data') {
      const formData = await this.raw.formData();
      const body: Record<string, string | File> = {};
      for (const [key, value] of formData.entries()) {
        body[key] = value;
      }
      return body;
    }

    return {};
  }
}

export class WebContext {
  readonly req: WebRequest;
  private readonly variables = new Map<string, unknown>();
  private readonly responseHeaders = new Headers();

  constructor(request: Request) {
    this.req = new WebRequest(request);
  }

  set(key: string, value: unknown): void {
    this.variables.set(key, value);
  }

  // Mirrors Hono's loose context variable API so generated route templates can
  // stay framework-neutral without forcing every c.get() call to cast.
  get(key: string): any {
    return this.variables.get(key);
  }

  header(name: string, value: string): void {
    this.responseHeaders.set(name, value);
  }

  json(data: unknown, status = 200): Response {
    const headers = this.headersForResponse();
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return new Response(JSON.stringify(data), { status, headers });
  }

  text(data: string, status = 200): Response {
    const headers = this.headersForResponse();
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'text/plain; charset=UTF-8');
    }
    return new Response(data, { status, headers });
  }

  html(data: string, status = 200): Response {
    const headers = this.headersForResponse();
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'text/html; charset=UTF-8');
    }
    return new Response(data, { status, headers });
  }

  body(data: BodyInit | null, status = 200): Response {
    return new Response(data, { status, headers: this.headersForResponse() });
  }

  redirect(url: string, status = 302): Response {
    const headers = this.headersForResponse();
    headers.set('Location', url);
    return new Response(null, { status, headers });
  }

  private headersForResponse(): Headers {
    return new Headers(this.responseHeaders);
  }
}

export class WebRouter {
  private readonly routes: Route[] = [];
  private readonly middleware: MiddlewareEntry[] = [];
  private readonly mounts: MountEntry[] = [];

  use(path: string, handler: WebMiddleware): void {
    this.middleware.push({ path, handler });
  }

  route(prefix: string, router: WebRouter): void {
    this.mounts.push({ prefix: normalizeMount(prefix), router });
  }

  get(path: string, handler: WebHandler): void {
    this.addRoute('GET', path, handler);
  }

  post(path: string, handler: WebHandler): void {
    this.addRoute('POST', path, handler);
  }

  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request
      ? input
      : new Request(resolveRequestInput(input), init);
    return this.fetch(request);
  }

  fetch(request: Request): Promise<Response> {
    const context = new WebContext(request);
    const path = new URL(request.url).pathname;
    return this.dispatch(context, normalizePath(path));
  }

  private addRoute(method: string, path: string, handler: WebHandler): void {
    this.routes.push({ method, path: normalizePath(path), handler });
  }

  private async dispatch(context: WebContext, path: string): Promise<Response> {
    const middleware = this.middleware.filter((entry) =>
      entry.path === '*' || pathMatches(entry.path, path),
    );
    let index = -1;

    const run = async (): Promise<Response> => {
      index += 1;
      const entry = middleware[index];
      if (!entry) {
        return this.dispatchRoute(context, path);
      }

      let nextResponse: Response | undefined;
      const result = await entry.handler(context, async () => {
        nextResponse = await run();
        return nextResponse;
      });

      if (result instanceof Response) {
        return result;
      }
      if (nextResponse) {
        return nextResponse;
      }
      return new Response(null, { status: 204 });
    };

    return run();
  }

  private dispatchRoute(context: WebContext, path: string): Promise<Response> {
    for (const mount of this.mounts) {
      const childPath = childPathForMount(path, mount.prefix);
      if (childPath !== undefined) {
        return mount.router.dispatch(context, childPath);
      }
    }

    const route = this.routes.find(
      (candidate) =>
        candidate.method === context.req.method &&
        candidate.path === path,
    );
    if (route) {
      return Promise.resolve(route.handler(context));
    }

    // RFC 9110 §9.1: general-purpose servers MUST support HEAD wherever GET is
    // supported. RFC 9110 §9.3.2: HEAD shares GET semantics but MUST NOT return a
    // body. Serve HEAD from the GET handler with the body stripped.
    if (context.req.method === 'HEAD') {
      const getRoute = this.routes.find(
        (candidate) => candidate.method === 'GET' && candidate.path === path,
      );
      if (getRoute) {
        return Promise.resolve(getRoute.handler(context)).then(
          (response) =>
            new Response(null, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }),
        );
      }
    }

    const allowedMethods = this.routes
      .filter((candidate) => candidate.path === path)
      .map((candidate) => candidate.method);
    if (allowedMethods.length > 0) {
      return Promise.resolve(new Response(null, { status: 405, headers: { Allow: allowedMethods.join(', ') } }));
    }

    return Promise.resolve(new Response('Not Found', { status: 404 }));
  }
}

function resolveRequestInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === 'string' && input.startsWith('/')) {
    return new URL(input, 'http://localhost');
  }
  return input;
}

function normalizeMount(prefix: string): string {
  const normalized = normalizePath(prefix);
  return normalized === '/' ? '' : normalized;
}

function normalizePath(path: string): string {
  if (path === '') return '/';
  return path.startsWith('/') ? path : '/' + path;
}

function pathMatches(pattern: string, path: string): boolean {
  const normalized = normalizeMount(pattern);
  if (normalized === '') return true;
  return path === normalized || path.startsWith(normalized + '/');
}

function childPathForMount(path: string, prefix: string): string | undefined {
  if (path === prefix) return '/';
  if (path.startsWith(prefix + '/')) {
    const childPath = path.slice(prefix.length);
    return childPath === '' ? '/' : childPath;
  }
  return undefined;
}
