import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { respondDiscovery } from './respond.js';

describe('respondDiscovery', () => {
  // RFC 8414 §3.2: the metadata document is JSON.
  it('should answer 200 with the metadata as JSON', async () => {
    const response = respondDiscovery(contextOf(), { issuer: 'https://op.example.com' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ issuer: 'https://op.example.com' });
  });

  // RFC 9111 §5.2: cacheable for one hour, like the JWKS.
  it('should mark the document cacheable for 3600 seconds', () => {
    const response = respondDiscovery(contextOf(), { issuer: 'https://op.example.com' });

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });
});
