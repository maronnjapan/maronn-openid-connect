/**
 * EXTENSION (dpop): the checks of the DPoP proof sent with a request
 * (RFC 9449 §4.3). An endpoint that accepts DPoP passes the proof of its DPoP
 * header, read by readDpopProofHeader(), and the method and the path of the
 * request to verifyDpopRequestProof(), with the server whose nonce the proof
 * must carry (nonce.ts) where the endpoint requires a nonce.
 *
 * DPoP proof JWT の検査（RFC 9449 §4.3）。
 *
 * クライアントは、リクエストごとに新しい DPoP proof（`typ` が `dpop+jwt` の JWT）を作り、`DPoP` ヘッダーで送る。
 * 検査は責務ごとの関数に分けてあり、次の順に呼ぶ（2. 以降は {@link verifyDpopRequestProof} が呼ぶ。順序は入れ替えてもよい。RFC 9449 §4.3）。
 * 検査の方針を変えるときは、ここの関数を直接直せる。
 * 1. {@link readDpopProofHeader}: `DPoP` ヘッダーが一つだけであることを確かめる
 * 2. {@link decodeDpopProof}: JWS のコンパクト形式を分解し、`typ` と JOSE ヘッダーを確かめる
 * 3. {@link validateDpopProofAlg}: `alg` が OP の受け付ける非対称鍵の署名であることを確かめる
 * 4. `validateDpopProofJwk()` と {@link verifyDpopProofSignature}: `jwk` が公開鍵であることと、その鍵で署名を検証できることを確かめる
 * 5. {@link validateDpopProofClaims}: `jti`、`htm`、`htu`、`iat` を確かめる
 * 6. {@link validateDpopProofNonce}: nonce を求めるエンドポイントでは、`nonce` がそのサーバーの最近発行した nonce であることを確かめる
 * 7. {@link validateDpopProofAccessTokenHash}: 保護されたリソースへのリクエストでは `ath` を確かめる
 * 8. {@link consumeDpopProofJti}: `jti` を覚え、同じ DPoP proof の再利用を拒否する
 *
 * nonce の失敗は `use_dpop_nonce` の、ほかの失敗は `invalid_dpop_proof` の `DpopError` になる（RFC 9449 §5 / §7.1 / §8 / §9）。
 */
import type { ProviderConfig } from '../../config.js';
import { decodeBase64Url, encodeBase64Url } from './base64url.js';
import { dpopSigningAlgsOf } from './config.js';
import { DpopError } from './errors.js';
import { normalizeDpopHtu } from './htu.js';
import { computeJwkThumbprint, isSupportedDpopSigningAlg, validateDpopProofJwk, verifyJwsSignature, type DpopPublicJwk } from './jwk.js';
import { dpopNonceKeyOf, verifyDpopNonce, type DpopNonceScope, type DpopNonceServer, type DpopNoncePolicy } from './nonce.js';

/** The request a DPoP proof was sent with. */
export interface DpopProofTarget {
  /** The HTTP method of the request (compared with htm). */
  method: string;
  /** The path of the endpoint under the issuer, such as /token (compared with htu, without the query and the fragment). */
  path: string;
  /** The access token sent with the proof to a protected resource (compared with ath); undefined at the token and PAR endpoints. */
  accessToken?: string;
  /**
   * The server whose nonce the proof must carry, for an endpoint that
   * requires a nonce (RFC 9449 §8 / §9): 'authorization-server' at the token
   * and PAR endpoints, 'resource-server' at a protected resource. Left out,
   * the nonce claim is not checked.
   */
  nonceServer?: DpopNonceServer;
}

/**
 * リクエストの DPoP proof を検査し、その鍵の JWK Thumbprint を返す。
 *
 * 次の順に検査の関数を呼ぶ（RFC 9449 §4.3）。
 * 1. JWS を分解し、`typ` が `dpop+jwt`（またはそれと同じ型の `application/dpop+jwt`）であることと JOSE ヘッダーを確かめる（`decodeDpopProof()`）
 * 2. `alg` が設定の `dpopSigningAlgValuesSupported` のうちこの実装が検証できるものであることを確かめる（`validateDpopProofAlg()`）
 * 3. `jwk` が `alg` の公開鍵であることを確かめ、その鍵で署名を検証する（`validateDpopProofJwk()`、`verifyDpopProofSignature()`）
 * 4. `jti`、`htm`、`htu`、`iat` を確かめる（`validateDpopProofClaims()`）。`htu` は、プロキシの後ろでもクライアントが見る URL と比べられるよう、リクエストの URL ではなく issuer とエンドポイントのパスから組み立てる（`endpointUrisOf()`）。`iat` の範囲は設定の `dpopProofMaxAgeSeconds` と `dpopProofLeewaySeconds` で決まる
 * 5. `target.nonceServer` があれば、`nonce` がそのサーバーの最近発行した nonce であることを確かめる（`validateDpopProofNonce()`）。nonce の鍵は `OidcProviderOptions.dpopNonceSecret` の秘密（dpop の機能がリクエストコンテキストの `dpopNonceSecret` に入れる）から作り（`dpopNonceKeyOf()`）、受け付ける期間は設定の `dpopNonceLifetimeSeconds` で決まる
 * 6. 保護されたリソースへのリクエストでは、`ath` がアクセストークンのハッシュであることを確かめる（`validateDpopProofAccessTokenHash()`）
 * 7. `jti` を消費し、同じ DPoP proof の再利用を拒否する（`consumeDpopProofJti()`）
 *
 * `jti` を覚えるストアには、private_key_jwt のクライアントアサーションの `jti` を覚えるストア（`clientAssertionJtiStore`）を使う。
 * キーの形が違う（DPoP は `["dpop", jkt, jti のハッシュ]`）ので、二つの `jti` が重なることはない。
 * nonce は `jti` を消費する前に確かめるので、nonce を受け付けない DPoP proof の `jti` は、ほかの検査で拒否した DPoP proof と同じく覚えない。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §8
 * @spec RFC 9449 §9
 * @spec RFC 9449 §11.1
 * @throws {DpopError} `invalid_dpop_proof`: DPoP proof を受け付けないとき
 * @throws {DpopError} `use_dpop_nonce`: `target.nonceServer` があり、`nonce` がそのサーバーの最近発行した nonce でないとき
 * @throws {Error} 設定の `dpopProofMaxAgeSeconds` か `dpopProofLeewaySeconds` が 0 以上の有限の数でないとき、nonce を確かめるのに秘密が 32 バイトより短いか `dpopNonceLifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り）
 */
export async function verifyDpopRequestProof(c: any, proof: string, target: DpopProofTarget): Promise<string> {
  const config: ProviderConfig = c.get('config');
  const decoded = decodeDpopProof(proof);
  validateDpopProofAlg(decoded.alg, dpopSigningAlgsOf(config));
  const jwk = validateDpopProofJwk(decoded.jwk, decoded.alg);
  await verifyDpopProofSignature(decoded, jwk);
  const now = Math.floor(Date.now() / 1000);
  const claims = validateDpopProofClaims(decoded.claims, {
    method: target.method,
    uris: endpointUrisOf(config.issuer, target.path),
    now,
    maxAgeSeconds: config.dpopProofMaxAgeSeconds,
    leewaySeconds: config.dpopProofLeewaySeconds,
  });
  if (target.nonceServer !== undefined) {
    await validateDpopProofNonce(
      decoded.claims,
      await dpopNonceKeyOf(c.get('dpopNonceSecret')),
      { server: target.nonceServer, issuer: config.issuer },
      { now, lifetimeSeconds: config.dpopNonceLifetimeSeconds },
    );
  }
  if (target.accessToken !== undefined) {
    await validateDpopProofAccessTokenHash(decoded.claims, target.accessToken);
  }
  const jkt = await computeJwkThumbprint(jwk);
  // 署名とクレームを確かめた後で消費する。検証できない DPoP proof の `jti` を覚えると、正しいクライアントの `jti` を先に使わせる妨害ができるためである。
  await consumeDpopProofJti(c.get('clientAssertionJtiStore'), { jkt, jti: claims.jti, replayWindowEndsAt: claims.replayWindowEndsAt });
  return jkt;
}

/** DPoP proof の JOSE ヘッダーの `typ` として受け付ける値（小文字にして比べる。RFC 9449 §4.2、RFC 7515 §4.1.9）。 */
const DPOP_PROOF_TYPES: readonly string[] = ['dpop+jwt', 'application/dpop+jwt'];

/** DPoP proof の `jti` の長さ（文字列の `length`）の上限。これより長い `jti` は拒否する（RFC 9449 §11.1）。 */
const MAX_DPOP_PROOF_JTI_LENGTH = 256;

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
   * DPoP proof を受け取ったエンドポイントの URI（`htu` と比べ、どれか一つと同じなら受け付ける）。
   * クエリとフラグメントは比較に使わない。
   * プロキシの後ろでもクライアントが見る URI と一致するよう、OP の issuer から組み立てた URL を渡す。
   */
  uris: readonly string[];
  /** 現在時刻（Unix epoch 秒） */
  now: number;
  /** `iat` から DPoP proof を受け付ける秒数（0 以上の有限の数。時計のずれの `leewaySeconds` は別に足す） */
  maxAgeSeconds: number;
  /** 時計のずれとして許す秒数（0 以上の有限の数） */
  leewaySeconds: number;
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
   * 期限の時刻になった `key` は忘れてよい。
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
 * ヘッダーは、`typ` が `dpop+jwt` で、文字列の `alg` と `jwk` を持たなければならない。
 * `typ` はメディアタイプなので大文字と小文字を区別せず、`application/` を付けた `application/dpop+jwt` も同じ型として受け付ける（RFC 7515 §4.1.9）。
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
  if (typeof header.typ !== 'string' || !DPOP_PROOF_TYPES.includes(header.typ.toLowerCase())) {
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
 * `acceptedAlgs` は OP が DPoP proof に受け付ける alg（`dpopSigningAlgsOf()` の値）で、この実装が検証できない値は含めても受け付けない。
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
 * - `jti` が空でない文字列で、{@link MAX_DPOP_PROOF_JTI_LENGTH} 文字より長くない
 * - `htm` がリクエストの HTTP メソッドと同じである
 * - `htu` が、エンドポイントの URI のどれかと、クエリとフラグメントを除いて同じである（どちらも {@link normalizeDpopHtu} で正規化して比べる）
 * - `iat` が数値で、`now - maxAgeSeconds - leewaySeconds` 以上、`now + leewaySeconds` 以下である
 *
 * `nonce` は確かめない（nonce を求めるエンドポイントでは {@link validateDpopProofNonce} が確かめる）。
 * `maxAgeSeconds` か `leewaySeconds` が 0 以上の有限の数でない（設定に無い `undefined`、`NaN`、負の数など）ときは、範囲を決められないので、クレームを確かめずに `Error` を投げる。
 * `undefined` や `NaN` のままでは `iat` の比較がどれも偽になり、どの `iat` も受け付けて、`jti` を覚える期限も無くなるためである。
 *
 * @spec RFC 9449 §4.2
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §11.1
 * @throws {DpopError} `invalid_dpop_proof`: どれかを満たさないとき
 * @throws {Error} `maxAgeSeconds` か `leewaySeconds` が 0 以上の有限の数でないとき（設定の誤り）
 */
export function validateDpopProofClaims(
  claims: Record<string, unknown>,
  policy: DpopProofClaimsPolicy,
): ValidatedDpopProofClaims {
  const { maxAgeSeconds: maxAge, leewaySeconds: leeway } = policy;
  if (![maxAge, leeway].every((seconds) => Number.isFinite(seconds) && seconds >= 0)) {
    throw new Error('The iat window of the DPoP proof checks (dpopProofMaxAgeSeconds, dpopProofLeewaySeconds) must be non-negative finite numbers');
  }
  const { jti, htm, htu, iat } = claims;
  if (typeof jti !== 'string' || jti === '') {
    throw invalidProof('The DPoP proof has no jti claim');
  }
  // RFC 9449 §11.1: 必要以上に大きな `jti` の DPoP proof は受け付けない。
  if (jti.length > MAX_DPOP_PROOF_JTI_LENGTH) {
    throw invalidProof('The DPoP proof jti claim is too long');
  }
  if (htm !== policy.method) {
    throw invalidProof('The DPoP proof htm claim does not match the request method');
  }
  const presented = typeof htu === 'string' ? normalizeDpopHtu(htu) : undefined;
  if (presented === undefined || !policy.uris.some((uri) => normalizeDpopHtu(uri) === presented)) {
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

/** {@link validateDpopProofNonce} が拒否するときの `error_description`（無いときは RFC 9449 Figure 20 / Figure 24 の文）。 */
const DPOP_NONCE_DESCRIPTIONS: Readonly<Record<DpopNonceServer, { missing: string; stale: string }>> = {
  'authorization-server': {
    missing: 'Authorization server requires nonce in DPoP proof',
    stale: 'The DPoP proof nonce is not a nonce the authorization server recently provided',
  },
  'resource-server': {
    missing: 'Resource server requires nonce in DPoP proof',
    stale: 'The DPoP proof nonce is not a nonce the resource server recently provided',
  },
};

/**
 * DPoP proof の `nonce` が、`scope` のサーバーが `key` で最近発行した nonce であることを確かめる。
 *
 * `nonce` が無いときと、文字列でないとき、そのサーバーが発行した nonce でないとき、`policy.lifetimeSeconds` より古いとき（`verifyDpopNonce()`）は拒否する。
 * nonce を求めるサーバーは、`nonce` の無い DPoP proof を受け付けない（RFC 9449 §11.3）。
 * 拒否には、そのサーバーの新しい nonce を入れてやり直すよう求める `use_dpop_nonce` を使う（RFC 9449 §8 / §9）。
 *
 * @spec RFC 9449 §4.3
 * @spec RFC 9449 §8
 * @spec RFC 9449 §9
 * @spec RFC 9449 §11.3
 * @throws {DpopError} `use_dpop_nonce`: `nonce` を受け付けないとき
 * @throws {Error} `policy.lifetimeSeconds` が 0 以上の有限の数でないとき（設定の誤り）
 */
export async function validateDpopProofNonce(
  claims: Record<string, unknown>,
  key: CryptoKey,
  scope: DpopNonceScope,
  policy: DpopNoncePolicy,
): Promise<void> {
  const descriptions = DPOP_NONCE_DESCRIPTIONS[scope.server];
  if (!('nonce' in claims)) {
    throw new DpopError('use_dpop_nonce', descriptions.missing);
  }
  if (typeof claims.nonce !== 'string' || !(await verifyDpopNonce(key, claims.nonce, scope, policy))) {
    throw new DpopError('use_dpop_nonce', descriptions.stale);
  }
}

/**
 * アクセストークンの `ath`（ASCII のアクセストークンの SHA-256 を base64url にした値）を返す。
 *
 * @spec RFC 9449 §4.2
 */
export async function computeDpopAccessTokenHash(accessToken: string): Promise<string> {
  return sha256Base64Url(accessToken);
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
 * キーは、DPoP proof の鍵の JWK Thumbprint と、`jti` の SHA-256 の base64url の組の JSON（`["dpop", jkt, hash]`）である。
 * `jti` の代わりにそのハッシュを覚えるので、ストアのキーの長さは `jti` の長さによらない（RFC 9449 §11.1）。
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
  const key = JSON.stringify(['dpop', proof.jkt, await sha256Base64Url(proof.jti)]);
  const first = await store.consume(key, proof.replayWindowEndsAt);
  if (!first) {
    throw invalidProof('The DPoP proof has already been used');
  }
}

/**
 * issuer とエンドポイントのパスから、DPoP proof の `htu` と比べるエンドポイントの URI を返す。
 *
 * OP のメタデータはエンドポイントの URL を issuer にパスをつないで作るので、`/` で終わる issuer（`https://op.example.com/`）では、パスの `/` が重なる（`https://op.example.com//token`）。
 * そのときは、メタデータのとおりの URI と、`/` を重ねない URI（`https://op.example.com/token`）の両方を返す。
 * メタデータのとおりに送るクライアントも、エンドポイントのパスのとおりに送るクライアントも、同じエンドポイントへの `htu` として受け付けるためである。
 */
function endpointUrisOf(issuer: string, path: string): string[] {
  const advertised = `${issuer}${path}`;
  if (!issuer.endsWith('/') || !path.startsWith('/')) return [advertised];
  return [advertised, `${issuer.slice(0, -1)}${path}`];
}

/**
 * 文字列の UTF-8 の SHA-256 を、パディングのない base64url にして返す。
 */
async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return encodeBase64Url(digest);
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
