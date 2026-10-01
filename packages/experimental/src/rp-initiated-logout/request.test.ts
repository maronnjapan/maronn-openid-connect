import { describe, expect, it } from 'vitest';
import { extractIdTokenHintAudience, parseEndSessionRequest } from './request.js';

/** base64url（パディング無し）でエンコードする。テスト内でのみ使用する。 */
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** ダミー署名付きの compact JWS を組み立てる。署名検証前の抽出だけを試すため中身は問わない。 */
function buildUnsignedJws(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.c2ln`;
}

describe('parseEndSessionRequest', () => {
  // RP-Initiated Logout 1.0 §2: end_session_endpoint のリクエストパラメータ 6 種を
  // GET クエリ / POST フォームボディ共通の URLSearchParams から正規化する。
  describe('Parameter extraction', () => {
    it('should extract all six end_session parameters', () => {
      const params = new URLSearchParams({
        id_token_hint: 'hint-value',
        client_id: 'client-1',
        post_logout_redirect_uri: 'https://rp.example/loggedout',
        state: 'af0ifjsldkj',
        logout_hint: 'user@example.com',
        ui_locales: 'ja-JP ja',
      });
      expect(parseEndSessionRequest(params)).toEqual({
        idTokenHint: 'hint-value',
        clientId: 'client-1',
        postLogoutRedirectUri: 'https://rp.example/loggedout',
        state: 'af0ifjsldkj',
        logoutHint: 'user@example.com',
        uiLocales: 'ja-JP ja',
      });
    });

    it('should leave absent parameters undefined', () => {
      expect(parseEndSessionRequest(new URLSearchParams())).toEqual({
        idTokenHint: undefined,
        clientId: undefined,
        postLogoutRedirectUri: undefined,
        state: undefined,
        logoutHint: undefined,
        uiLocales: undefined,
      });
    });
  });

  describe('Duplicate and empty values', () => {
    // 重複パラメータは最初の値を採用する（仕様書の公開 API 契約）。
    it('should take the first value when a parameter is duplicated', () => {
      const params = new URLSearchParams(
        'id_token_hint=first&id_token_hint=second&state=s1&state=s2',
      );
      const parsed = parseEndSessionRequest(params);
      expect(parsed.idTokenHint).toBe('first');
      expect(parsed.state).toBe('s1');
    });

    // 空文字は値なしと同じ扱い。空の id_token_hint を「ヒントあり」と数えない。
    it('should treat an empty value as undefined', () => {
      const params = new URLSearchParams('id_token_hint=&client_id=&state=');
      expect(parseEndSessionRequest(params)).toEqual({
        idTokenHint: undefined,
        clientId: undefined,
        postLogoutRedirectUri: undefined,
        state: undefined,
        logoutHint: undefined,
        uiLocales: undefined,
      });
    });
  });
});

describe('extractIdTokenHintAudience', () => {
  // OIDC Core §2: aud は文字列または配列。配列で複数値のときは azp が必須。
  // 抽出は署名検証前の処理であり、信頼は後段の validateIdTokenHint が与える。
  describe('aud claim shapes', () => {
    it('should return the aud claim when aud is a string', () => {
      const jws = buildUnsignedJws({ aud: 'client-1', sub: 'user-1' });
      expect(extractIdTokenHintAudience(jws)).toBe('client-1');
    });

    // core の buildIdTokenAudience は追加 audience 構成時に aud 配列 + azp を発行する
    // ため、azp フォールバックは自 OP 発行トークンでも必須の経路になる。
    it('should return the azp claim when aud is an array and azp is present', () => {
      const jws = buildUnsignedJws({ aud: ['client-1', 'https://api.example'], azp: 'client-1' });
      expect(extractIdTokenHintAudience(jws)).toBe('client-1');
    });

    it('should return the sole element when aud is a one-element array without azp', () => {
      const jws = buildUnsignedJws({ aud: ['client-1'] });
      expect(extractIdTokenHintAudience(jws)).toBe('client-1');
    });

    it('should return null when aud is a multi-element array without azp', () => {
      const jws = buildUnsignedJws({ aud: ['client-1', 'client-2'] });
      expect(extractIdTokenHintAudience(jws)).toBe(null);
    });

    it('should return null when aud is missing', () => {
      const jws = buildUnsignedJws({ sub: 'user-1' });
      expect(extractIdTokenHintAudience(jws)).toBe(null);
    });

    it('should return null when aud is neither a string nor an array', () => {
      const jws = buildUnsignedJws({ aud: 42 });
      expect(extractIdTokenHintAudience(jws)).toBe(null);
    });

    it('should return null when azp is not a string and aud has multiple elements', () => {
      const jws = buildUnsignedJws({ aud: ['client-1', 'client-2'], azp: 42 });
      expect(extractIdTokenHintAudience(jws)).toBe(null);
    });
  });

  describe('Malformed input', () => {
    it('should return null for a value that is not a three-part compact JWS', () => {
      expect(extractIdTokenHintAudience('not-a-jwt')).toBe(null);
      expect(extractIdTokenHintAudience('a.b')).toBe(null);
      expect(extractIdTokenHintAudience('a.b.c.d')).toBe(null);
      expect(extractIdTokenHintAudience('')).toBe(null);
    });

    it('should return null when the payload is not valid base64url', () => {
      expect(extractIdTokenHintAudience('aGVhZGVy.!!invalid!!.c2ln')).toBe(null);
    });

    it('should return null when the payload is not valid JSON', () => {
      const jws = `${base64UrlEncode('{"alg":"RS256"}')}.${base64UrlEncode('not json')}.c2ln`;
      expect(extractIdTokenHintAudience(jws)).toBe(null);
    });

    it('should return null when the payload is a JSON array instead of an object', () => {
      const jws = `${base64UrlEncode('{"alg":"RS256"}')}.${base64UrlEncode('["client-1"]')}.c2ln`;
      expect(extractIdTokenHintAudience(jws)).toBe(null);
    });
  });
});
