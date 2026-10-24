import { describe, expect, it } from 'vitest';
import { errorPage, htmlResponse } from './html';

describe('htmlResponse', () => {
  it('should answer 200 text/html with the HTML and the cookies', async () => {
    const response = htmlResponse('<p>hello</p>', { cookies: ['a=1; Path=/', 'b=2; Path=/'] });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(await response.text()).toBe('<p>hello</p>');
  });

  // RFC 9111 §5.2.2.5: every screen is rendered for the cookie of this browser
  // at a URL that names nothing, so no cache may store it.
  it('should forbid the browser and any intermediary from storing the page', () => {
    expect(htmlResponse('<p>hello</p>').headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('errorPage', () => {
  it('should answer statusCode with the escaped error and description, and forbid storing it', async () => {
    const response = errorPage('Too many login attempts', 429, '<b>wait</b>');

    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('<p>Too many login attempts</p>');
    expect(html).toContain('<p>&lt;b&gt;wait&lt;/b&gt;</p>');
  });
});
