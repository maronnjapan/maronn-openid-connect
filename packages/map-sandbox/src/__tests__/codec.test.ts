import { describe, expect, it } from 'vitest';
import { decodeValue, encodeValue } from '../codec.js';

describe('encodeValue and decodeValue', () => {
  it('should write Maps and Sets as tagged JSON and make them again, member by member', () => {
    const value = { consentScopes: new Map([['testuser', new Map([['client-1', new Set(['openid', 'offline_access'])]])]]), codes: new Map([['code-1', { used: false, scope: ['openid'] }]]) };
    const encoded = JSON.parse(JSON.stringify(encodeValue(value))) as unknown;

    expect(encoded).toEqual({ consentScopes: { $map: [['testuser', { $map: [['client-1', { $set: ['openid', 'offline_access'] }]] }]] }, codes: { $map: [['code-1', { used: false, scope: ['openid'] }]] } });
    expect(decodeValue(encoded)).toEqual(value);
  });

  it('should leave out the members of an object that are undefined, as JSON does', () => {
    expect(encodeValue({ nonce: undefined, used: true })).toEqual({ used: true });
  });
});
