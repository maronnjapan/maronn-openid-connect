import {
  type SigningKey,
  type UserClaims,
  buildIdTokenPayload,
  computeAtHash,
  generateIdToken,
  hasRequestedIdTokenClaims,
  selectRequestedIdTokenClaims,
  type ValidatedTokenRequest,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'issue-id-token',
  endpoint: 'token',
  kind: 'issue',
  label: 'Issue the ID Token',
  spec: 'OIDC Core 1.0 §3.1.3.6 / §5.5 / §12.1',
  function: 'issueIdToken',
  calls: ['computeAtHash', 'hasRequestedIdTokenClaims', 'selectRequestedIdTokenClaims', 'buildIdTokenPayload', 'generateIdToken'],
  consumes: ['idTokenSigningKey', 'accessToken', 'subject', 'authTime', 'nonce', 'validatedRequest', 'issuedAt', 'acr', 'amr'],
  produces: ['idToken'],
  removable: true,
  fallback: true,
});

/**
 * Issue the ID Token when the grant carries the openid scope: at_hash binds
 * it to the access token (§3.1.3.6), acr / amr are the ones
 * resolveTokenAcrAmr() settled on (kept from the first authentication on a
 * refresh, §12.1), and the claims the id_token member of the claims parameter
 * of the authorization request asks for are added (§5.5).
 * OIDC Core 1.0 §3.1.3.6 / §5.5 / §12.1
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

  // OIDC Core 1.0 §12: refresh_token grant でも id_token は MAY。
  // openid scope を持つ場合は §12.1 に従い初回認証時と同じ auth_time / acr / amr / azp で再発行する。
  // （§12.2 は nonce を再発行 ID Token の保持クレームに挙げないため nonce は refresh では undefined）
  if (!validatedRequest.scope.includes('openid')) {
    return undefined;
  }

  // OIDC Core 1.0 §3.1.3.6: at_hash binds the ID Token to this access token.
  // The hash function follows the ID Token signing alg.
  const atHash = await computeAtHash(accessToken, idTokenSigningKey.privateKey);

  // OIDC Core 1.0 §5.5: the claims the id_token member of the claims parameter
  // of the authorization request asks for, whatever the scope (the claims of
  // the scope values stay with the UserInfo endpoint, §5.4). A refresh carries
  // no claims request.
  const claims = validatedRequest.grantType === 'authorization_code' ? validatedRequest.claims : undefined;
  const userClaims = hasRequestedIdTokenClaims(claims)
    ? ((await c.get('userClaimsResolver').findUserClaims(subject)) as UserClaims | null) ?? undefined
    : undefined;

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
    requestedClaims: userClaims === undefined ? undefined : selectRequestedIdTokenClaims(userClaims, claims),
  });

  // Add your own ID Token claims here, e.g.:
  //   idTokenPayload.tenant_id = await lookupTenant(subject);

  return generateIdToken({
    payload: idTokenPayload,
    privateKey: idTokenSigningKey.privateKey,
    keyId: idTokenSigningKey.keyId,
  });
}
