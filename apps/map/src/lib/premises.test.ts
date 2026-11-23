import { describe, expect, it } from 'vitest';
import type { PremiseStep, PreparedPremises } from '@maronn-openid-connect/map-sandbox';
import { carryOver, changeWords, collectionWord, originOf, premiseRecordOf, recordsIn, shortKey, stepLine, stepNumber, timeWords, valueRows, valuesBetween } from './premises';

/** A request of the premises: its method and URL, its headers and body, the status and headers of its answer, and what it wrote. */
function step(grant: string, method: string, url: string, status: number, wrote: PremiseStep['wrote'], more: { headers?: Array<[string, string]>; body?: string; answer?: Array<[string, string]> } = {}): PremiseStep {
  return { grant, request: { method, url, headers: more.headers ?? [], ...(more.body === undefined ? {} : { body: more.body }) }, response: { status, headers: more.answer ?? [] }, wrote };
}

/** Premises of two grants: the first stores a code at its consent, the second changes the consent of the first and exchanges its own code. */
const PREMISES: PreparedPremises = {
  version: 1,
  issuer: 'https://op.example.com',
  now: 1000,
  steps: [
    step('unused', 'GET', 'https://op.example.com/authorize?client_id=client-1&scope=openid', 302, [{ collection: 'transactions', key: 'auth_txn:t1', change: 'added', value: {} }], { answer: [['location', 'https://op.example.com/login?transaction_id=t1'], ['set-cookie', '__Host-oidc_txn=t1; HttpOnly; Secure; Path=/; Max-Age=600']] }),
    step('unused', 'POST', 'https://op.example.com/consent?transaction_id=t1', 302, [
      { collection: 'codes', key: 'c1', change: 'added', value: { used: false } },
      { collection: 'consentScopes', key: 'testuser', change: 'added', value: { 'client-1': ['openid'] } },
    ], { headers: [['content-type', 'application/x-www-form-urlencoded'], ['cookie', '__Host-oidc_txn=t1; session_id=s1']], body: 'transaction_id=t1&action=approve', answer: [['location', 'https://rp.example.com/callback?code=c1'], ['set-cookie', '__Host-oidc_txn=; Path=/; Max-Age=0']] }),
    step('exchanged', 'POST', 'https://op.example.com/consent?transaction_id=t2', 302, [{ collection: 'consentScopes', key: 'testuser', change: 'changed', value: { 'client-1': ['openid', 'profile'] }, fields: ['client-1'] }]),
    step('exchanged', 'POST', 'https://op.example.com/token', 200, [], { headers: [['authorization', `Basic ${btoa('client-1:secret')}`], ['content-type', 'application/x-www-form-urlencoded']], body: 'grant_type=authorization_code&code=c2' }),
  ],
  records: [
    { collection: 'codes', key: 'c1', value: { used: false }, addedBy: 1 },
    { collection: 'consentScopes', key: 'testuser', value: { 'client-1': ['openid', 'profile'] }, addedBy: 1, changedBy: [2] },
    { collection: 'clients', key: 'client-1', value: { clientId: 'client-1' } },
  ],
  grants: [],
  database: {},
  signingKey: { keyId: 'k', privateJwk: {}, publicJwk: {} },
};

describe('collectionWord', () => {
  it('should name a collection of the memory database in words, and one it does not know by its name', () => {
    expect([collectionWord('codes'), collectionWord('refreshTokens'), collectionWord('clients'), collectionWord('parRecords')]).toEqual(['認可コード', 'リフレッシュトークン', 'クライアント', 'parRecords']);
  });
});

describe('originOf', () => {
  it('should give the requests of the grant that stored a record, up to the one that stored it', () => {
    const origin = originOf(PREMISES, premiseRecordOf(PREMISES, 'codes', 'c1')!);

    expect(origin?.grant).toBe('unused');
    expect(origin?.steps.map(({ index, did }) => [index, did])).toEqual([
      [0, undefined],
      [1, 'added'],
    ]);
  });

  it('should go on to the requests that changed the record after, of another grant too', () => {
    const origin = originOf(PREMISES, premiseRecordOf(PREMISES, 'consentScopes', 'testuser')!);

    expect(origin?.steps.map(({ index, did }) => [index, did])).toEqual([
      [0, undefined],
      [1, 'added'],
      [2, 'changed'],
    ]);
  });

  it('should give none for a record of the configuration, which no request stored', () => {
    expect(originOf(PREMISES, premiseRecordOf(PREMISES, 'clients', 'client-1')!)).toBeUndefined();
    expect(premiseRecordOf(PREMISES, 'codes', 'c9')).toBeUndefined();
  });
});

describe('stepLine', () => {
  it('should read a request of the premises as its method and path, its query, the location it was sent to next', () => {
    expect(stepLine(PREMISES.steps[0]!)).toEqual({ method: 'GET', path: '/authorize', query: [['client_id', 'client-1'], ['scope', 'openid']], form: [], cookies: [], status: 302, setCookies: [['__Host-oidc_txn', 't1']], location: 'https://op.example.com/login?transaction_id=t1' });
  });

  it('should read the fields of a form posted, the cookies sent and those the answer cleared, and the client of Basic credentials', () => {
    expect(stepLine(PREMISES.steps[1]!)).toMatchObject({ form: [['transaction_id', 't1'], ['action', 'approve']], cookies: [['__Host-oidc_txn', 't1'], ['session_id', 's1']], setCookies: [['__Host-oidc_txn', undefined]] });
    expect(stepLine(PREMISES.steps[3]!)).toMatchObject({ path: '/token', client: 'client-1', form: [['grant_type', 'authorization_code'], ['code', 'c2']] });
  });
});

describe('valueRows', () => {
  it('should give the fields of a record as rows, a list of words joined, a time next to the clock of the premises, none for a field that is undefined', () => {
    expect(valueRows({ scope: ['openid', 'profile'], used: false, expiresAt: 1300, authTime: 1000, iat: 400, claims: { sub: 'testuser' }, acr: undefined }, 1000)).toEqual([
      { name: 'scope', text: 'openid profile' },
      { name: 'used', text: 'false' },
      { name: 'expiresAt', text: '1300', time: '時計の 300 秒後' },
      { name: 'authTime', text: '1000', time: '時計と同じ' },
      { name: 'iat', text: '400', time: '時計の 600 秒前' },
      { name: 'claims', text: '{"sub":"testuser"}' },
    ]);
  });

  it('should read a time in milliseconds as one in seconds, and leave a number far from the clock as it is', () => {
    expect(timeWords(1767226200000, 1767225600)).toBe('時計の 600 秒後');
    expect(timeWords(3600, 1767225600)).toBeUndefined();
  });
});

describe('the words of the premises', () => {
  it('should say what a request did to a record', () => {
    expect([changeWords({ change: 'added' }), changeWords({ change: 'changed', fields: ['used'] }), changeWords({ change: 'changed' }), changeWords({ change: 'removed' })]).toEqual(['を保存した', 'の used を変えた', 'を変えた', 'を消した']);
  });

  it('should number the requests ① to ⑳, shorten a long key, and give the records of a collection', () => {
    expect([stepNumber(0), stepNumber(10), stepNumber(20)]).toEqual(['①', '⑪', '(21)']);
    expect(shortKey('a'.repeat(30) + 'b'.repeat(30))).toBe(`${'a'.repeat(22)}…${'b'.repeat(8)}`);
    expect(shortKey('code-1')).toBe('code-1');
    expect([recordsIn(PREMISES, 'codes').map((record) => record.key), recordsIn(undefined, 'codes')]).toEqual([['c1'], []]);
  });
});

describe('carryOver', () => {
  it('should carry a request written on premises over to premises made again: the code and the tokens of the same grant, whole in a parameter and inside a header, and leave the scope the reader wrote as written', () => {
    const before: PreparedPremises = { ...PREMISES, grants: [{ id: 'exchanged', clientId: 'client-1', redirectUri: 'https://rp.example.com/callback', code: 'c-old', codeVerifier: 'v', tokens: { access_token: 'at-old', refresh_token: 'rt-old', scope: 'openid offline_access', token_type: 'Bearer' } }] };
    const after: PreparedPremises = { ...PREMISES, grants: [{ id: 'exchanged', clientId: 'client-1', redirectUri: 'https://rp.example.com/callback', code: 'c-new', codeVerifier: 'v', tokens: { access_token: 'at-new', scope: 'openid', token_type: 'Bearer' } }] };
    const draft = { method: 'POST', path: '/token', body: 'form' as const, params: [{ name: 'code', value: 'c-old', in: 'form' as const }, { name: 'refresh_token', value: 'rt-old', in: 'form' as const }, { name: 'scope', value: 'openid offline_access', in: 'form' as const }], headers: [['authorization', 'Bearer at-old'] as [string, string]] };

    expect([...valuesBetween(before, after)]).toEqual([
      ['c-old', 'c-new'],
      ['at-old', 'at-new'],
    ]);
    expect(carryOver(draft, valuesBetween(before, after))).toEqual({ ...draft, params: [{ name: 'code', value: 'c-new', in: 'form' }, { name: 'refresh_token', value: 'rt-old', in: 'form' }, { name: 'scope', value: 'openid offline_access', in: 'form' }], headers: [['authorization', 'Bearer at-new']] });
    expect(carryOver(draft, new Map())).toBe(draft);
  });
});
