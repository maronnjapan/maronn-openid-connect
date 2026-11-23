import { describe, expect, it } from 'vitest';
import { keepingSetCookies, responseHeaders, setCookiesOf, wholeRequest } from '../op.js';

/** Run with the Request and the Response of the global scope dropping the headers a page may not set or read (Cookie, Origin; Set-Cookie), as a browser's do, and give them back after. */
async function asInAPage<T>(run: () => Promise<T>): Promise<T> {
  const { Request: BaseRequest, Response: BaseResponse } = globalThis;
  /** A Request without Cookie and Origin. */
  class PageRequest extends BaseRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, { ...init, headers: [...new Headers(init?.headers)].filter(([name]) => name !== 'cookie' && name !== 'origin') });
    }
  }
  /** A Response without Set-Cookie. */
  class PageResponse extends BaseResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, { ...init, headers: [...new Headers(init?.headers)].filter(([name]) => name !== 'set-cookie') });
    }
  }
  globalThis.Request = PageRequest as typeof Request;
  globalThis.Response = PageResponse as typeof Response;
  try {
    return await run();
  } finally {
    globalThis.Request = BaseRequest;
    globalThis.Response = BaseResponse;
  }
}

describe('wholeRequest', () => {
  it('should give the OP every header of a request, the Cookie and the Origin a page drops included', async () => {
    const request = await asInAPage(async () => wholeRequest('https://op.example.com/login', { method: 'POST', headers: [['cookie', 'session_id=s1'], ['origin', 'https://op.example.com'], ['content-type', 'application/x-www-form-urlencoded']], body: 'a=1' }));

    expect([request.headers.get('cookie'), request.headers.get('origin'), request.headers.get('content-type')]).toEqual(['session_id=s1', 'https://op.example.com', 'application/x-www-form-urlencoded']);
    expect(await request.text()).toBe('a=1');
  });
});

describe('keepingSetCookies', () => {
  it('should keep the cookies a response is made with, which a page drops from its headers', async () => {
    const response = await asInAPage(() => keepingSetCookies(async () => new Response(null, { status: 302, headers: [['location', '/login'], ['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2']] })));

    expect(response.headers.getSetCookie()).toEqual([]);
    expect(setCookiesOf(response)).toEqual(['a=1; Path=/', 'b=2']);
    expect(responseHeaders(response)).toEqual([['location', '/login'], ['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2']]);
  });

  it('should give the Response of the global scope back after the run, and after a run that throws', async () => {
    const restored = await asInAPage(async () => {
      const page = globalThis.Response;
      await keepingSetCookies(async () => undefined);
      const afterRun = globalThis.Response === page;
      await keepingSetCookies(async () => {
        throw new Error('the OP threw');
      }).catch(() => undefined);
      return [afterRun, globalThis.Response === page];
    });

    expect(restored).toEqual([true, true]);
  });

  it('should read the cookies of a response whose headers keep them, as in Node', () => {
    const response = new Response(null, { headers: [['set-cookie', 'a=1']] });

    expect(setCookiesOf(response)).toEqual(['a=1']);
    expect(responseHeaders(response)).toEqual([['set-cookie', 'a=1']]);
  });
});
