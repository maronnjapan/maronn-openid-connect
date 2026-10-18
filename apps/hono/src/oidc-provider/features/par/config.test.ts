import { describe, expect, it } from 'vitest';
import { parConfig } from './config.js';

describe('parConfig', () => {
  // RFC 9126 §2.2: a request_uri lifetime inside the recommended 5-600 seconds;
  // RFC 9126 §5: PAR is offered, not required.
  it('should set a request_uri lifetime of 60 seconds without requiring pushed requests', () => {
    expect(parConfig).toEqual({ expiresInSeconds: 60, requirePushedAuthorizationRequests: false });
  });
});
