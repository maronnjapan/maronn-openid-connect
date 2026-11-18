/**
 * DPoP proof JWT の検査（RFC 9449 §4.3）。
 *
 * クライアントは、リクエストごとに新しい DPoP proof（`typ` が `dpop+jwt` の JWT）を作り、`DPoP` ヘッダーで送る。
 * 検査は責務ごとの関数に分けてあり、次の順に呼ぶ（順序は入れ替えてもよい。RFC 9449 §4.3）。
 * 1. {@link readDpopProofHeader}: `DPoP` ヘッダーが一つだけであることを確かめる
 * 2. {@link decodeDpopProof}: JWS のコンパクト形式を分解し、`typ` と JOSE ヘッダーを確かめる
 * 3. {@link validateDpopProofAlg}: `alg` が OP の受け付ける非対称鍵の署名であることを確かめる
 * 4. `validateDpopProofJwk()` と {@link verifyDpopProofSignature}: `jwk` が公開鍵であることと、その鍵で署名を検証できることを確かめる
 * 5. {@link validateDpopProofClaims}: `jti`、`htm`、`htu`、`iat` を確かめる
 * 6. {@link validateDpopProofAccessTokenHash}: 保護されたリソースへのリクエストでは `ath` を確かめる
 * 7. {@link consumeDpopProofJti}: `jti` を覚え、同じ DPoP proof の再利用を拒否する
 *
 * どの失敗も `invalid_dpop_proof` の `DpopError` になる（RFC 9449 §5 / §7.1）。
 */
import { decodeBase64Url, encodeBase64Url } from './base64url.js';
import { DpopError } from './errors.js';
import { normalizeDpopHtu } from './htu.js';
import { isSupportedDpopSigningAlg, verifyJwsSignature, type DpopPublicJwk } from './jwk.js';

/** DPoP proof の JOSE ヘッダーの `typ`（RFC 9449 §4.2）。 */
export const DPOP_PROOF_TYPE = 'dpop+jwt';

/**
 * DPoP proof の `iat` から、DPoP proof を受け付ける秒数の既定値。
 *
 * 時計のずれ（{@link DEFAULT_DPOP_PROOF_LEEWAY_SECONDS}）はこれとは別に足すので、既定では `iat` から 120 秒まで受け付ける。
 */
export const DEFAULT_DPOP_PROOF_MAX_AGE_SECONDS = 60;

/** DPoP proof の `iat` に許す時計のずれ（秒）の既定値。 */
export const DEFAULT_DPOP_PROOF_LEEWAY_SECONDS = 60;

/** {@link decodeDpopProof} が分解した DPoP proof。署名はまだ検証していない。 */
export interface DecodedDpopProof {
  /** JOSE ヘッダー */
  header: Record<string, unknown>;
  /** ペイロードのクレーム（未検証） */
  claims: Record<string, unknown>;
  /** ヘッダーの `alg` */
  alg: string;
  /** ヘッダーの `jwk`（未検証。`validateDpopProofJwk()` で公開鍵であることを確かめる） */
  jwk: unknown;
  /** 署名の対象（`<header>.<payload>`） */
  signingInput: string;
  /** 署名（base64url） */
  signature: string;
}

/** {@link validateDpopProofClaims} の検査の条件。 */
export interface DpopProofClaimsPolicy {
  /** DPoP proof を受け取ったリクエストの HTTP メソッド（`htm` と比べる） */
  method: string;
  /**
   * DPoP proof を受け取ったリクエストの URI（`htu` と比べる）。
   * クエリとフラグメントは比較に使わない。
   * プロキシの後ろでもクライアントが見る URI と一致するよう、OP の issuer から組み立てた URL を渡す。
   */
  uri: string;
  /** 現在時刻（Unix epoch 秒） */
  now: number;
  /** `iat` から DPoP proof を受け付ける秒数（時計のずれの `leewaySeconds` は別に足す）。既定は {@link DEFAULT_DPOP_PROOF_MAX_AGE_SECONDS} */
  maxAgeSeconds?: number;
  /** 時計のずれとして許す秒数。既定は {@link DEFAULT_DPOP_PROOF_LEEWAY_SECONDS} */
  leewaySeconds?: number;
}

/** {@link validateDpopProofClaims} が確かめたクレームのうち、`jti` の消費に使う値。 */
export interface ValidatedDpopProofClaims {
  /** DPoP proof の `jti` */
  jti: string;
  /** DPoP proof の `iat`（Unix epoch 秒） */
  iat: number;
  /**
   * `jti` を覚えておく期限（Unix epoch 秒、この時刻を含まない）。
   * DPoP proof を受け付ける最後の秒の次の秒で、この時刻からは `iat` が古すぎて DPoP proof が拒否される。
   * `jti` のストアは期限の時刻になった `jti` を忘れてよいので、受け付ける最後の秒にも `jti` が残る。
   */
  replayWindowEndsAt: number;
}

/**
 * 使用済みの DPoP proof の `jti` を覚えるストア。
 *
 * OP は、受け付けた DPoP proof の `jti` を、その DPoP proof が受け付けられる間だけ覚え、同じ `jti` の再提示を拒否する（RFC 9449 §11.1）。
 * core の `ClientAssertionJtiStore` と同じ形なので、private_key_jwt の `jti` を覚えるストアをそのまま渡せる（キーは重ならない）。
 */
export interface DpopProofJtiStore {
  /**
   * `key` を `expiresAt`（Unix epoch 秒）まで覚え、初めての `key` なら `true`、覚えている `key` なら `false` を返す。
   *
   * 同じ `key` を同時に渡した二つの呼び出しのうち、`true` を返すのは一方だけにする（できればアトミックに）。
   * 期限を過ぎた `key` は忘れてよい。
   */
  consume(key: string, expiresAt: number): boolean | Promise<boolean>;
}

/**
 * `DPoP` ヘッダーの値から DPoP proof を返す。
 *
 * ヘッダーがなければ `undefined` を返す。
 * Fetch API の `Headers` は、同じ名前のヘッダーを `, ` でつないだ一つの値にするので、`,` を含む値は複数の `DPoP` ヘッダーとして拒否する（JWT のコンパクト形式は `,` を含まない）。
 * 空の値、空白を含む値も、一つの JWT ではないので拒否する。
 *
 * @spec RFC 9449 §4.1
 * @spec RFC 9449 §4.3
 * @throws {DpopError} `invalid_dpop_proof`: ヘッダーが複数あるとき、一つの JWT でないとき
 */
export function readDpopProofHeader(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value.includes(',')) {
    throw invalidProof('More than one DPoP header is not allowed');
  }
  if (value === '' || /\s/.test(value)) {
    throw invalidProof('The DPoP header is not a single JWT');
  }
  return value;
}

/**
 * DPoP proof を JWS のコンパクト形式として分解し、ヘッダー、クレーム、署名の対象と署名を返す。
 *
 * `.` で区切った三つのセグメントからなり、ヘッダーとペイロードが JSON のオブジェクトで、署名のセグメントが空でないものだけを受け付ける。
 * ヘッダーは、`typ` が `dpop+jwt`（メディアタイプなので大文字と小文字を区別しない。RFC 7515 §4.1.9）で、文字列の `alg` と `jwk` を持たなければならない。
 * ヘッダーの `crit`（RFC 7515 §4.1.11）は、この実装が理解する拡張が無いので、あれば拒否する。
 * 署名は検証しないので、返したクレームは {@link verifyDpopProofSignature} が通るまで信用しない。
 *
 * @spec RFC 9449 §4.2
 * @spec RFC 9449 §4.3
 * @spec RFC 7515 §7.1
 * @throws {DpopError} `invalid_dpop_proof`: 形式が正しくないとき
 */
export function decodeDpopProof(proof: string): DecodedDpopProof {
  const segments = proof.split('.');
  if (segments.length !== 3) {
    throw invalidProof('The DPoP proof is not a JWS in the compact serialization');
  }
  const [headerSegment = '', payloadSegment = '', signature = ''] = segments;
  const header = decodeJsonObject(headerSegment);
  const claims = decodeJsonObject(payloadSegment);
  if (header === undefined || claims === undefined || signature === '' || decodeBase64Url(signature) === undefined) {
    throw invalidProof('The DPoP proof is not a JWS in the compact serialization');
  }
  if (typeof header.typ !== 'string' || header.typ.toLowerCase() !== DPOP_PROOF_TYPE) {
    throw invalidProof('The DPoP proof typ header must be dpop+jwt');
  }
  if (typeof header.alg !== 'string') {
    throw invalidProof('The DPoP proof has no alg header');
  }
  if (!('jwk' in header)) {
    throw invalidProof('The DPoP proof has no jwk header');
  }
  if ('crit' in header) {
    throw invalidProof('The DPoP proof has a crit header this server does not understand');
  }
  return {
    header,
    claims,
    alg: header.alg,
    jwk: header.jwk,
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature,
  };
}

/**
 * DPoP proof の `alg` が、OP の受け付ける非対称鍵の署名であることを確かめる。
 *
 * `acceptedAlgs` は OP が DPoP proof に受け付ける alg（discovery の `dpop_signing_alg_values_supported`）で、この実装が検証できない値は含めても受け付けない。
 * `none` と MAC（HS 系）は、`acceptedAlgs` に含めても受け付けない。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §5.1
 * @throws {DpopError} `invalid_dpop_proof`: `alg` を受け付けないとき
 */
export function validateDpopProofAlg(alg: string, acceptedAlgs: readonly string[]): void {
  if (!isSupportedDpopSigningAlg(alg) || !acceptedAlgs.includes(alg)) {
    throw invalidProof('The DPoP proof alg is not supported');
  }
}

/**
 * DPoP proof の署名を、`jwk` ヘッダーの公開鍵で検証する。
 *
 * `jwk` は `validateDpopProofJwk()` が公開鍵であることを確かめた値を渡す。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 7515 §5.2
 * @throws {DpopError} `invalid_dpop_proof`: 署名を検証できないとき
 */
export async function verifyDpopProofSignature(
  decoded: Pick<DecodedDpopProof, 'alg' | 'signingInput' | 'signature'>,
  jwk: DpopPublicJwk,
): Promise<void> {
  const signature = decodeBase64Url(decoded.signature);
  if (signature === undefined || !(await verifyJwsSignature(jwk, decoded.alg, decoded.signingInput, signature))) {
    throw invalidProof('The DPoP proof signature is invalid');
  }
}

/**
 * DPoP proof の `jti`、`htm`、`htu`、`iat` を確かめ、`jti` の消費に使う値を返す。
 *
 * 次をすべて満たすときだけ受け付ける。
 * - `jti` が空でない文字列である
 * - `htm` がリクエストの HTTP メソッドと同じである
 * - `htu` が、リクエストの URI とクエリとフラグメントを除いて同じである（どちらも {@link normalizeDpopHtu} で正規化して比べる）
 * - `iat` が数値で、`now - maxAgeSeconds - leewaySeconds` 以上、`now + leewaySeconds` 以下である
 *
 * `nonce` は、この OP が nonce を発行しない（RFC 9449 §8 に対応していない）ので確かめない。
 *
 * @spec RFC 9449 §4.2
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §11.1
 * @throws {DpopError} `invalid_dpop_proof`: どれかを満たさないとき
 */
export function validateDpopProofClaims(
  claims: Record<string, unknown>,
  policy: DpopProofClaimsPolicy,
): ValidatedDpopProofClaims {
  const maxAge = policy.maxAgeSeconds ?? DEFAULT_DPOP_PROOF_MAX_AGE_SECONDS;
  const leeway = policy.leewaySeconds ?? DEFAULT_DPOP_PROOF_LEEWAY_SECONDS;
  const { jti, htm, htu, iat } = claims;
  if (typeof jti !== 'string' || jti === '') {
    throw invalidProof('The DPoP proof has no jti claim');
  }
  if (htm !== policy.method) {
    throw invalidProof('The DPoP proof htm claim does not match the request method');
  }
  const expected = normalizeDpopHtu(policy.uri);
  if (typeof htu !== 'string' || expected === undefined || normalizeDpopHtu(htu) !== expected) {
    throw invalidProof('The DPoP proof htu claim does not match the request URI');
  }
  if (typeof iat !== 'number' || !Number.isFinite(iat)) {
    throw invalidProof('The DPoP proof has no iat claim');
  }
  if (iat > policy.now + leeway || iat < policy.now - maxAge - leeway) {
    throw invalidProof('The DPoP proof iat claim is not within the acceptable window');
  }
  // 受け付ける最後の秒（`now` が `iat + maxAge + leeway` 以下の整数）の次の秒までを、`jti` を覚える期間にする。
  // `jti` のストアは期限の時刻になった `jti` を忘れてよい（`DpopProofJtiStore`）ので、最後の秒を期限にすると、その秒の再利用を見逃す。
  return { jti, iat, replayWindowEndsAt: Math.floor(iat + maxAge + leeway) + 1 };
}

/**
 * アクセストークンの `ath`（ASCII のアクセストークンの SHA-256 を base64url にした値）を返す。
 *
 * @spec RFC 9449 §4.2
 */
export async function computeDpopAccessTokenHash(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken));
  return encodeBase64Url(digest);
}

/**
 * 保護されたリソースへの DPoP proof の `ath` が、一緒に提示されたアクセストークンのハッシュであることを確かめる。
 *
 * トークンエンドポイントへの DPoP proof には呼ばない（`ath` はアクセストークンと一緒に送る DPoP proof だけのクレームである）。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §7
 * @throws {DpopError} `invalid_dpop_proof`: `ath` がないとき、アクセストークンのハッシュと違うとき
 */
export async function validateDpopProofAccessTokenHash(
  claims: Record<string, unknown>,
  accessToken: string,
): Promise<void> {
  if (typeof claims.ath !== 'string' || claims.ath !== (await computeDpopAccessTokenHash(accessToken))) {
    throw invalidProof('The DPoP proof ath claim does not match the access token');
  }
}

/**
 * DPoP proof の `jti` を消費し、使用済みなら拒否する。
 *
 * キーは、DPoP proof の鍵の JWK Thumbprint と `jti` の組の JSON（`["dpop", jkt, jti]`）である。
 * 先頭の `"dpop"` で、同じストアを使う private_key_jwt の `jti` のキー（`[clientId, jti]`）と重ならないようにする。
 * 署名とクレームを確かめた後で呼ぶ。検証できない DPoP proof の `jti` を覚えると、正しいクライアントの `jti` を先に使わせる妨害ができるためである。
 *
 * @spec RFC 9449 §11.1
 * @throws {DpopError} `invalid_dpop_proof`: 同じ `jti` の DPoP proof がすでに使われたとき
 */
export async function consumeDpopProofJti(
  store: DpopProofJtiStore,
  proof: { jkt: string; jti: string; replayWindowEndsAt: number },
): Promise<void> {
  const first = await store.consume(JSON.stringify(['dpop', proof.jkt, proof.jti]), proof.replayWindowEndsAt);
  if (!first) {
    throw invalidProof('The DPoP proof has already been used');
  }
}

/**
 * JWT のセグメントを base64url として復号し、JSON のオブジェクトとして返す。
 *
 * 復号できないとき、UTF-8 として読めないとき、JSON のオブジェクト（配列と `null` を除く）でないときは `undefined` を返す。
 */
function decodeJsonObject(segment: string): Record<string, unknown> | undefined {
  const bytes = decodeBase64Url(segment);
  if (bytes === undefined || bytes.length === 0) return undefined;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined;
    return decoded as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * DPoP proof の不備を表す `invalid_dpop_proof` のエラーを返す。
 *
 * @spec RFC 9449 §5
 * @spec RFC 9449 §7.1
 */
function invalidProof(description: string): DpopError {
  return new DpopError('invalid_dpop_proof', description);
}
