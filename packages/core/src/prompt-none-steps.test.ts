/**
 * prompt=none（OIDC Core 1.0 §3.1.2.1）のサイレント認証を構成する
 * 機能単位ステップ関数のテスト。
 *
 * checkPromptNone はこれらのステップ関数の合成であり、CLI 生成コードは各ステップを
 * 個別に呼び出して、利用者が検証処理を消したり足したりできるようにする。
 * 合成後の網羅的な振る舞いは auth-transaction.test.ts が担保し、本ファイルは
 * 各ステップ関数の入出力契約（成功値と代表的なエラー）を固定する。
 */
import { describe, it, expect } from 'vitest';
import {
  createAuthTransaction,
  resolvePromptNoneSession,
  validatePromptNoneConsent,
  validatePromptNoneIdTokenHint,
} from './auth-transaction.js';
import type {
  AuthTransaction,
  ConsentResolver,
  SessionInfo,
  SessionResolver,
} from './auth-transaction.js';
import { AuthorizationError, AuthorizationErrorCode } from './authorization-request.js';
import type { ValidatedAuthorizationRequest } from './authorization-request.js';

const REQUEST = new Request('https://op.example.com/authorize');

const defaultSession: SessionInfo = { subject: 'user-1', authTime: 1_700_000_000 };

function createTransaction(overrides?: Partial<AuthTransaction>): AuthTransaction {
  const validated = {
    clientId: 'client-1',
    redirectUri: 'https://client.example.com/cb',
    responseType: 'code',
    scope: ['openid', 'profile'],
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    state: 'state-1',
  } as ValidatedAuthorizationRequest;
  return { ...createAuthTransaction(validated, 'csrf-token'), ...overrides };
}

function createSessionResolver(session: SessionInfo | null): SessionResolver {
  return { resolve: async () => session };
}

function createConsentResolver(hasConsent: boolean): ConsentResolver {
  return { hasConsent: async () => hasConsent };
}

/** 同期ステップが投げた AuthorizationError を取り出す（投げなければ undefined） */
function captureError(fn: () => unknown): AuthorizationError | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as AuthorizationError;
  }
}

/** 非同期ステップが投げた AuthorizationError を取り出す（投げなければ undefined） */
async function captureAsyncError(
  fn: () => Promise<unknown>,
): Promise<AuthorizationError | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as AuthorizationError;
  }
}

describe('resolvePromptNoneSession', () => {
  it('should return the active session', async () => {
    const result = await resolvePromptNoneSession(
      createTransaction(),
      createSessionResolver(defaultSession),
      REQUEST,
    );

    expect(result).toEqual(defaultSession);
  });

  it('should reject a missing session with login_required', async () => {
    const error = await captureAsyncError(() =>
      resolvePromptNoneSession(createTransaction(), createSessionResolver(null), REQUEST),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.LoginRequired);
  });

  it('should carry the redirect_uri and state of the transaction on the error', async () => {
    const error = await captureAsyncError(() =>
      resolvePromptNoneSession(createTransaction(), createSessionResolver(null), REQUEST),
    );

    expect(error?.redirectUri).toBe('https://client.example.com/cb');
    expect(error?.state).toBe('state-1');
  });
});

describe('validatePromptNoneIdTokenHint', () => {
  it('should accept a session whose subject matches the verified hint subject', () => {
    const error = captureError(() =>
      validatePromptNoneIdTokenHint(createTransaction(), defaultSession, 'user-1'),
    );

    expect(error).toBeUndefined();
  });

  it('should skip the check when no verified hint subject is given', () => {
    const error = captureError(() =>
      validatePromptNoneIdTokenHint(createTransaction(), defaultSession, undefined),
    );

    expect(error).toBeUndefined();
  });

  it('should reject a session whose subject differs from the hint with login_required', () => {
    const error = captureError(() =>
      validatePromptNoneIdTokenHint(createTransaction(), defaultSession, 'other-user'),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.LoginRequired);
    expect(error?.errorDescription).toBe(
      'id_token_hint subject does not match the active session.',
    );
  });
});

describe('validatePromptNoneConsent', () => {
  it('should accept a subject that already consented to the requested scopes', async () => {
    const error = await captureAsyncError(() =>
      validatePromptNoneConsent(createTransaction(), defaultSession, createConsentResolver(true)),
    );

    expect(error).toBeUndefined();
  });

  it('should skip the check when no consent resolver is given', async () => {
    const error = await captureAsyncError(() =>
      validatePromptNoneConsent(createTransaction(), defaultSession, undefined),
    );

    expect(error).toBeUndefined();
  });

  it('should reject a subject without consent with consent_required', async () => {
    const error = await captureAsyncError(() =>
      validatePromptNoneConsent(createTransaction(), defaultSession, createConsentResolver(false)),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error?.error).toBe(AuthorizationErrorCode.ConsentRequired);
    expect(error?.errorDescription).toBe(
      'Consent has not been granted. Silent authentication cannot show consent UI.',
    );
  });

  it('should ask the consent resolver for the transaction subject, client and scopes', async () => {
    const asked: { subject: string; clientId: string; scopes: string[] }[] = [];
    const consentResolver: ConsentResolver = {
      hasConsent: async (subject, clientId, scopes) => {
        asked.push({ subject, clientId, scopes });
        return true;
      },
    };

    await validatePromptNoneConsent(createTransaction(), defaultSession, consentResolver);

    expect(asked).toEqual([
      { subject: 'user-1', clientId: 'client-1', scopes: ['openid', 'profile'] },
    ]);
  });
});
