import { describe, expect, it } from 'vitest';
import { resolvePostLogoutRedirect } from './redirect.js';

describe('resolvePostLogoutRedirect', () => {
  // RP-Initiated Logout 1.0 §3: post_logout_redirect_uri は事前登録値と一致した
  // 場合のみ使用し（MUST NOT の裏返し）、state はそのままクエリで返す。
  describe('Exact match redirect', () => {
    it('should return the registered URI with state appended', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout',
          state: 'af0ifjsldkj',
          verifiedClientId: 'client-1',
          registeredUris: ['https://rp.example/loggedout'],
        }),
      ).toBe('https://rp.example/loggedout?state=af0ifjsldkj');
    });

    it('should return the URI unchanged when state is absent', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout',
          state: undefined,
          verifiedClientId: 'client-1',
          registeredUris: ['https://rp.example/loggedout'],
        }),
      ).toBe('https://rp.example/loggedout');
    });

    // 登録 URI が既にクエリを持つ場合も URL API で state を追記し、既存クエリを保持する。
    it('should append state while preserving an existing query string', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout?from=op',
          state: 'xyz',
          verifiedClientId: 'client-1',
          registeredUris: ['https://rp.example/loggedout?from=op'],
        }),
      ).toBe('https://rp.example/loggedout?from=op&state=xyz');
    });

    // state は URL API のクエリ付加でのみ出力する（URL エンコードを通す。反射対策）。
    it('should URL-encode the state value', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout',
          state: 'a b&c=d',
          verifiedClientId: 'client-1',
          registeredUris: ['https://rp.example/loggedout'],
        }),
      ).toBe('https://rp.example/loggedout?state=a+b%26c%3Dd');
    });
  });

  describe('Fail-closed cases', () => {
    // 完全一致は文字列比較。正規化・前方一致・クエリ無視をしない（§3 MUST NOT）。
    it('should return null for a partial or prefix match', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout/extra',
          state: undefined,
          verifiedClientId: 'client-1',
          registeredUris: ['https://rp.example/loggedout'],
        }),
      ).toBe(null);
    });

    it('should return null for a trailing-slash difference', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout/',
          state: undefined,
          verifiedClientId: 'client-1',
          registeredUris: ['https://rp.example/loggedout'],
        }),
      ).toBe(null);
    });

    it('should return null for a query-string difference', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout?x=1',
          state: undefined,
          verifiedClientId: 'client-1',
          registeredUris: ['https://rp.example/loggedout'],
        }),
      ).toBe(null);
    });

    // §3: RP を特定・検証できない場合はリダイレクトしない。
    it('should return null when the client is not verified', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout',
          state: 'xyz',
          verifiedClientId: null,
          registeredUris: ['https://rp.example/loggedout'],
        }),
      ).toBe(null);
    });

    it('should return null when post_logout_redirect_uri is absent', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: undefined,
          state: 'xyz',
          verifiedClientId: 'client-1',
          registeredUris: ['https://rp.example/loggedout'],
        }),
      ).toBe(null);
    });

    it('should return null when the registered URI list is empty', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: 'https://rp.example/loggedout',
          state: 'xyz',
          verifiedClientId: 'client-1',
          registeredUris: [],
        }),
      ).toBe(null);
    });

    // 登録簿に相対 URI などの不正値が紛れても、URL として組み立てられない一致は
    // リダイレクトに使わない（fail-closed）。
    it('should return null when the matched value is not an absolute URL', () => {
      expect(
        resolvePostLogoutRedirect({
          postLogoutRedirectUri: '/relative/path',
          state: 'xyz',
          verifiedClientId: 'client-1',
          registeredUris: ['/relative/path'],
        }),
      ).toBe(null);
    });
  });
});
