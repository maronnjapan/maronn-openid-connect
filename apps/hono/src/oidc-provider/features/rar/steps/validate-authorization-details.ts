import {
  AuthorizationError,
  type AuthorizationErrorCode,
  type ValidatedAuthorizationRequest,
} from '@maronn-openid-connect/core';
import {
  AUTHORIZATION_DETAILS_PARAM,
  RarError,
  parseAuthorizationDetailsInput,
  validateAuthorizationDetails,
  type AuthorizationDetail,
} from '@maronn-openid-connect/experimental/rar';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { step } from '../../../endpoints/step.js';
import { rarConfig } from '../config.js';

export const meta = step({
  id: 'validate-authorization-details',
  endpoint: 'authorize',
  feature: 'rar',
  kind: 'validate',
  label: 'authorization_details を検証し、同意を必須にする',
  spec: 'RFC 9396 §3 / §5',
  function: 'validateAuthorizationDetailsRequest',
  consumes: ['params', 'requestObjectClaims', 'validatedRequest'],
  optional: ['requestObjectClaims'],
  produces: ['authorizationDetails'],
  removable: false,
});

/**
 * `authorization_details` を検証して返し、details があるリクエストには同意画面を必須にする。
 *
 * パラメータは、Request Object の claim（あればクエリより優先。OIDC Core 1.0 §6.1 の
 * supersede 規則）、無ければクエリ / PAR 由来の `params` から読む。無ければ何もせず
 * `undefined` を返す。あれば構造（RFC 9396 §2 / §2.2）と上限（`rarConfig`）を検査し、
 * `config.rarTypes` の型定義と突き合わせる（§5。型定義が空ならすべて拒否）。
 *
 * details があるリクエストはエンドユーザーの同意を毎回要する（SSO の同意スキップは
 * scope 単位の記録しか持たず details を知らない）ので、`prompt=none` 単独なら
 * `consent_required` で拒否し、それ以外なら `validatedRequest.prompt` へ `consent` を
 * 加えて、silent / SSO の両経路を同意画面へ向ける。`none` が他の値と組む不正な
 * リクエストには手を出さず、base の `[validate-prompt-combination]` に委ねる。
 *
 * エラーの `error_description` は固定の ASCII 文言で、details の内容を反映しない
 * （RFC 9396 §13）。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §3
 * @spec RFC 9396 §5
 * @throws {AuthorizationError} `invalid_authorization_details`: 構造違反、上限超過、未知の type、型定義の検証違反のとき
 * @throws {AuthorizationError} `consent_required`: details 付きのリクエストが `prompt=none` 単独のとき
 */
export function validateAuthorizationDetailsRequest(
  c: any,
  input: {
    params: AuthorizationRequestInput;
    requestObjectClaims?: Record<string, unknown>;
    validatedRequest: ValidatedAuthorizationRequest;
  },
): AuthorizationDetail[] | undefined {
  const { params, requestObjectClaims, validatedRequest } = input;
  const raw = requestObjectClaims?.[AUTHORIZATION_DETAILS_PARAM] ?? params[AUTHORIZATION_DETAILS_PARAM];
  if (raw === undefined) return undefined;

  const config = c.get('config');
  let details: AuthorizationDetail[];
  try {
    details = parseAuthorizationDetailsInput(raw, {
      maxBytes: rarConfig.maxAuthorizationDetailsBytes,
      maxEntries: rarConfig.maxAuthorizationDetailsEntries,
    });
    validateAuthorizationDetails(details, config.rarTypes ?? []);
  } catch (error) {
    // 失敗の種類（構造、上限、未知 type、型定義の違反）によらず同じ固定文言にし、
    // details の値（金額、口座、type 名）をエラー経由で漏らさない（RFC 9396 §13）。
    if (error instanceof RarError) {
      throw new AuthorizationError(
        error.code as AuthorizationErrorCode,
        'The authorization_details parameter is invalid',
        validatedRequest.redirectUri,
        validatedRequest.state,
      );
    }
    throw error;
  }

  const promptValues = validatedRequest.prompt ?? [];
  if (promptValues.includes('none')) {
    // `none` 単独は、画面を出せないのに新規同意が要るので `consent_required`（OIDC Core 1.0 §3.1.2.1 の意味論）。
    // `none` と他の値の組み合わせは本機能の管轄外で、base の検査が `invalid_request` にする。
    if (promptValues.length === 1) {
      throw new AuthorizationError(
        'consent_required' as AuthorizationErrorCode,
        'authorization_details requires user consent',
        validatedRequest.redirectUri,
        validatedRequest.state,
      );
    }
    return details;
  }

  // details は毎回ユーザーに見せて承認させる。`prompt=consent` は OIDC Core 1.0
  // §3.1.2.1 の「consent MUST re-display」にそのまま乗り、silent / SSO の同意
  // スキップ（authenticate-silently / reuse-session）の両方がこの値で止まる。
  if (!promptValues.includes('consent')) {
    validatedRequest.prompt = [...promptValues, 'consent'];
  }
  return details;
}
