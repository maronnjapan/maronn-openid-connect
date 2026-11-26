/**
 * トークンと認可コードの、DPoP の鍵への束縛（RFC 9449 §5 / §6 / §10）。
 *
 * OP は、DPoP proof の鍵の JWK Thumbprint（`jkt`）を、発行するアクセストークンの `cnf` に入れ（RFC 9449 §6.1）、
 * 保存するトークンのレコードにも同じ `cnf` を残す（イントロスペクションが返す。RFC 9449 §6.2）。
 * パブリッククライアントに発行するリフレッシュトークンと、`dpop_jkt` を付けた認可リクエストの認可コードも、同じ鍵に束縛する。
 */
import { DpopError } from './errors';

/** DPoP の鍵に束縛したアクセストークンの `token_type`（RFC 9449 §5 / §12.1）。 */
export const DPOP_TOKEN_TYPE = 'DPoP';

/**
 * DPoP で束縛したトークンの確認（`cnf`）のメンバー（RFC 7800 §3.1、RFC 9449 §6.1）。
 *
 * 型の別名にしてあるので、確認の値を `Record<string, string>` として扱う呼び出し側にもそのまま渡せる。
 */
export type DpopConfirmation = {
  /** DPoP proof の鍵の JWK Thumbprint（SHA-256、base64url） */
  jkt: string;
};

/** JWK Thumbprint（SHA-256 を base64url にした 43 文字）の形。 */
const JWK_THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

/**
 * DPoP の鍵の JWK Thumbprint から、トークンの `cnf` の値を返す。
 *
 * @spec RFC 9449 §6.1
 * @spec RFC 7800 §3.1
 */
export function buildDpopConfirmation(jkt: string): DpopConfirmation {
  return { jkt };
}

/**
 * レコードの `cnf` から、DPoP の鍵の JWK Thumbprint を返す。
 *
 * トークンや認可コードのレコード、JWT のクレームのどれにも使える。
 * `cnf` がないか、`cnf.jkt` が文字列でなければ `undefined` を返す（DPoP の鍵に束縛されていない）。
 *
 * @spec RFC 9449 §6.1
 * @spec RFC 9449 §6.2
 */
export function readDpopJkt(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const cnf = (record as { cnf?: unknown }).cnf;
  if (typeof cnf !== 'object' || cnf === null) return undefined;
  const jkt = (cnf as { jkt?: unknown }).jkt;
  return typeof jkt === 'string' ? jkt : undefined;
}

/**
 * 認可リクエストの `dpop_jkt` を確かめ、JWK Thumbprint として返す。
 *
 * パラメータがなければ `undefined` を返す。
 * `dpop_jkt` は、DPoP proof の鍵の JWK Thumbprint（SHA-256 を base64url にした 43 文字）でなければならない。
 *
 * @spec RFC 9449 §10
 * @throws {DpopError} `invalid_request`: 値が JWK Thumbprint の形でないとき
 */
export function parseDpopJkt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !JWK_THUMBPRINT.test(value)) {
    throw new DpopError('invalid_request', 'dpop_jkt must be a base64url SHA-256 JWK Thumbprint');
  }
  return value;
}

/**
 * プッシュされた認可リクエストの `dpop_jkt` と `DPoP` ヘッダーの鍵から、認可コードを束縛する鍵を決めて返す。
 *
 * PAR のリクエストに DPoP proof があれば、その鍵の JWK Thumbprint を `dpop_jkt` として使う（RFC 9449 §10.1）。
 * `dpop_jkt` と DPoP proof の両方があるときは、同じ鍵でなければ拒否する。
 * どちらもなければ `undefined` を返す。
 *
 * @spec RFC 9449 §10.1
 * @throws {DpopError} `invalid_dpop_proof`: `dpop_jkt` と DPoP proof の鍵が違うとき
 */
export function resolvePushedDpopJkt(dpopJkt: string | undefined, proofJkt: string | undefined): string | undefined {
  if (dpopJkt !== undefined && proofJkt !== undefined && dpopJkt !== proofJkt) {
    throw new DpopError('invalid_dpop_proof', 'dpop_jkt does not match the key of the DPoP proof');
  }
  return proofJkt ?? dpopJkt;
}

/**
 * `dpop_bound_access_tokens` を登録したクライアントのトークンリクエストに、DPoP proof があることを確かめる。
 *
 * `dpop_bound_access_tokens` が `true` のクライアントは常に DPoP を使うので、DPoP proof のないトークンリクエストを拒否する（MUST）。
 *
 * @spec RFC 9449 §5.2
 * @throws {DpopError} `invalid_dpop_proof`: クライアントが `dpop_bound_access_tokens` を登録したのに DPoP proof がないとき
 */
export function requireDpopProofForClient(dpopBoundAccessTokens: boolean | undefined, proof: string | undefined): void {
  if (dpopBoundAccessTokens === true && proof === undefined) {
    throw new DpopError('invalid_dpop_proof', 'This client must send a DPoP proof with every token request');
  }
}

/**
 * 認可コードかリフレッシュトークンを束縛した鍵と、トークンリクエストの DPoP proof の鍵が同じであることを確かめる。
 *
 * 束縛していない（`boundJkt` が `undefined`）なら何もしない。
 * 束縛しているなら、DPoP proof がない、または DPoP proof の鍵の JWK Thumbprint が違うリクエストを拒否する。
 *
 * @spec RFC 9449 §5
 * @spec RFC 9449 §10
 * @throws {DpopError} `invalid_grant`: DPoP proof がないとき、別の鍵の DPoP proof のとき
 */
export function validateDpopBoundGrant(boundJkt: string | undefined, proofJkt: string | undefined): void {
  if (boundJkt === undefined) return;
  if (proofJkt === undefined) {
    throw new DpopError('invalid_grant', 'The grant is bound to a DPoP key, but no DPoP proof was sent');
  }
  if (proofJkt !== boundJkt) {
    throw new DpopError('invalid_grant', 'The DPoP proof key does not match the key the grant is bound to');
  }
}

/**
 * 発行するリフレッシュトークンを束縛する鍵の JWK Thumbprint を返す。
 *
 * パブリッククライアントが DPoP proof を送ったときは、リフレッシュトークンをその鍵に束縛する（MUST）。
 * コンフィデンシャルクライアントのリフレッシュトークンは、クライアント認証で送り手が限られているので束縛しない（`undefined` を返す）。
 *
 * @spec RFC 9449 §5
 */
export function selectDpopRefreshTokenJkt(publicClient: boolean, proofJkt: string | undefined): string | undefined {
  return publicClient ? proofJkt : undefined;
}
