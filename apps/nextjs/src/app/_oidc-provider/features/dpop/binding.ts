/**
 * トークンと認可コードの、DPoP の鍵への束縛（RFC 9449 §5 / §6 / §10）。
 *
 * OP は、DPoP proof の鍵の JWK Thumbprint（`jkt`）を、発行するアクセストークンの `cnf` に入れ（RFC 9449 §6.1）、
 * 保存するアクセストークンのレコードにも同じ `cnf` を残す（イントロスペクションが返す。RFC 9449 §6.2）。
 * パブリッククライアントに発行するリフレッシュトークンも、同じ鍵に束縛する（RFC 9449 §5）。
 * 認可リクエストの `dpop_jkt` は、その認可リクエストから発行する認可コードを束縛する鍵の JWK Thumbprint として読む（RFC 9449 §10）。
 * レコードの `cnf.jkt` で鍵に束縛した認可コードとリフレッシュトークンは、同じ鍵の DPoP proof を送ったトークンリクエストだけが使える（RFC 9449 §5 / §10）。
 */
import { decodeBase64Url } from './base64url';
import { DpopError } from './errors';

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
