import { describe, expect, it } from 'vitest';
import { JARM_SUPPORTED_RESPONSE_MODES, resolveJarmResponseMode } from './response-mode.js';

describe('resolveJarmResponseMode', () => {
  // JARM §2.3.1 / §2.3.4: query.jwt is the only mode this OP implements, and the
  // shorthand `jwt` resolves to it for response_type=code.
  describe('JARM modes', () => {
    it('should resolve response_mode=query.jwt to the query.jwt JARM mode', () => {
      expect(resolveJarmResponseMode({ response_mode: 'query.jwt' })).toEqual({
        kind: 'jarm',
        mode: 'query.jwt',
      });
    });

    it('should resolve the shorthand response_mode=jwt to the query.jwt JARM mode', () => {
      expect(resolveJarmResponseMode({ response_mode: 'jwt' })).toEqual({
        kind: 'jarm',
        mode: 'query.jwt',
      });
    });
  });

  // The generated OP does not interpret response_mode at all today. JARM only
  // adds meaning to the `.jwt` family; every other value keeps the current
  // (ignore it) behavior so enabling the feature changes nothing else.
  describe('Plain (unchanged) modes', () => {
    it('should resolve an absent response_mode to plain', () => {
      expect(resolveJarmResponseMode({})).toEqual({ kind: 'plain' });
    });

    it('should resolve an explicitly undefined response_mode to plain', () => {
      expect(resolveJarmResponseMode({ response_mode: undefined })).toEqual({ kind: 'plain' });
    });

    it('should resolve response_mode=query to plain', () => {
      expect(resolveJarmResponseMode({ response_mode: 'query' })).toEqual({ kind: 'plain' });
    });

    it('should resolve response_mode=form_post to plain', () => {
      expect(resolveJarmResponseMode({ response_mode: 'form_post' })).toEqual({ kind: 'plain' });
    });

    it('should resolve response_mode=fragment to plain', () => {
      expect(resolveJarmResponseMode({ response_mode: 'fragment' })).toEqual({ kind: 'plain' });
    });

    // フレームワークのクエリパーサが文字列以外（配列など）を返す場合でも、
    // JARM モードとして解釈しない。
    it('should resolve a non-string response_mode to plain', () => {
      expect(resolveJarmResponseMode({ response_mode: 42 } as object)).toEqual({ kind: 'plain' });
    });

    it('should resolve an empty response_mode to plain', () => {
      expect(resolveJarmResponseMode({ response_mode: '' })).toEqual({ kind: 'plain' });
    });

    // response_mode values are case-sensitive (OAuth 2.0 Multiple Response Type
    // Encoding Practices §2.1), so QUERY.JWT is not the JARM mode.
    it('should resolve an uppercase QUERY.JWT to plain', () => {
      expect(resolveJarmResponseMode({ response_mode: 'QUERY.JWT' })).toEqual({ kind: 'plain' });
    });
  });

  // JARM §2.3.2 / §2.3.3: fragment.jwt and form_post.jwt exist in the spec but
  // are non-goals here, so they are reported to the caller which turns them into
  // a redirectable invalid_request.
  describe('Unsupported JWT modes', () => {
    it('should report fragment.jwt as an unsupported JWT mode', () => {
      expect(resolveJarmResponseMode({ response_mode: 'fragment.jwt' })).toEqual({
        kind: 'unsupported-jwt-mode',
        requested: 'fragment.jwt',
      });
    });

    it('should report form_post.jwt as an unsupported JWT mode', () => {
      expect(resolveJarmResponseMode({ response_mode: 'form_post.jwt' })).toEqual({
        kind: 'unsupported-jwt-mode',
        requested: 'form_post.jwt',
      });
    });

    it('should report an unknown .jwt value as an unsupported JWT mode', () => {
      expect(resolveJarmResponseMode({ response_mode: 'foo.jwt' })).toEqual({
        kind: 'unsupported-jwt-mode',
        requested: 'foo.jwt',
      });
    });

    it('should report a bare .jwt value as an unsupported JWT mode', () => {
      expect(resolveJarmResponseMode({ response_mode: '.jwt' })).toEqual({
        kind: 'unsupported-jwt-mode',
        requested: '.jwt',
      });
    });
  });
});

describe('JARM_SUPPORTED_RESPONSE_MODES', () => {
  it('should list exactly the request values that select JARM', () => {
    expect(JARM_SUPPORTED_RESPONSE_MODES).toEqual(['query.jwt', 'jwt']);
  });
});
