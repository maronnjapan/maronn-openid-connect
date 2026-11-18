import { isDpopError, parseDpopJkt, readDpopProofHeader, resolvePushedDpopJkt } from '@maronn-openid-connect/dpop';
import { step } from '../../../endpoints/step.js';
import { verifyDpopRequestProof } from '../proof.js';

export const meta = step({
  id: 'bind-pushed-dpop-key',
  endpoint: 'par',
  feature: 'dpop',
  kind: 'validate',
  label: 'プッシュした認可リクエストを DPoP の鍵に束縛する',
  spec: 'RFC 9449 §10.1',
  function: 'bindPushedDpopKey',
  consumes: ['pushedParams'],
  produces: ['dpopBoundParams', 'dpopRejection'],
  removable: false,
  after: ['authenticate-client'],
  before: ['validate-request'],
});

/** What bindPushedDpopKey() decided. */
export interface PushedDpopBinding {
  /** The pushed parameters with dpop_jkt set to the key of the DPoP proof; undefined when the request had no DPoP header. */
  dpopBoundParams?: Record<string, string>;
  /** The error response to answer with when the DPoP proof or dpop_jkt was rejected. */
  dpopRejection?: Response;
}

/**
 * プッシュされた認可リクエストに `DPoP` ヘッダーがあれば、その鍵の JWK Thumbprint を `dpop_jkt` にしたパラメータを返す。
 *
 * PAR のリクエストの DPoP proof は、認可コードを束縛する鍵を示す（RFC 9449 §10.1）。
 * DPoP proof を検査し（`htm` はリクエストのメソッド、`htu` は issuer の `/par`）、その鍵を `dpop_jkt` として保存するリクエストに入れる。
 * `/authorize` がこのリクエストを展開すると、`dpop_jkt` が認可コードをその鍵に束縛する（RFC 9449 §10）。
 * `dpop_jkt` と DPoP proof の両方があれば、同じ鍵でなければ拒否する。
 * `DPoP` ヘッダーがなければ何も返さず、プッシュされた `dpop_jkt`（あれば）をそのまま使う。
 *
 * 拒否するときは、PAR のエラーと同じ形（RFC 9126 §2.3）の 400 の JSON のレスポンス（`no-store`）を `dpopRejection` に入れて返す。
 * PAR の機能のエラーの型を使わないのは、DPoP の機能が PAR の機能なしでも生成されるためである。
 *
 * @spec RFC 9449 §10.1
 * @spec RFC 9126 §2.3
 */
export async function bindPushedDpopKey(c: any, pushedParams: Record<string, string>): Promise<PushedDpopBinding> {
  try {
    const proof = readDpopProofHeader(c.req.header('DPoP'));
    if (proof === undefined) return {};
    const proofJkt = await verifyDpopRequestProof(c, proof, { method: c.req.method, path: '/par' });
    const dpopJkt = resolvePushedDpopJkt(parseDpopJkt(pushedParams.dpop_jkt), proofJkt);
    return dpopJkt === undefined ? {} : { dpopBoundParams: { ...pushedParams, dpop_jkt: dpopJkt } };
  } catch (error) {
    if (!isDpopError(error)) throw error;
    return {
      dpopRejection: new Response(JSON.stringify({ error: error.error, error_description: error.errorDescription }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      }),
    };
  }
}
