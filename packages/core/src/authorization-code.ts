/**
 * 認可コード発行ヘルパー
 *
 * Authorization Endpoint（およびそのフロー）から共通利用するためのヘルパー関数。
 * core はデータ構造の生成までを担当し、ストレージへの保存は利用者責務。
 *
 * 準拠仕様:
 * - OAuth 2.1 Section 4.1.2 (Authorization Response)
 * - OIDC Core 1.0 Section 3.1.3.1: 認可コードはワンタイムで、有効期限は短くすること
 */

import { generateRandomString } from './crypto-utils.js';
import type { AuthorizationResponseParams } from './auth-transaction.js';
import type { ClaimsParameter } from './userinfo.js';

/**
 * 認可コードに紐づくデータ
 *
 * core が提供する `AuthorizationCodeInfo`（token-request.ts）は Token Endpoint で
 * 認可コードを引き当てる際の最小情報のみを表す型である。
 * `AuthorizationCodeData` はそれを包含し、authorize/consent 時の発行データを表す
 * 完全形（subject / authTime など発行時情報を含む）。
 */
export interface AuthorizationCodeData {
  code: string;
  /**
   * 認可付与の一意識別子。
   * この grantId をアクセストークン・リフレッシュトークンのストア metadata にも保存することで、
   * 認可コード再利用を検知した際にまとめて失効できる（OAuth 2.1 Section 4.1.2）。
   */
  grantId: string;
  clientId: string;
  redirectUri: string;
  /**
   * 認可リクエストで redirect_uri が明示されていたか。
   * OIDC Core 1.0 Section 3.1.3.2: 明示時は Token Endpoint で MUST 一致。
   */
  redirectUriExplicit: boolean;
  scope: string[];
  subject: string;
  codeChallenge?: string;
  codeChallengeMethod?: 'S256';
  used: boolean;
  /** Unix timestamp（秒） */
  expiresAt: number;
  nonce?: string;
  /** Unix timestamp（秒） */
  authTime?: number;
  audience?: string[];
  /**
   * OIDC Core 1.0 §3.1.2.1: requested `acr_values` preserved from authorization so the
   * token endpoint can pass it to the AcrResolver as `requestedAcrValues`.
   */
  acrValues?: string;
  /** OIDC Core 1.0 §5.5: claims request preserved for ID Token issuance at the token endpoint. */
  claims?: ClaimsParameter;
  /**
   * この認可コードを発行した OP 認証セッションの識別子。
   * トークンエンドポイントが online refresh token をこのセッションへ束縛するために使う
   * （`sessionId` を持つ Refresh Token はセッション終了で `invalid_grant` になる）。
   * ブラウザセッションを持たない経路（device authorization grant など）では省略する。
   */
  sessionId?: string;
  /**
   * この認可コードを発行した Auth Transaction の ID（AuthorizationResponseParams.transactionId）。
   * ストアがコードと認可リクエストを結び付けて記録するために使う。トランザクションを
   * 経ない経路では省略する。
   */
  transactionId?: string;
}

/**
 * 認可コード発行オプション
 */
export interface CreateAuthorizationCodeOptions {
  /** completeAuthTransaction の戻り値 */
  authorizationResponse: AuthorizationResponseParams;
  /** 認証されたエンドユーザーの識別子 */
  subject: string;
  /** 認証時刻（Unix timestamp 秒） */
  authTime: number;
  /** 認可コードの有効期間（秒）。デフォルト: 300 (OIDC Core SHOULD be short-lived) */
  ttlSeconds?: number;
  /**
   * 認証セッションの識別子。渡すと発行データに引き継がれ、トークンエンドポイントが
   * online refresh token をこのセッションへ束縛できる。省略すると、その認可から
   * 発行される Refresh Token は `offline_access` を持つ場合のみ（= offline refresh
   * token として）発行される。
   */
  sessionId?: string;
}

/** 認可コードのデフォルト TTL（秒） */
const DEFAULT_AUTH_CODE_TTL_SECONDS = 300;

/**
 * 認可コードデータを生成する
 *
 * 認可コード文字列は `generateRandomString(32)` で生成される。
 * 戻り値の `AuthorizationCodeData` を利用者がストアに保存する想定。
 *
 * @param options 認可コード発行オプション
 * @returns 認可コードデータ
 */
export async function createAuthorizationCode(
  options: CreateAuthorizationCodeOptions,
): Promise<AuthorizationCodeData> {
  const { authorizationResponse, subject, authTime, ttlSeconds, sessionId } = options;

  return buildAuthorizationCodeData(authorizationResponse, {
    code: generateRandomString(32),
    grantId: generateRandomString(32),
    subject,
    authTime,
    ttlSeconds: ttlSeconds ?? DEFAULT_AUTH_CODE_TTL_SECONDS,
    now: Math.floor(Date.now() / 1000),
    sessionId,
  });
}

/**
 * 認可コードのデータを組み立てる。保存はしない。
 * 認可コードと grantId は呼び出し側が生成した値を受け取る（OIDC Core 1.0 §3.1.3.1 の推測困難性は
 * 生成側が担保する）。expiresAt は now（Unix epoch 秒）に ttlSeconds を足した値。
 */
export function buildAuthorizationCodeData(
  authorizationResponse: AuthorizationResponseParams,
  options: {
    code: string;
    grantId: string;
    subject: string;
    /** 認証時刻（Unix epoch 秒） */
    authTime: number;
    ttlSeconds: number;
    /** 現在時刻（Unix epoch 秒） */
    now: number;
    sessionId?: string;
  },
): AuthorizationCodeData {
  const { code, grantId, subject, authTime, ttlSeconds, now, sessionId } = options;

  const data: AuthorizationCodeData = {
    code,
    grantId,
    clientId: authorizationResponse.clientId,
    redirectUri: authorizationResponse.redirectUri,
    redirectUriExplicit: authorizationResponse.redirectUriExplicit,
    scope: authorizationResponse.scope,
    subject,
    used: false,
    expiresAt: now + ttlSeconds,
    authTime,
  };

  if (authorizationResponse.codeChallenge !== undefined) {
    data.codeChallenge = authorizationResponse.codeChallenge;
  }
  if (authorizationResponse.codeChallengeMethod !== undefined) {
    data.codeChallengeMethod = authorizationResponse.codeChallengeMethod;
  }
  if (authorizationResponse.nonce !== undefined) {
    data.nonce = authorizationResponse.nonce;
  }
  if (authorizationResponse.audience !== undefined) {
    data.audience = authorizationResponse.audience;
  }
  if (authorizationResponse.acrValues !== undefined) {
    data.acrValues = authorizationResponse.acrValues;
  }
  if (authorizationResponse.claims !== undefined) {
    data.claims = authorizationResponse.claims;
  }
  if (sessionId !== undefined) {
    data.sessionId = sessionId;
  }
  if (authorizationResponse.transactionId !== undefined) {
    data.transactionId = authorizationResponse.transactionId;
  }

  return data;
}
