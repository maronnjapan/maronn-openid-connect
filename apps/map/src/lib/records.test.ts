import { describe, expect, it } from 'vitest';
import { changeWords, collectionWord, shortKey, timeWords, valueRows } from './records';

describe('collectionWord', () => {
  it('should name a collection of the memory database or of a feature in words, and one it does not know by its name', () => {
    expect([collectionWord('codes'), collectionWord('deviceCodes'), collectionWord('somethingNew')]).toEqual(['認可コード', 'デバイスコード', 'somethingNew']);
  });
});

describe('valueRows', () => {
  it('should give the fields of a record as rows, a list of words joined, a time next to the OP clock, none for a field that is undefined', () => {
    expect(valueRows({ scope: ['openid', 'profile'], used: false, expiresAt: 1300, authTime: 1000, iat: 400, claims: { sub: 'testuser' }, acr: undefined }, 1000)).toEqual([
      { name: 'scope', text: 'openid profile' },
      { name: 'used', text: 'false' },
      { name: 'expiresAt', text: '1300', time: '時計の 300 秒後' },
      { name: 'authTime', text: '1000', time: '時計と同じ' },
      { name: 'iat', text: '400', time: '時計の 600 秒前' },
      { name: 'claims', text: '{"sub":"testuser"}' },
    ]);
  });

  it('should give a value that is no object as one row named by nothing', () => {
    expect([valueRows('plain', 0), valueRows(['a', 'b'], 0)]).toEqual([[{ name: '', text: 'plain' }], [{ name: '', text: 'a b' }]]);
  });

  it('should read a time in milliseconds as one in seconds, and leave a number far from the clock as it is', () => {
    expect([timeWords(1767226200000, 1767225600), timeWords(3600, 1767225600)]).toEqual(['時計の 600 秒後', undefined]);
  });
});

describe('the words of the records', () => {
  it('should say what a request did to a record', () => {
    expect([changeWords({ change: 'added' }), changeWords({ change: 'changed', fields: ['used'] }), changeWords({ change: 'changed' }), changeWords({ change: 'removed' })]).toEqual(['を保存した', 'の used を変えた', 'を変えた', 'を消した']);
  });

  it('should shorten a long key around an ellipsis and keep a short one whole', () => {
    expect([shortKey('a'.repeat(30) + 'b'.repeat(30)), shortKey('code-1')]).toEqual([`${'a'.repeat(22)}…${'b'.repeat(8)}`, 'code-1']);
  });
});
