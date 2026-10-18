import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { respondRevocation } from './respond.js';

describe('respondRevocation', () => {
  // RFC 7009 §2.2: 200 with an empty body, whether the token was revoked or not found.
  it('should answer 200 with an empty body and no-store headers', async () => {
    const response = respondRevocation(contextOf());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(await response.text()).toBe('');
  });
});
