import { describe, expect, it } from 'vitest';
import {
  accessTokenClaimsOf,
  accessTokenRecordOf,
  confirmationOf,
  confirmationRecordOf,
  refreshTokenRecordOf,
  tokenTypeOf,
  withTokenBinding,
  type TokenBinding,
} from './token-binding.js';

const BINDING: TokenBinding = { cnf: { jkt: 'jkt-1' }, tokenType: 'DPoP', refreshTokenCnf: { jkt: 'jkt-1' } };

describe('token binding', () => {
  it('should answer Bearer and add nothing for a token that is not bound', () => {
    expect([tokenTypeOf(undefined), accessTokenClaimsOf(undefined), accessTokenRecordOf(undefined), refreshTokenRecordOf(undefined)]).toEqual([
      'Bearer',
      {},
      {},
      {},
    ]);
  });

  // RFC 9449 §5 / §6.1 / §6.2: the token_type, the cnf claim and the stored record of a bound token.
  it('should give the token_type, the cnf claim and the record members of a bound token', () => {
    expect([tokenTypeOf(BINDING), accessTokenClaimsOf(BINDING), accessTokenRecordOf(BINDING), refreshTokenRecordOf(BINDING)]).toEqual([
      'DPoP',
      { cnf: { jkt: 'jkt-1' } },
      { cnf: { jkt: 'jkt-1' }, tokenType: 'DPoP' },
      { cnf: { jkt: 'jkt-1' } },
    ]);
  });

  it('should leave the refresh token unbound when the binding does not bind it', () => {
    expect(refreshTokenRecordOf({ cnf: { jkt: 'jkt-1' }, tokenType: 'DPoP' })).toEqual({});
  });

  it.each([
    ['a record with cnf', { cnf: { jkt: 'jkt-1' } }, { jkt: 'jkt-1' }],
    ['a record without cnf', { sub: 'user-1' }, undefined],
    ['a cnf that is not an object', { cnf: 'jkt-1' }, undefined],
    ['a cnf that is an array', { cnf: ['jkt-1'] }, undefined],
    ['undefined', undefined, undefined],
  ])('should read the confirmation of %s', (_name, record, expected) => {
    expect([confirmationOf(record), confirmationRecordOf(record)]).toEqual([expected, expected === undefined ? {} : { cnf: expected }]);
  });

  // RFC 9449 §6.2: introspection reports the cnf and the token_type of a bound access token.
  it('should add the cnf and the token_type of a bound record to an active introspection response', () => {
    const active = { active: true as const, client_id: 'client-1', token_type: 'Bearer' as const };

    expect([
      withTokenBinding(active, { cnf: { jkt: 'jkt-1' }, tokenType: 'DPoP' }),
      withTokenBinding(active, { sub: 'user-1' }),
      withTokenBinding({ active: false }, { cnf: { jkt: 'jkt-1' }, tokenType: 'DPoP' }),
    ]).toEqual([{ ...active, token_type: 'DPoP', cnf: { jkt: 'jkt-1' } }, active, { active: false }]);
  });
});
