import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { respondIntrospection } from './respond.js';

describe('respondIntrospection', () => {
  // RFC 7662 §2.2: the answer is never cached.
  it('should answer the JSON body with no-store and no-cache headers', async () => {
    const response = respondIntrospection(contextOf(), { status: 200, body: { active: false } });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ active: false });
  });

  // RFC 9701 §5: a signed JWT is answered as is, under its own media type.
  it('should answer a text body with the headers of the response', async () => {
    const response = respondIntrospection(contextOf(), {
      status: 200,
      text: 'header.payload.signature',
      headers: { 'Content-Type': 'application/token-introspection+jwt' },
    });

    expect(response.headers.get('Content-Type')).toBe('application/token-introspection+jwt');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('header.payload.signature');
  });

  it('should answer an empty JSON object when the response has no body', async () => {
    const response = respondIntrospection(contextOf(), { status: 500 });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({});
  });
});
