import { sign, arrayBufferToBase64Url, stringToArrayBuffer, getJwaAlgorithm } from './crypto-utils.js';

/**
 * Access Tokenのペイロード
 */
export interface AccessTokenPayload {
  iss: string;
  sub: string;
  aud: string[];
  exp: number;
  iat: number;
  /**
   * RFC 9068 §2.2 / RFC 7519 §4.1.5: "not before". OPTIONAL for JWT access
   * tokens; emitted by the JWT issuer (set to iat) for clock-skew tolerance.
   */
  nbf?: number;
  scope?: string;
  client_id?: string;
  [key: string]: unknown;
}

/**
 * Access Token生成のオプション
 */
export interface GenerateAccessTokenOptions {
  payload: AccessTokenPayload;
  privateKey: CryptoKey;
  keyId?: string;
}


/**
 * ペイロードを検証する
 */
function validatePayload(payload: AccessTokenPayload): void {
  // Required claims validation
  if (!payload.iss) {
    throw new Error('Missing required claim: iss');
  }

  if (!payload.sub) {
    throw new Error('Missing required claim: sub');
  }

  if (payload.aud === undefined || payload.aud === null) {
    throw new Error('Missing required claim: aud');
  }

  // RFC 9068 Section 3: the aud claim identifies the resource server(s) the
  // JWT access token is intended for, so an empty audience is not valid.
  if (!Array.isArray(payload.aud) || payload.aud.length === 0) {
    throw new Error('Invalid aud claim: must be a non-empty array');
  }

  if (payload.exp === undefined || payload.exp === null) {
    throw new Error('Missing required claim: exp');
  }

  // Validate exp is not too far in the past (with 60 second clock skew tolerance)
  const now = Math.floor(Date.now() / 1000);
  const clockSkewTolerance = 60;
  if (payload.exp < now - clockSkewTolerance) {
    throw new Error('Token expiration time is in the past');
  }

  if (payload.iat === undefined || payload.iat === null) {
    throw new Error('Missing required claim: iat');
  }
}

/**
 * Base64URL エンコード
 */
function base64UrlEncode(str: string): string {
  return arrayBufferToBase64Url(stringToArrayBuffer(str));
}

/**
 * アクセストークンを生成する（JWT形式）
 * サポートする署名アルゴリズム（JWA名称 = 暗号方式）:
 * - RS256/RS384/RS512 = RSASSA-PKCS1-v1_5 with SHA-256/384/512
 *   ※ OpenID Connect/OAuth 2.1で広く使用されている標準アルゴリズム
 * - ES256/ES384/ES512 = ECDSA with P-256/P-384/P-521 and SHA-256/384/512【推奨】
 *   ※ 楕円曲線暗号による高速かつ安全な署名方式
 * @param options Access Token生成のオプション
 * @returns 生成されたAccess Token（JWT形式）
 */
export async function generateAccessToken(options: GenerateAccessTokenOptions): Promise<string> {
  const { payload, privateKey, keyId } = options;

  // Validate payload
  validatePayload(payload);

  // Build JOSE header
  // RFC 9068 Section 2.1: JWT Profile for OAuth 2.0 Access Tokens requires typ = "at+jwt"
  // so resource servers can distinguish access tokens from ID tokens (typ = "JWT").
  const header: Record<string, string> = {
    alg: getJwaAlgorithm(privateKey),
    typ: 'at+jwt',
  };

  if (keyId) {
    header.kid = keyId;
  }

  // Encode header and payload
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));

  // Create signing input
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign
  const signature = await sign(signingInput, privateKey);

  return `${signingInput}.${signature}`;
}
