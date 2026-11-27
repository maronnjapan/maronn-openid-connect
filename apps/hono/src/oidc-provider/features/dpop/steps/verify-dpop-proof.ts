import { DPOP_TOKEN_TYPE, type TokenBinding } from '../../../token-binding.js';
import { step } from '../../../endpoints/step.js';
import { buildDpopConfirmation } from '../binding.js';
import { tokenEndpointErrorOf } from '../error-responses.js';
import { readDpopProofHeader, verifyDpopRequestProof } from '../proof.js';

export const meta = step({
  id: 'verify-dpop-proof',
  endpoint: 'token',
  feature: 'dpop',
  kind: 'validate',
  label: 'DPoP proof を検証し、トークンを束縛する鍵を決める',
  spec: 'RFC 9449 §4.3 / §5',
  function: 'verifyDpopTokenRequest',
  consumes: [],
  produces: ['tokenBinding'],
  removable: false,
  after: ['authenticate-client'],
  before: ['validate-grant-type'],
});

/**
 * トークンリクエストの DPoP proof を検証し、発行するアクセストークンを束縛する鍵を返す。
 *
 * `DPoP` ヘッダーがなければ、`tokenBinding` が `undefined`（Bearer トークンを発行する）の結果を返す。
 * `DPoP` ヘッダーがあれば、DPoP proof を検査し（`htm` は POST、`htu` は issuer の `/token`）、その鍵への束縛を `tokenBinding` に入れて返す。
 * 返す `tokenBinding` は、アクセストークンの `cnf.jkt` をその鍵の JWK Thumbprint にし、`token_type` を `DPoP` にする（RFC 9449 §5 / §6.1）。
 * リフレッシュトークンを束縛する `refreshTokenCnf` は持たない。
 *
 * どのグラントの前にも実行するので、機能が答えるグラント（client_credentials など）のアクセストークンも同じ鍵に束縛する。
 * クライアントの認証の後に実行するので、認証に失敗したリクエストの DPoP proof は検査せず、その `jti` も覚えない。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §5
 * @throws {TokenEndpointError} 400 の `invalid_dpop_proof`: DPoP proof を受け付けないとき
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき（設定の誤り。500 の `server_error` で応答する）
 */
export async function verifyDpopTokenRequest(c: any): Promise<{ tokenBinding: TokenBinding | undefined }> {
  try {
    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(c.req.header('DPoP'));
    if (proof === undefined) return { tokenBinding: undefined };

    const dpopJkt = await verifyDpopRequestProof(c, proof, { method: c.req.method, path: '/token' });
    return { tokenBinding: { cnf: buildDpopConfirmation(dpopJkt), tokenType: DPOP_TOKEN_TYPE } };
  } catch (error) {
    throw tokenEndpointErrorOf(error);
  }
}
