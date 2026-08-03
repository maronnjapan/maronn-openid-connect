import { describe, expect, it } from 'vitest';
import { isLoopbackHostname } from './loopback.js';

describe('isLoopbackHostname', () => {
  it('should accept localhost, IPv4 127/8, and IPv6 loopback hosts', () => {
    expect([
      isLoopbackHostname('localhost'),
      isLoopbackHostname('127.0.0.1'),
      isLoopbackHostname('127.0.0.2'),
      isLoopbackHostname('[::1]'),
    ]).toEqual([true, true, true, true]);
  });

  it('should reject DNS names that only start with 127', () => {
    expect(isLoopbackHostname('127.example.com')).toBe(false);
  });
});
