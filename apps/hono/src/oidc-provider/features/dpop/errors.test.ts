import { describe, expect, it } from 'vitest';

import { DpopError, isDpopError } from './errors.js';

describe('DpopError', () => {
  it('should carry the error code and the description of the failure', () => {
    const error = new DpopError('invalid_dpop_proof', 'The DPoP proof is not a JWT');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DpopError');
    expect(error.error).toBe('invalid_dpop_proof');
    expect(error.errorDescription).toBe('The DPoP proof is not a JWT');
    expect(error.message).toBe('The DPoP proof is not a JWT');
  });
});

describe('isDpopError', () => {
  it('should recognise a DpopError', () => {
    expect(isDpopError(new DpopError('invalid_dpop_proof', 'The DPoP proof is not a JWT'))).toBe(true);
  });

  // A DpopError of a second copy of the module (another bundle) is not an
  // instance of this class, but has its shape.
  it('should recognise a value of the shape of a DpopError', () => {
    expect(isDpopError({ name: 'DpopError', error: 'invalid_dpop_proof', errorDescription: 'The DPoP proof is not a JWT' })).toBe(true);
  });

  // RFC 9449 §5 / §10: a code or refresh token bound to another key than the proof is an invalid grant.
  it('should recognise the invalid_grant of a grant bound to a DPoP key', () => {
    expect([
      isDpopError(new DpopError('invalid_grant', 'The grant is bound to a DPoP key, but no DPoP proof was sent')),
      isDpopError({ name: 'DpopError', error: 'invalid_grant', errorDescription: 'The grant is bound to a DPoP key, but no DPoP proof was sent' }),
    ]).toEqual([true, true]);
  });

  // RFC 9449 §7.1 / §7.2, RFC 6750 §3.1: the failures of a protected resource.
  it.each([
    ['invalid_token', 'A DPoP-bound access token must be presented with the DPoP scheme'],
    ['invalid_request', 'The DPoP authorization header has no access token'],
  ])('should recognise the %s of a protected resource', (error, errorDescription) => {
    expect([
      isDpopError(new DpopError(error as 'invalid_token' | 'invalid_request', errorDescription)),
      isDpopError({ name: 'DpopError', error, errorDescription }),
    ]).toEqual([true, true]);
  });

  it.each([
    ['an Error of another name', Object.assign(new Error('x'), { error: 'invalid_dpop_proof', errorDescription: 'x' })],
    ['a value without errorDescription', { name: 'DpopError', error: 'invalid_dpop_proof' }],
    ['a value whose error is not a string', { name: 'DpopError', error: 400, errorDescription: 'x' }],
    ['a value whose error is not a DPoP error code', { name: 'DpopError', error: 'server_error', errorDescription: 'x' }],
    ['null', null],
    ['a string', 'DpopError'],
  ])('should not take %s for a DpopError', (_name, value) => {
    expect(isDpopError(value)).toBe(false);
  });
});
