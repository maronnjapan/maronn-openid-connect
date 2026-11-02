import {
  type SigningKey,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,
  type ValidatedTokenRequest,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'issue-id-token',
  endpoint: 'token',
  kind: 'issue',
  label: 'Issue the ID Token',
  spec: 'OIDC Core 1.0 §3.1.3.6 / §12.1',
  function: 'issueIdToken',
  consumes: ['idTokenSigningKey', 'accessToken', 'subject', 'authTime', 'nonce', 'validatedRequest', 'issuedAt', 'acr', 'amr'],
  produces: ['idToken'],
  removable: true,
  fallback: true,
});

/**
 * `openid` スコープがあれば ID トークンを発行して返す。
 *
 * スコープに `openid` がなければ、ID トークンを発行せずに `undefined` を返す。
 * `at_hash` には同じレスポンスで返すアクセストークンのハッシュの左半分を入れ、ID トークンをそのアクセストークンに結び付ける（OIDC Core 1.0 §3.1.3.6）。
 * `acr` と `amr` には `resolveTokenAcrAmr()` が決めた値を入れ、リフレッシュでは最初の認証のときの値を引き継ぐ（OIDC Core 1.0 §12.1）。
 *
 * @spec OIDC Core 1.0 §3.1.3.6
 * @spec OIDC Core 1.0 §12.1
 */
export async function issueIdToken(
  c: any,
  input: {
    idTokenSigningKey: SigningKey;
    accessToken: string;
    subject: string;
    authTime: number | undefined;
    nonce: string | undefined;
    validatedRequest: ValidatedTokenRequest;
    issuedAt: number;
    acr: string | undefined;
    amr: string[] | undefined;
  },
): Promise<string | undefined> {
  const { idTokenSigningKey, accessToken, subject, authTime, nonce, validatedRequest, issuedAt, acr, amr } = input;
  const config = c.get('config');

  // ID トークンは、スコープに `openid` があるときだけ発行する。
  // `refresh_token` グラントでも ID トークンを返してよく（MAY）、返すときは最初の認証と同じ `auth_time`、`acr`、`amr` で発行し直す（OIDC Core 1.0 §12、§12.1）。
  // リフレッシュでは `nonce` が `undefined` になる。
  // OIDC Core 1.0 §12.2 が、発行し直す ID トークンに残すクレームに `nonce` を挙げていないためである。
  if (!validatedRequest.scope.includes('openid')) {
    return undefined;
  }

  // このアクセストークンのハッシュの左半分から `at_hash` を求め、ID トークンをアクセストークンに結び付ける（OIDC Core 1.0 §3.1.3.6）。
  // ハッシュ関数は、ID トークンの署名鍵の `alg` に合わせる。
  const atHash = await computeAtHash(accessToken, idTokenSigningKey.privateKey);

  const idTokenPayload = buildIdTokenPayload({
    issuer: config.issuer,
    subject,
    clientId: validatedRequest.clientId,
    scope: validatedRequest.scope,
    expiresIn: config.idTokenExpiresIn,
    issuedAt,
    atHash,
    nonce,
    authTime,
    acr,
    amr,
  });

  // ID トークンに独自のクレームを加えるときは、署名する前のここでペイロードに加える（例: `idTokenPayload.tenant_id = await lookupTenant(subject);`）。

  return generateIdToken({
    payload: idTokenPayload,
    privateKey: idTokenSigningKey.privateKey,
    keyId: idTokenSigningKey.keyId,
  });
}
