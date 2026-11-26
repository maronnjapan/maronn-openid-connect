import { describe, expect, it } from 'vitest';
import { decodeValue, encodeValue } from '../codec.js';

/** A value through JSON as a workspace keeps it: encoded, written as JSON, read and decoded. */
function roundTrip(value: unknown): unknown {
  return decodeValue(JSON.parse(JSON.stringify(encodeValue(value))));
}

describe('encodeValue and decodeValue', () => {
  it('should give back the Maps, Sets and Dates of the database as they were', () => {
    const consents = new Map([['testuser', new Map([['client-1', new Set(['openid', 'profile'])]])]]);
    const record = { expiresAt: new Date(1_700_000_000_000), scopes: ['openid'], used: false, nested: { at: new Date(0) } };
    const decoded = roundTrip({ consents, codes: new Map([['code-1', record]]) }) as { consents: typeof consents; codes: Map<string, typeof record> };
    expect(decoded.consents).toEqual(consents);
    expect(decoded.consents.get('testuser')?.get('client-1')).toBeInstanceOf(Set);
    expect(decoded.codes.get('code-1')).toEqual(record);
    expect(decoded.codes.get('code-1')?.expiresAt).toBeInstanceOf(Date);
  });

  it('should give back JSON a client sent whose members are named as the codec\'s tags', () => {
    // The claims request parameter of OIDC Core 1.0 §5.5 is the client's JSON, kept in a transaction as it was sent.
    const claims = { userinfo: { email: { $set: ['x'] }, $map: [['a', 1]] }, id_token: { $date: 0 }, $object: [['k', 'v']], plain: { $: true, other: 1 } };
    const transaction = new Map([['t1', { value: { claims }, expiresAt: 1 }]]);
    const decoded = roundTrip(transaction) as typeof transaction;
    expect(decoded).toEqual(transaction);
    expect(decoded.get('t1')?.value.claims.userinfo.email.$set).toEqual(['x']);
    expect(decoded.get('t1')?.value.claims.id_token).toEqual({ $date: 0 });
  });

  it('should leave the members that are undefined out, as JSON does', () => {
    expect(roundTrip({ kept: 1, dropped: undefined, $tagged: undefined })).toEqual({ kept: 1 });
  });
});
