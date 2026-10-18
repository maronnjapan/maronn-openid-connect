import { describe, expect, it } from 'vitest';
import { WebContext, WebRequest, WebRouter } from './web-router.js';

const ORIGIN = 'https://op.example.com';

/** A router that answers GET and POST on /token with the method it was called with. */
function tokenRouter(): WebRouter {
  const router = new WebRouter();
  router.get('/token', (c) => c.text('GET token'));
  router.post('/token', (c) => c.text('POST token'));
  return router;
}

/** A router whose only route answers GET / with name. */
function namedRouter(name: string): WebRouter {
  const router = new WebRouter();
  router.get('/', (c) => c.text(name));
  router.post('/', (c) => c.text(name));
  return router;
}

describe('WebRouter', () => {
  describe('Routing', () => {
    it('should answer a GET route with the response of its handler', async () => {
      const response = await tokenRouter().request(`${ORIGIN}/token`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('GET token');
    });

    it('should answer a POST route with the response of its handler', async () => {
      const response = await tokenRouter().request(`${ORIGIN}/token`, { method: 'POST' });

      expect(await response.text()).toBe('POST token');
    });

    it('should resolve a path given to request() against http://localhost', async () => {
      const router = new WebRouter();
      router.get('/where', (c) => c.text(c.req.url));

      const response = await router.request('/where?x=1');

      expect(await response.text()).toBe('http://localhost/where?x=1');
    });

    it('should apply the init given to request() with a Request', async () => {
      const response = await tokenRouter().request(new Request(`${ORIGIN}/token`), { method: 'POST' });

      expect(await response.text()).toBe('POST token');
    });

    it('should dispatch a Request handed to fetch() on its pathname', async () => {
      const response = await tokenRouter().fetch(new Request(`${ORIGIN}/token?ignored=1`, { method: 'POST' }));

      expect(await response.text()).toBe('POST token');
    });

    it('should match a route registered without a leading slash', async () => {
      const router = new WebRouter();
      router.get('status', (c) => c.text('up'));

      expect(await (await router.request('/status')).text()).toBe('up');
    });

    // RFC 9110 §15.5.5
    it('should answer 404 Not Found for a path no route serves', async () => {
      const response = await tokenRouter().request(`${ORIGIN}/unknown`);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not Found');
    });

    // RFC 9110 §15.5.6: a 405 carries the Allow header of the target resource.
    it('should answer 405 with the methods of a known path in Allow', async () => {
      const response = await tokenRouter().request(`${ORIGIN}/token`, { method: 'DELETE' });

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, POST');
      expect(await response.text()).toBe('');
    });
  });

  // RFC 9110 §9.1: HEAD is supported wherever GET is.
  describe('HEAD', () => {
    // RFC 9110 §9.3.2: HEAD has the semantics of GET but the response has no content.
    it('should answer HEAD with the status and headers of the GET handler and no body', async () => {
      const router = new WebRouter();
      router.get('/doc', (c) => {
        c.header('Cache-Control', 'public, max-age=3600');
        return c.json({ hello: 'world' }, 203);
      });

      const response = await router.request('/doc', { method: 'HEAD' });

      expect(response.status).toBe(203);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
      expect(response.body).toBeNull();
    });

    it('should answer HEAD on a path without a GET route with 405', async () => {
      const router = new WebRouter();
      router.post('/token', (c) => c.text('POST token'));

      const response = await router.request('/token', { method: 'HEAD' });

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    });
  });

  describe('Mounting', () => {
    it('should answer the mount prefix with the root route of the mounted router', async () => {
      const app = new WebRouter();
      app.route('/device', namedRouter('device'));

      expect(await (await app.request('/device')).text()).toBe('device');
    });

    it('should hand the path below the prefix to the mounted router', async () => {
      const device = new WebRouter();
      device.post('/login', (c) => c.text('device login'));
      const app = new WebRouter();
      app.route('/device', device);

      const response = await app.request('/device/login', { method: 'POST' });

      expect(await response.text()).toBe('device login');
    });

    it('should let the longest mount prefix win when the shorter one is mounted first', async () => {
      const app = new WebRouter();
      app.route('/login', namedRouter('login'));
      app.route('/login/google', namedRouter('google'));

      const response = await app.request('/login/google', { method: 'POST' });

      expect(await response.text()).toBe('google');
    });

    it('should let the longest mount prefix win when the longer one is mounted first', async () => {
      const app = new WebRouter();
      app.route('/login/google', namedRouter('google'));
      app.route('/login', namedRouter('login'));

      const google = await app.request('/login/google', { method: 'POST' });
      const login = await app.request('/login', { method: 'POST' });

      expect(await google.text()).toBe('google');
      expect(await login.text()).toBe('login');
    });

    it('should not treat a path that merely starts with the prefix as below it', async () => {
      const app = new WebRouter();
      app.route('/login', namedRouter('login'));

      expect((await app.request('/loginx')).status).toBe(404);
    });

    it('should hand every path to a router mounted at /', async () => {
      const app = new WebRouter();
      app.route('/', tokenRouter());

      expect(await (await app.request('/token')).text()).toBe('GET token');
    });

    it('should answer 405 from the mounted router for a method it does not serve', async () => {
      const app = new WebRouter();
      app.route('/', tokenRouter());

      const response = await app.request('/token', { method: 'PUT' });

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, POST');
    });
  });

  describe('Middleware', () => {
    it('should run the middleware in registration order around the handler', async () => {
      const calls: string[] = [];
      const router = new WebRouter();
      router.use('*', async (_c, next) => {
        calls.push('first:before');
        await next();
        calls.push('first:after');
      });
      router.use('*', async (_c, next) => {
        calls.push('second:before');
        await next();
        calls.push('second:after');
      });
      router.get('/', (c) => {
        calls.push('handler');
        return c.text('ok');
      });

      await router.request('/');

      expect(calls).toEqual(['first:before', 'second:before', 'handler', 'second:after', 'first:after']);
    });

    it('should answer with the response of the handler when a middleware calls next and returns nothing', async () => {
      const router = new WebRouter();
      router.use('*', async (_c, next) => {
        await next();
      });
      router.get('/', (c) => c.text('from handler', 201));

      const response = await router.request('/');

      expect(response.status).toBe(201);
      expect(await response.text()).toBe('from handler');
    });

    it('should short-circuit with the response a middleware returns without calling next', async () => {
      const calls: string[] = [];
      const router = new WebRouter();
      router.use('*', (c) => c.json({ error: 'blocked' }, 403));
      router.use('*', async (_c, next) => {
        calls.push('second middleware');
        await next();
      });
      router.get('/', (c) => {
        calls.push('handler');
        return c.text('ok');
      });

      const response = await router.request('/');

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'blocked' });
      expect(calls).toEqual([]);
    });

    it('should replace the downstream response with the one a middleware returns after next', async () => {
      const router = new WebRouter();
      router.use('*', async (c, next) => {
        await next();
        return c.text('replaced', 202);
      });
      router.get('/', (c) => c.text('original'));

      const response = await router.request('/');

      expect(response.status).toBe(202);
      expect(await response.text()).toBe('replaced');
    });

    it('should answer 204 with no body when a middleware neither calls next nor returns a response', async () => {
      const router = new WebRouter();
      router.use('*', () => undefined);
      router.get('/', (c) => c.text('unreached'));

      const response = await router.request('/');

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    });

    it('should run a path middleware for the path and the paths below it only', async () => {
      const seen: string[] = [];
      const router = new WebRouter();
      router.use('/device', async (c, next) => {
        seen.push(new URL(c.req.url).pathname);
        await next();
      });
      router.get('/device', (c) => c.text('device'));
      router.get('/device/login', (c) => c.text('device login'));
      router.get('/devices', (c) => c.text('devices'));

      await router.request('/device');
      await router.request('/device/login');
      await router.request('/devices');

      expect(seen).toEqual(['/device', '/device/login']);
    });

    it('should run a /* middleware for the path and the paths below it only', async () => {
      const seen: string[] = [];
      const router = new WebRouter();
      router.use('/device/*', async (c, next) => {
        seen.push(new URL(c.req.url).pathname);
        await next();
      });
      router.get('/device', (c) => c.text('device'));
      router.get('/device/login', (c) => c.text('device login'));
      router.get('/devices', (c) => c.text('devices'));

      await router.request('/device');
      await router.request('/device/login');
      await router.request('/devices');

      expect(seen).toEqual(['/device', '/device/login']);
    });

    it('should run a * middleware for a path no route serves', async () => {
      const seen: string[] = [];
      const router = new WebRouter();
      router.use('*', async (c, next) => {
        seen.push(new URL(c.req.url).pathname);
        await next();
      });

      const response = await router.request('/nowhere');

      expect(response.status).toBe(404);
      expect(seen).toEqual(['/nowhere']);
    });

    it('should run the middleware of the parent router before that of the mounted router', async () => {
      const calls: string[] = [];
      const child = new WebRouter();
      child.use('*', async (_c, next) => {
        calls.push('child');
        await next();
      });
      child.get('/', (c) => {
        calls.push('handler');
        return c.text('ok');
      });
      const app = new WebRouter();
      app.use('*', async (_c, next) => {
        calls.push('parent');
        await next();
      });
      app.route('/jwks', child);

      await app.request('/jwks');

      expect(calls).toEqual(['parent', 'child', 'handler']);
    });

    it('should carry the headers and variables a middleware set onto the response of the handler', async () => {
      const router = new WebRouter();
      router.use('*', async (c, next) => {
        c.header('Access-Control-Allow-Origin', '*');
        c.set('issuer', ORIGIN);
        await next();
      });
      router.get('/', (c) => c.json({ issuer: c.get('issuer') }));

      const response = await router.request('/');

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(await response.json()).toEqual({ issuer: ORIGIN });
    });
  });
});

describe('WebContext', () => {
  function context(): WebContext {
    return new WebContext(new Request(`${ORIGIN}/`));
  }

  describe('json', () => {
    it('should answer 200 with the serialized value as application/json', async () => {
      const response = context().json({ keys: [] });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(await response.text()).toBe('{"keys":[]}');
    });

    it('should answer with the given status', () => {
      expect(context().json({ error: 'invalid_client' }, 401).status).toBe(401);
    });

    it('should keep a Content-Type staged with header()', () => {
      const c = context();
      c.header('Content-Type', 'application/jwk-set+json');

      expect(c.json({ keys: [] }).headers.get('Content-Type')).toBe('application/jwk-set+json');
    });
  });

  describe('text', () => {
    it('should answer with the text as text/plain in UTF-8', async () => {
      const response = context().text('hello', 418);

      expect(response.status).toBe(418);
      expect(response.headers.get('Content-Type')).toBe('text/plain; charset=UTF-8');
      expect(await response.text()).toBe('hello');
    });
  });

  describe('html', () => {
    it('should answer with the markup as text/html in UTF-8', async () => {
      const response = context().html('<h1>Login</h1>');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(await response.text()).toBe('<h1>Login</h1>');
    });
  });

  describe('body', () => {
    // RFC 9110 §15.3.5
    it('should answer 204 with no body and no Content-Type for a null body', async () => {
      const response = context().body(null, 204);

      expect(response.status).toBe(204);
      expect(response.headers.get('Content-Type')).toBeNull();
      expect(response.body).toBeNull();
    });

    it('should answer 200 with the given bytes', async () => {
      const response = context().body(new Uint8Array([0, 255, 1]));

      expect(response.status).toBe(200);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 1]);
    });
  });

  describe('redirect', () => {
    // RFC 9110 §15.4.3 / §10.2.2
    it('should answer 302 with the URL in Location and no body', () => {
      const response = context().redirect(`${ORIGIN}/login`);

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://op.example.com/login');
      expect(response.body).toBeNull();
    });

    it('should answer with the given redirect status', () => {
      expect(context().redirect(`${ORIGIN}/consent`, 303).status).toBe(303);
    });
  });

  describe('header', () => {
    it('should put a staged header on every response built afterwards', () => {
      const c = context();
      c.header('Cache-Control', 'no-store');

      expect(c.json({}).headers.get('Cache-Control')).toBe('no-store');
      expect(c.redirect(`${ORIGIN}/`).headers.get('Cache-Control')).toBe('no-store');
    });

    it('should replace the earlier value of a header staged twice', () => {
      const c = context();
      c.header('Vary', 'Accept');
      c.header('Vary', 'Origin');

      expect(c.text('ok').headers.get('Vary')).toBe('Origin');
    });

    it('should leave a response already built unchanged by a header staged later', () => {
      const c = context();
      const response = c.text('ok');
      c.header('Cache-Control', 'no-store');

      expect(response.headers.get('Cache-Control')).toBeNull();
    });
  });

  describe('set / get', () => {
    it('should return the value set under the key', () => {
      const c = context();
      c.set('config', { issuer: ORIGIN });

      expect(c.get('config')).toEqual({ issuer: ORIGIN });
    });

    it('should return undefined for a key that was never set', () => {
      expect(context().get('missing')).toBeUndefined();
    });
  });
});

describe('WebRequest', () => {
  function formRequest(contentType: string, body: string): WebRequest {
    return new WebRequest(
      new Request(`${ORIGIN}/token`, { method: 'POST', headers: { 'Content-Type': contentType }, body }),
    );
  }

  it('should expose the method and the URL of the request', () => {
    const request = new WebRequest(new Request(`${ORIGIN}/token?a=1`, { method: 'POST' }));

    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://op.example.com/token?a=1');
  });

  describe('header', () => {
    it('should return a header whatever the case of its name', () => {
      const request = new WebRequest(new Request(`${ORIGIN}/`, { headers: { Authorization: 'Basic abc' } }));

      expect(request.header('authorization')).toBe('Basic abc');
    });

    it('should return undefined for a header the request does not carry', () => {
      expect(new WebRequest(new Request(`${ORIGIN}/`)).header('Origin')).toBeUndefined();
    });
  });

  describe('query', () => {
    it('should return the decoded value of a query parameter', () => {
      const request = new WebRequest(new Request(`${ORIGIN}/device?user_code=BCDF%2DGHJK`));

      expect(request.query('user_code')).toBe('BCDF-GHJK');
    });

    it('should return the first value of a repeated query parameter', () => {
      const request = new WebRequest(new Request(`${ORIGIN}/authorize?scope=openid&scope=profile`));

      expect(request.query('scope')).toBe('openid');
    });

    it('should return undefined for a query parameter the URL does not carry', () => {
      expect(new WebRequest(new Request(`${ORIGIN}/authorize`)).query('state')).toBeUndefined();
    });
  });

  describe('text', () => {
    it('should return the raw body', async () => {
      const request = formRequest('application/x-www-form-urlencoded', 'grant_type=authorization_code&code=a%2Bb');

      expect(await request.text()).toBe('grant_type=authorization_code&code=a%2Bb');
    });
  });

  describe('parseBody', () => {
    // WHATWG URL Standard §5 (application/x-www-form-urlencoded)
    it('should decode a form-urlencoded body into its fields', async () => {
      const request = formRequest('application/x-www-form-urlencoded', 'username=alice&password=p%40ss+word');

      expect(await request.parseBody()).toEqual({ username: 'alice', password: 'p@ss word' });
    });

    it('should accept a form-urlencoded media type with parameters in any case', async () => {
      const request = formRequest('Application/X-WWW-Form-Urlencoded; charset=UTF-8', 'csrf_token=t-1');

      expect(await request.parseBody()).toEqual({ csrf_token: 't-1' });
    });

    it('should keep the last value of a repeated form field', async () => {
      const request = formRequest('application/x-www-form-urlencoded', 'decision=deny&decision=approve');

      expect(await request.parseBody()).toEqual({ decision: 'approve' });
    });

    // RFC 7578: multipart/form-data
    it('should decode a multipart body into its text fields and files', async () => {
      const form = new FormData();
      form.append('username', 'alice');
      form.append('avatar', new File(['hello'], 'avatar.txt', { type: 'text/plain' }));
      const request = new WebRequest(new Request(`${ORIGIN}/login`, { method: 'POST', body: form }));

      const body = await request.parseBody();
      const avatar = body['avatar'] as File;

      expect(Object.keys(body)).toEqual(['username', 'avatar']);
      expect(body['username']).toBe('alice');
      expect(avatar).toBeInstanceOf(File);
      expect(avatar.name).toBe('avatar.txt');
      expect(await avatar.text()).toBe('hello');
    });

    it('should return no fields for a JSON body', async () => {
      const request = formRequest('application/json', '{"username":"alice"}');

      expect(await request.parseBody()).toEqual({});
    });

    it('should return no fields for a body without Content-Type', async () => {
      const request = new WebRequest(new Request(`${ORIGIN}/login`, { method: 'POST', body: new Uint8Array([1]) }));

      expect(await request.parseBody()).toEqual({});
    });
  });
});
