import { sanitizeErrorDescription } from './error-utils.js';

/**
 * Token Endpointのエラーコード
 * OAuth 2.1 Section 3.2.3 / OIDC Core 1.0 Section 3.1.3.4
 */
export enum TokenErrorCode {
  InvalidRequest = 'invalid_request',
  InvalidClient = 'invalid_client',
  InvalidGrant = 'invalid_grant',
  UnauthorizedClient = 'unauthorized_client',
  UnsupportedGrantType = 'unsupported_grant_type',
  InvalidScope = 'invalid_scope',
}

/**
 * Token Endpointのエラー
 */
export class TokenError extends Error {
  public readonly error: TokenErrorCode;
  public readonly errorDescription: string;

  constructor(error: TokenErrorCode, errorDescription: string) {
    // RFC 6749 Section 5.2: error_description must be limited to %x20-21 / %x23-5B / %x5D-7E
    // so user-supplied fragments cannot inject quotes/control bytes into JSON or WWW-Authenticate.
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'TokenError';
    this.error = error;
    this.errorDescription = sanitized;
  }

  /**
   * HTTPステータスコード
   * invalid_client の場合は 401、それ以外は 400
   */
  get statusCode(): number {
    return this.error === TokenErrorCode.InvalidClient ? 401 : 400;
  }

  /**
   * 401 レスポンス時に設定すべき WWW-Authenticate ヘッダー値。
   * RFC 6750 Section 3 / OAuth 2.1 Section 5.2: invalid_client の場合のみ Basic realm を返す。
   * その他のエラーは undefined。
   */
  get wwwAuthenticate(): string | undefined {
    if (this.error === TokenErrorCode.InvalidClient) {
      return 'Basic realm="Client Authentication"';
    }
    return undefined;
  }
}
