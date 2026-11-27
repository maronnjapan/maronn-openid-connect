import { step } from '../../../endpoints/step.js';
import { parseDpopJkt, resolvePushedDpopJkt } from '../binding.js';
import { isDpopError } from '../errors.js';
import { readDpopProofHeader, verifyDpopRequestProof } from '../proof.js';

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
 * DPoP proof を検査し（`htm` はリクエストのメソッド、`htu` は issuer の `/par`）、その鍵の JWK Thumbprint を `dpop_jkt` にしたパラメータを `dpopBoundParams` に入れて返す。
 * 後のブロックは、このパラメータを検証して保存するので、`/authorize` がこのリクエストを展開すると、`dpop_jkt` が認可コードをその鍵に束縛する（RFC 9449 §10）。
 * プッシュされた `dpop_jkt` と DPoP proof の両方があれば、同じ鍵でなければ拒否する（RFC 9449 §10.1 の MUST）。
 * `DPoP` ヘッダーがなければ何も返さず、プッシュされたパラメータ（`dpop_jkt` があればそれも）をそのまま使わせる。
 * プッシュされた `dpop_jkt` の形は、`DPoP` ヘッダーの有無にかかわらず、DPoP proof の前に確かめる（認可エンドポイントと同じ検証。RFC 9126 §2.1）。
 * クライアントの認証の後に実行するので、認証に失敗したリクエストの DPoP proof は検査せず、その `jti` も覚えない。
 *
 * 拒否するときは、PAR のエラーと同じ形（RFC 9126 §2.3）の 400 の JSON のレスポンス（`no-cache, no-store`）を `dpopRejection` に入れて返す。
 * `error` は、DPoP proof を受け付けないときと `dpop_jkt` が DPoP proof の鍵と違うときは `invalid_dpop_proof`、`dpop_jkt` が JWK Thumbprint の形でないときは `invalid_request` である。
 * PAR の機能のエラーの型を使わないのは、DPoP の機能が PAR の機能なしでも生成されるためである（そのときもこのファイルは生成されるが、PAR エンドポイントがないので、どこからも呼ばれない）。
 * レスポンスはコンテキストで組み立てるので、CORS のミドルウェアが付けたヘッダーも残る。
 *
 * @spec RFC 9449 §10.1
 * @spec RFC 9126 §2.1
 * @spec RFC 9126 §2.3
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき、またはこの二つのコード以外の `DpopError`（どちらも PAR エンドポイントは 500 の `server_error` で応答する）
 */
export async function bindPushedDpopKey(c: any, pushedParams: Record<string, string>): Promise<PushedDpopBinding> {
  try {
    const pushedJkt = parseDpopJkt(pushedParams.dpop_jkt);

    // `DPoP` ヘッダーは一つだけでなければならない（RFC 9449 §4.3）。
    const proof = readDpopProofHeader(c.req.header('DPoP'));
    if (proof === undefined) return {};

    const proofJkt = await verifyDpopRequestProof(c, proof, { method: c.req.method, path: '/par' });
    return { dpopBoundParams: { ...pushedParams, dpop_jkt: resolvePushedDpopJkt(pushedJkt, proofJkt) } };
  } catch (error) {
    if (!isDpopError(error) || (error.error !== 'invalid_dpop_proof' && error.error !== 'invalid_request')) throw error;
    c.header('Cache-Control', 'no-cache, no-store');
    c.header('Pragma', 'no-cache');
    return { dpopRejection: c.json({ error: error.error, error_description: error.errorDescription }, 400) };
  }
}
