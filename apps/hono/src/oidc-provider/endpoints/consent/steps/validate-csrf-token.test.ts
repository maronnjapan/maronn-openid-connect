import { describe, expect, it } from 'vitest';
import { CSRF_TOKEN, sampleTransaction } from '../../../../test-support/screens.js';
import { validateConsentCsrfToken } from './validate-csrf-token.js';

describe('validateConsentCsrfToken', () => {
  it('should accept the csrf_token of the transaction', () => {
    expect(validateConsentCsrfToken(sampleTransaction(), CSRF_TOKEN)).toBeUndefined();
  });

  it('should refuse another csrf_token with 403', () => {
    expect(validateConsentCsrfToken(sampleTransaction(), 'csrf-of-another-transaction')).toEqual({
      kind: 'error',
      error: 'Invalid CSRF token.',
      statusCode: 403,
    });
  });

  it('should refuse an empty csrf_token with 403', () => {
    expect(validateConsentCsrfToken(sampleTransaction(), '')).toEqual({
      kind: 'error',
      error: 'Invalid CSRF token.',
      statusCode: 403,
    });
  });
});
