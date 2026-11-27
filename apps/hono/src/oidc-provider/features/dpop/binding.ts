/**
 * トークンと認可コードの、DPoP の鍵への束縛（RFC 9449 §5 / §6 / §10 / §10.1）。
 *
 * OP は、DPoP proof の鍵の JWK Thumbprint（`jkt`）を、発行するアクセストークンの `cnf` に入れ（RFC 9449 §6.1）、
 * 保存するアクセストークンのレコードにも同じ `cnf` を残す（イントロスペクションが返す。RFC 9449 §6.2）。
 * パブリッククライアントに発行するリフレッシュトークンも、同じ鍵に束縛する（RFC 9449 §5）。
 * 認可リクエストの `dpop_jkt` は、その認可リクエストから発行する認可コードを束縛する鍵の JWK Thumbprint として読む（RFC 9449 §10）。
 * PAR のリクエストの `DPoP` ヘッダーの鍵は、プッシュした認可リクエストの `dpop_jkt` として扱う（RFC 9449 §10.1）。
 * レコードの `cnf.jkt` で鍵に束縛した認可コードとリフレッシュトークンは、同じ鍵の DPoP proof を送ったトークンリクエストだけが使える（RFC 9449 §5 / §10）。
 * `dpop_bound_access_tokens` を登録したクライアントは、DPoP proof の無いトークンリクエストでトークンを得られない（RFC 9449 §5.2）。
 */
import type { TokenClientInfo } from '@maronn-openid-connect/core';
import type { RegisteredClient } from '../../config.js';
import { decodeBase64Url } from './base64url.js';
import { DpopError } from './errors.js';

/**
 * DPoP で束縛したトークンの確認（`cnf`）のメンバー（RFC 7800 §3.1、RFC 9449 §6.1）。
 *
 * 型の別名にしてあるので、確認の値を `Record<string, string>` として扱う呼び出し側にもそのまま渡せる。
 */
export type DpopConfirmation = {
  /** DPoP proof の鍵の JWK Thumbprint（SHA-256、base64url） */
  jkt: string;
};

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

/** JWK Thumbprint（RFC 7638 §3）の SHA-256 のバイト数。 */
const JWK_THUMBPRINT_BYTES = 32;

/**
 * 認可リクエストの `dpop_jkt` を確かめ、JWK Thumbprint として返す。
 *
 * パラメータがないときと、値が空のときは `undefined` を返す（値のないパラメータは、省略したものとして扱う。RFC 6749 §3.1）。
 * `dpop_jkt` は、DPoP の鍵の JWK Thumbprint で、SHA-256 の 32 バイトをパディングのない正規の base64url にした 43 文字でなければならない。
 * 正規でない base64url の値（末尾の文字の余りのビットが 0 でない値）は、トークンリクエストの DPoP proof の鍵から計算する JWK Thumbprint と一致することがないので、これも拒否する。
 *
 * @spec RFC 9449 §10
 * @spec RFC 7638 §3
 * @spec RFC 6749 §3.1
 * @throws {DpopError} `invalid_request`: 値が JWK Thumbprint の形でないとき
 */
export function parseDpopJkt(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || decodeBase64Url(value)?.length !== JWK_THUMBPRINT_BYTES) {
    throw new DpopError('invalid_request', 'dpop_jkt must be a base64url SHA-256 JWK Thumbprint');
  }
  return value;
}

/**
 * PAR のリクエストの DPoP proof の鍵の JWK Thumbprint を、プッシュされた認可リクエストの認可コードを束縛する鍵として返す。
 *
 * PAR のリクエストの DPoP proof の鍵は、`dpop_jkt` で送った鍵として扱う（RFC 9449 §10.1）。
 * プッシュされた認可リクエストにも `dpop_jkt` があるときは、DPoP proof の鍵と同じでなければ拒否する（RFC 9449 §10.1 の MUST）。
 *
 * @spec RFC 9449 §10.1
 * @throws {DpopError} `invalid_dpop_proof`: `dpop_jkt` と DPoP proof の鍵の JWK Thumbprint が違うとき
 */
export function resolvePushedDpopJkt(dpopJkt: string | undefined, proofJkt: string): string {
  if (dpopJkt !== undefined && dpopJkt !== proofJkt) {
    throw new DpopError('invalid_dpop_proof', 'dpop_jkt does not match the key of the DPoP proof');
  }
  return proofJkt;
}

/**
 * クライアントが `dpop_bound_access_tokens`（常に DPoP を使う）を登録しているかを返す。
 *
 * クライアントの `dpopBoundAccessTokens`（`config.ts` が `RegisteredClient` に足すメンバー）が `true` なら `true` を返す。
 * 動的クライアント登録のクライアントは、登録したメタデータを `registrationMetadata` に `dpop_bound_access_tokens` の名前で持つので、その値が `true` のときも `true` を返す。
 * どちらでもなければ `false` を返す（省略したときの既定値は `false`）。
 * 真偽値の `true` だけを数え、文字列の `"true"` のような値は数えない。
 *
 * @spec RFC 9449 §5.2
 */
export function dpopBoundAccessTokensOf(client: TokenClientInfo): boolean {
  const { dpopBoundAccessTokens, registrationMetadata } = client as RegisteredClient & {
    registrationMetadata?: Readonly<Record<string, unknown>>;
  };
  return dpopBoundAccessTokens === true || registrationMetadata?.dpop_bound_access_tokens === true;
}

/**
 * `dpop_bound_access_tokens` を登録したクライアントのトークンリクエストに、DPoP proof があることを確かめる。
 *
 * `dpopBoundAccessTokens` が `true`（クライアントが常に DPoP を使うと登録した）なのに、`DPoP` ヘッダーが無い（`proof` が `undefined`）リクエストを拒否する（MUST）。
 * `dpopBoundAccessTokens` が `false` なら、DPoP proof が無くても何もしない。
 *
 * @spec RFC 9449 §5.2
 * @throws {DpopError} `invalid_dpop_proof`: `dpop_bound_access_tokens` を登録したクライアントのリクエストに DPoP proof が無いとき
 */
export function requireDpopProofForClient(dpopBoundAccessTokens: boolean, proof: string | undefined): void {
  if (dpopBoundAccessTokens && proof === undefined) {
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
