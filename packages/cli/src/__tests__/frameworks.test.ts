import { describe, it, expect } from 'vitest';
import { getAvailableFrameworks } from '../generator.js';

describe('getAvailableFrameworks', () => {
  it('should list supported frameworks in registration order', () => {
    expect(getAvailableFrameworks()).toEqual(['hono', 'express', 'fastify', 'nextjs']);
  });
});
