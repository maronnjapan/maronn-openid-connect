import { isPublicTokenClient, type TokenClientInfo } from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../../config.js';
import type { TokenBinding } from '../../../token-binding.js';
import { step } from '../../../endpoints/step.js';
import { DPOP_TOKEN_TYPE, buildDpopConfirmation, requireDpopProofForClient, selectDpopRefreshTokenJkt } from '../binding.js';
import '../config.js';
import { tokenEndpointErrorOf } from '../error-responses.js';
import { readDpopProofHeader, verifyDpopRequestProof } from '../proof.js';

export const meta = step({
  id: 'verify-dpop-proof',
  endpoint: 'token',
  feature: 'dpop',
  kind: 'validate',
  label: 'DPoP proof を検証し、トークンを束縛する鍵を決める',
  spec: 'RFC 9449 §4.3 / §5 / §5.2',
  function: 'verifyDpopTokenRequest',
  consumes: ['tokenClient'],
  produces: ['dpopJkt', 'tokenBinding'],
  removable: false,
  after: ['authenticate-client'],
  before: ['validate-grant-type'],
});

/**
 * トークンリクエストの DPoP proof を検証し、発行するトークンを束縛する鍵を返す。
 *
 * `DPoP` ヘッダーがなければ、`dpopJkt` と `tokenBinding` が `undefined`（Bearer トークンを発行する）の結果を返す。
 * ただし、`dpop_bound_access_tokens` を登録したクライアントのリクエストは拒否する（RFC 9449 §5.2 の MUST）。
 * `DPoP` ヘッダーがあれば、DPoP proof を検査し（`htm` は POST、`htu` は issuer の `/token`）、その鍵の JWK Thumbprint を返す。
 * 返す `tokenBinding` は、アクセストークンをその鍵に束縛し（`cnf.jkt`、`token_type` は `DPoP`。RFC 9449 §5 / §6.1）、
 * パブリッククライアントにはリフレッシュトークンも同じ鍵に束縛する（RFC 9449 §5 の MUST）。
 * コンフィデンシャルクライアントのリフレッシュトークンは、クライアント認証で送り手が限られているので束縛しない。
 *
 * どのグラントの前にも実行するので、機能が答えるグラント（client_credentials など）のトークンも同じ鍵に束縛する。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §5
 * @spec RFC 9449 §5.2
 * @throws {TokenEndpointError} 400 の `invalid_dpop_proof`: DPoP proof を受け付けないとき、`dpop_bound_access_tokens` のクライアントが DPoP proof を送らなかったとき
 */
export async function verifyDpopTokenRequest(
  c: any,
  tokenClient: TokenClientInfo,
): Promise<{ dpopJkt: string | undefined; tokenBinding: TokenBinding | undefined }> {
  try {
    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(c.req.header('DPoP'));

    // `dpop_bound_access_tokens` を登録したクライアントは、常に DPoP を使う（RFC 9449 §5.2）。
    requireDpopProofForClient((tokenClient as RegisteredClient).dpopBoundAccessTokens, proof);
    if (proof === undefined) return { dpopJkt: undefined, tokenBinding: undefined };

    const dpopJkt = await verifyDpopRequestProof(c, proof, { method: c.req.method, path: '/token' });

    // パブリッククライアントのリフレッシュトークンは、DPoP proof の鍵に束縛する（RFC 9449 §5）。
    const refreshTokenJkt = selectDpopRefreshTokenJkt(isPublicTokenClient(tokenClient), dpopJkt);
    return {
      dpopJkt,
      tokenBinding: {
        cnf: buildDpopConfirmation(dpopJkt),
        tokenType: DPOP_TOKEN_TYPE,
        ...(refreshTokenJkt === undefined ? {} : { refreshTokenCnf: buildDpopConfirmation(refreshTokenJkt) }),
      },
    };
  } catch (error) {
    throw tokenEndpointErrorOf(error);
  }
}
