import { describe, expect, it } from 'vitest';
import { decideLogoutFlow } from './decision.js';

describe('decideLogoutFlow', () => {
  // RP-Initiated Logout 1.0 §2: 有効な id_token_hint が現在の OP セッションの
  // End-User のものである場合だけ確認画面を省略できる。それ以外はすべて
  // 確認画面（MUST）。
  describe('Immediate logout', () => {
    it('should skip confirmation when the verified hint sub matches the session subject', () => {
      expect(
        decideLogoutFlow({
          verifiedHint: { sub: 'user-1' },
          expectedAudience: 'client-1',
          clientIdParam: undefined,
          sessionSubject: 'user-1',
        }),
      ).toEqual({ requiresConfirmation: false, verifiedClientId: 'client-1' });
    });

    // §2 MUST: client_id パラメータがあるときはヒントの aud と一致しなければ
    // ならない。一致する場合は即時ログアウトを妨げない。
    it('should skip confirmation when client_id matches the expected audience', () => {
      expect(
        decideLogoutFlow({
          verifiedHint: { sub: 'user-1' },
          expectedAudience: 'client-1',
          clientIdParam: 'client-1',
          sessionSubject: 'user-1',
        }),
      ).toEqual({ requiresConfirmation: false, verifiedClientId: 'client-1' });
    });
  });

  describe('Confirmation required', () => {
    it('should require confirmation when the hint is absent or invalid', () => {
      expect(
        decideLogoutFlow({
          verifiedHint: null,
          expectedAudience: null,
          clientIdParam: undefined,
          sessionSubject: 'user-1',
        }),
      ).toEqual({ requiresConfirmation: true, verifiedClientId: null });
    });

    // client_id パラメータとヒント aud の不一致（§2 MUST 違反）はヒント全体を
    // 無効として扱い、リダイレクト権限も与えない。
    it('should require confirmation and drop the client when client_id mismatches the audience', () => {
      expect(
        decideLogoutFlow({
          verifiedHint: { sub: 'user-1' },
          expectedAudience: 'client-1',
          clientIdParam: 'client-2',
          sessionSubject: 'user-1',
        }),
      ).toEqual({ requiresConfirmation: true, verifiedClientId: null });
    });

    it('should require confirmation when there is no session', () => {
      expect(
        decideLogoutFlow({
          verifiedHint: { sub: 'user-1' },
          expectedAudience: 'client-1',
          clientIdParam: undefined,
          sessionSubject: null,
        }),
      ).toEqual({ requiresConfirmation: true, verifiedClientId: 'client-1' });
    });

    it('should require confirmation when the hint sub differs from the session subject', () => {
      expect(
        decideLogoutFlow({
          verifiedHint: { sub: 'user-2' },
          expectedAudience: 'client-1',
          clientIdParam: undefined,
          sessionSubject: 'user-1',
        }),
      ).toEqual({ requiresConfirmation: true, verifiedClientId: 'client-1' });
    });

    // 確認画面を経由しても、有効なヒントの RP には §3 のリダイレクト権限が残る
    // （リダイレクト条件は確認画面の経由有無ではない。仕様書 U1 の確定）。
    it('should keep verifiedClientId on the confirmation path when the hint is valid', () => {
      const decision = decideLogoutFlow({
        verifiedHint: { sub: 'user-1' },
        expectedAudience: 'client-1',
        clientIdParam: undefined,
        sessionSubject: null,
      });
      expect(decision.verifiedClientId).toBe('client-1');
    });

    // expectedAudience が特定できなかった場合、ヒントの検証は成立し得ないため
    // verifiedHint があっても信頼しない（防御的な整合性チェック）。
    it('should treat a missing expected audience as an invalid hint', () => {
      expect(
        decideLogoutFlow({
          verifiedHint: { sub: 'user-1' },
          expectedAudience: null,
          clientIdParam: undefined,
          sessionSubject: 'user-1',
        }),
      ).toEqual({ requiresConfirmation: true, verifiedClientId: null });
    });
  });
});
