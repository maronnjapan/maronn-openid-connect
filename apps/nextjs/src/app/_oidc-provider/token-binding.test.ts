import { describe, expect, it } from 'vitest';
import {
  accessTokenClaimsOf,
  accessTokenRecordOf,
  refreshTokenRecordOf,
  tokenTypeOf,
  type TokenBinding,
} from './token-binding';

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

  // RFC 9449 §5: only a public client's refresh token is bound; a confidential client's stays unbound.
  it('should leave the refresh token unbound when the binding does not bind it', () => {
    expect(refreshTokenRecordOf({ cnf: { jkt: 'jkt-1' }, tokenType: 'DPoP' })).toEqual({});
  });
});
