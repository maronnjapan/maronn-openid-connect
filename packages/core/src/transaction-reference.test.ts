import { describe, expect, it } from 'vitest';
import {
  AuthTransactionErrorCode,
  buildTransactionPath,
  getTransactionIdFromUrl,
  validateTransactionId,
} from './auth-transaction.js';

describe('validateTransactionId', () => {
  it('should accept matching cookie, URL and hidden transaction IDs', () => {
    expect(() => validateTransactionId('txn-1', ['txn-1', 'txn-1'])).not.toThrow();
  });

  it.each([
    [undefined, ['txn-1', 'txn-1']],
    ['', ['', '']],
    ['txn-1', []],
    ['txn-1', [undefined, 'txn-1']],
    ['txn-1', ['', 'txn-1']],
    ['txn-1', ['txn-2', 'txn-1']],
    ['txn-1', ['txn-1', 'txn-2']],
    ['txn-1', ['txn-1', null]],
    ['txn-1', ['txn-1', ['txn-1', 'txn-1']]],
  ] as const)('should reject missing, ambiguous or mismatched transaction references (%s, %j)', (cookie, references) => {
    expect(() => validateTransactionId(cookie, references)).toThrowError(
      expect.objectContaining({ code: AuthTransactionErrorCode.InvalidTransactionBinding }),
    );
  });
});

describe('getTransactionIdFromUrl', () => {
  it('should read a single transaction ID from the query', () => {
    expect(getTransactionIdFromUrl('https://op.example/login?transaction_id=txn-1')).toBe('txn-1');
  });

  it.each(['', '?transaction_id=', '?transaction_id=txn-1&transaction_id=txn-1'])('should reject a missing or ambiguous query (%s)', (query) => {
    expect(getTransactionIdFromUrl('https://op.example/login' + query)).toBeUndefined();
  });
});

describe('buildTransactionPath', () => {
  it('should encode the transaction ID in the destination query', () => {
    expect(buildTransactionPath('/login', 'txn/1')).toBe('/login?transaction_id=txn%2F1');
  });
});
