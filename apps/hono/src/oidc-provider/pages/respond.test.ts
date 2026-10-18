import { describe, expect, it } from 'vitest';
import { redirectWithCookies, withCookies } from './respond.js';

describe('withCookies', () => {
  it('should return the response itself when there is no cookie to attach', () => {
    const response = new Response('body', { status: 200 });

    expect(withCookies(response, [])).toBe(response);
  });

  it('should attach every cookie and keep the status, the headers and the body', async () => {
    const response = new Response('<p>hello</p>', {
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });

    const withSetCookie = withCookies(response, ['a=1; Path=/', 'b=2; Path=/']);

    expect(withSetCookie.status).toBe(201);
    expect(withSetCookie.statusText).toBe('Created');
    expect(withSetCookie.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    expect(withSetCookie.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(await withSetCookie.text()).toBe('<p>hello</p>');
  });
});

describe('redirectWithCookies', () => {
  it('should answer 302 with the Location and every cookie', () => {
    const response = redirectWithCookies('https://op.example.com/consent', ['session_id=abc; Path=/']);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://op.example.com/consent');
    expect(response.headers.getSetCookie()).toEqual(['session_id=abc; Path=/']);
  });

  it('should answer with the given status and no Set-Cookie when there are no cookies', () => {
    const response = redirectWithCookies('https://rp.example.com/logged-out', [], 303);

    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://rp.example.com/logged-out');
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
