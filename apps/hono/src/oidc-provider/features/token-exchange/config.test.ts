import { describe, expect, it } from 'vitest';
import { tokenExchangeConfig } from './config.js';

describe('tokenExchangeConfig', () => {
  // Fail safe: an exchange that names an audience or resource is refused until the targets are listed.
  it('should allow no audience or resource target by default', () => {
    expect(tokenExchangeConfig).toEqual({ allowedTargets: [] });
  });
});
