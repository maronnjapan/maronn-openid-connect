import { AuthTransactionError, AuthTransactionErrorCode } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { transactionErrorOutcome } from './screen.js';

describe('transactionErrorOutcome', () => {
  it('should show a transaction that cannot be found on the error page with 400', () => {
    const error = new AuthTransactionError(AuthTransactionErrorCode.TransactionNotFound, 'Auth transaction not found.');

    expect(transactionErrorOutcome(error)).toEqual({
      kind: 'error',
      error: 'Auth transaction not found.',
      statusCode: 400,
    });
  });

  it('should show a csrf_token of another transaction on the error page with 403', () => {
    const error = new AuthTransactionError(AuthTransactionErrorCode.InvalidCsrfToken, 'Invalid CSRF token.');

    expect(transactionErrorOutcome(error)).toEqual({ kind: 'error', error: 'Invalid CSRF token.', statusCode: 403 });
  });

  it('should rethrow an error that is not a transaction error', () => {
    expect(() => transactionErrorOutcome(new TypeError('unexpected'))).toThrow(TypeError);
  });
});
