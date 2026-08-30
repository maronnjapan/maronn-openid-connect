/**
 * Identity Assertion Authorization Grant (ID-JAG) — エラー型
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 発行側（IdP、Token Exchange 分岐）と受領側（リソース AS、jwt-bearer 分岐）の
 * 両方がこのエラーを投げる。どちらもバックチャネル専用（リダイレクトは存在
 * しない）で、常に 400 + JSON で返す。401 になるのはクライアント認証失敗
 * （`invalid_client`）だけであり、それは分岐より前の共有認証パイプライン
 * （core の `TokenError`）が担当する。
 *
 * core の `TokenErrorCode` は closed な enum で `invalid_target` を含まないため、
 * core 無変更の制約下では core の `TokenError` に相乗りできない
 * （token-exchange 機能の `TokenExchangeError` と同じ帰結）。
 */
import { sanitizeErrorDescription } from '@maronn-openid-connect/core';

/**
 * ID-JAG のエラーコード。
 *
 * - 発行側（RFC 8693 §2.2.2 / RFC 6749 §5.2）: invalid_request /
 *   unauthorized_client / invalid_scope / invalid_target
 * - 受領側（RFC 7521 §4.1）: assertion の不備は invalid_grant、それ以外は
 *   invalid_request / unauthorized_client / invalid_scope
 */
export type IdJagErrorCode =
  | 'invalid_request'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'invalid_scope'
  | 'invalid_target';

export class IdJagError extends Error {
  readonly code: IdJagErrorCode;
  readonly errorDescription: string;

  constructor(code: IdJagErrorCode, errorDescription: string) {
    // RFC 6749 §5.2: error_description は安全な文字集合に限定する。
    const sanitized = sanitizeErrorDescription(errorDescription);
    super(sanitized);
    this.name = 'IdJagError';
    this.code = code;
    this.errorDescription = sanitized;
  }

  /** 本エラーは常に 400（401 は分岐前の共有パイプラインが返す）。 */
  get statusCode(): 400 {
    return 400;
  }
}

/**
 * 発行側で subject_token（ID トークン）の検証に失敗したときの固定 error_description。
 *
 * 署名不正・iss 不一致・aud（クライアント）不一致・期限切れ・構造不正を区別しない。
 * 応答からトークンの有効性を推測できる「オラクル」を作らないための意図的な設計で、
 * token-exchange 機能の subject_token 解決失敗と同じ方針（文言も同一）。
 */
export const SUBJECT_TOKEN_INVALID_DESCRIPTION =
  'The provided subject_token is not valid';

/**
 * 受領側で「iss が信頼リスト外」と「署名検証失敗」の両方に使う固定 error_description。
 *
 * 両者を区別すると、応答の違いから信頼済み IdP のリストを外部から探索できて
 * しまう（ID-JAG draft §9.4 が discovery でのリスト開示を禁じるのと同じ趣旨）。
 */
export const ASSERTION_UNTRUSTED_DESCRIPTION =
  'The assertion issuer is not trusted or the assertion signature is invalid';
