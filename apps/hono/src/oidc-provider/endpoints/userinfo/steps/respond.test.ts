import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { respondUserInfo } from './respond.js';

describe('respondUserInfo', () => {
  // RFC 6750 §5.2 / OIDC Core 1.0 §16.4: UserInfo carries personal data and is never cached.
  it('should answer the JSON body with no-store and no-cache', async () => {
    const response = respondUserInfo(contextOf(), { status: 200, body: { sub: 'alice' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.json()).toEqual({ sub: 'alice' });
  });

  it('should answer a text body with the headers of the response', async () => {
    const response = respondUserInfo(contextOf(), {
      status: 200,
      text: 'header.payload.signature',
      headers: { 'Content-Type': 'application/jwt' },
    });

    expect(response.headers.get('Content-Type')).toBe('application/jwt');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('header.payload.signature');
  });

  it('should answer an empty JSON object when there is no body', async () => {
    const response = respondUserInfo(contextOf(), { status: 500 });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({});
  });
});
