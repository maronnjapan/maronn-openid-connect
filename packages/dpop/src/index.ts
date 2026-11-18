/**
 * OAuth 2.0 Demonstrating Proof of Possession（DPoP、RFC 9449）を、
 * `@maronn-openid-connect/core` で組んだ OpenID Provider に加える拡張。
 *
 * クライアントは、リクエストごとに自分の鍵で署名した DPoP proof を `DPoP` ヘッダーで送る。
 * OP は、トークンエンドポイントで DPoP proof を検査し、発行するアクセストークンをその鍵に束縛する（`token_type` は `DPoP`、
 * アクセストークンの `cnf.jkt` は鍵の JWK Thumbprint）。
 * 保護されたリソース（UserInfo エンドポイント）は、`Authorization: DPoP <token>` と `ath` を入れた DPoP proof を受け取り、
 * トークンが DPoP proof の鍵に束縛されていることを確かめる。
 *
 * 単体で使うパッケージではない。CLI 生成コードの DPoP の機能（`maronn-oidc generate <framework> --enable dpop`）が、
 * トークンエンドポイント、UserInfo エンドポイント、認可エンドポイントなどのステップからこの関数を順に呼ぶ想定で API を切っている。
 * 検査は Web Crypto だけで行い、Node.js の API に依存しないので、エッジランタイムでも動く。
 * core には依存しない（core のエラー型も使わない）。失敗は `DpopError` で投げ、生成コードがエンドポイントのエラーレスポンスにする。
 */

export { DpopError, isDpopError, type DpopErrorCode } from './errors.js';

export {
  // DPoP proof の検査（RFC 9449 §4.3）
  readDpopProofHeader,
  decodeDpopProof,
  validateDpopProofAlg,
  verifyDpopProofSignature,
  validateDpopProofClaims,
  validateDpopProofAccessTokenHash,
  computeDpopAccessTokenHash,
  consumeDpopProofJti,
  DPOP_PROOF_TYPE,
  DEFAULT_DPOP_PROOF_MAX_AGE_SECONDS,
  DEFAULT_DPOP_PROOF_LEEWAY_SECONDS,
  type DecodedDpopProof,
  type DpopProofClaimsPolicy,
  type ValidatedDpopProofClaims,
  type DpopProofJtiStore,
} from './proof.js';

export {
  // DPoP proof の公開鍵と JWK Thumbprint（RFC 9449 §4.2 / §6.1、RFC 7638）
  validateDpopProofJwk,
  computeJwkThumbprint,
  isSupportedDpopSigningAlg,
  SUPPORTED_DPOP_SIGNING_ALGS,
  type DpopPublicJwk,
  type DpopSigningAlg,
} from './jwk.js';

export { normalizeDpopHtu } from './htu.js';

export {
  // トークンと認可コードの鍵への束縛（RFC 9449 §5 / §6 / §10）
  buildDpopConfirmation,
  readDpopJkt,
  parseDpopJkt,
  resolvePushedDpopJkt,
  requireDpopProofForClient,
  validateDpopBoundGrant,
  selectDpopRefreshTokenJkt,
  DPOP_TOKEN_TYPE,
  type DpopConfirmation,
} from './binding.js';

export {
  // 保護されたリソース（RFC 9449 §7）
  readDpopAuthorization,
  validateDpopAccessTokenBinding,
  buildDpopChallenge,
  DPOP_AUTHENTICATION_SCHEME,
  type DpopChallenge,
} from './resource.js';
