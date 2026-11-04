import {
  AuthorizationError,
  type AuthorizationErrorCode,
} from '@maronn-openid-connect/core';
import {
  AUTHORIZATION_DETAILS_PARAM,
  RarError,
  parseAuthorizationDetailsInput,
  validateAuthorizationDetails,
  type AuthorizationDetail,
  type AuthorizationDetailTypeDefinition,
} from '@maronn-openid-connect/experimental/rar';
import { rarConfig } from './config';
import { rarTransactionStore } from './store';

/**
 * `authorization_details` を検証し、details と同意を必須にした prompt を返す。
 *
 * パラメータは、Request Object の claim（あればクエリより優先。OIDC Core 1.0 §6.1 の
 * supersede 規則）、無ければクエリ / PAR 由来の `params` から読む。無ければ
 * `authorizationDetails` を `undefined`、`prompt` を受け取ったまま返す。あれば構造
 * （RFC 9396 §2 / §2.2）と上限（`rarConfig`）を検査し、`rarTypes` の型定義と
 * 突き合わせる（§5。型定義が空ならすべて拒否）。
 *
 * details があるリクエストはエンドユーザーの同意を毎回要する（SSO の同意スキップは
 * scope 単位の記録しか持たず details を知らない）ので、`prompt=none` 単独なら
 * `consent_required` で拒否し、それ以外なら返す prompt へ `consent` を加えて、
 * silent / SSO の両経路を同意画面へ向ける。`none` が他の値と組む不正なリクエストには
 * 手を出さず、受け取った prompt をそのまま返す（base の prompt 検査が拒否する）。
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
export function validateAuthorizationDetailsRequest(input: {
  params: Record<string, string>;
  requestObjectClaims?: Record<string, unknown>;
  prompt: string[] | undefined;
  redirectUri: string;
  state?: string;
  rarTypes: readonly AuthorizationDetailTypeDefinition[] | undefined;
}): { authorizationDetails: AuthorizationDetail[] | undefined; prompt: string[] | undefined } {
  const { params, requestObjectClaims, prompt, redirectUri, state, rarTypes } = input;
  const raw = requestObjectClaims?.[AUTHORIZATION_DETAILS_PARAM] ?? params[AUTHORIZATION_DETAILS_PARAM];
  if (raw === undefined) return { authorizationDetails: undefined, prompt };

  let details: AuthorizationDetail[];
  try {
    details = parseAuthorizationDetailsInput(raw, {
      maxBytes: rarConfig.maxAuthorizationDetailsBytes,
      maxEntries: rarConfig.maxAuthorizationDetailsEntries,
    });
    validateAuthorizationDetails(details, rarTypes ?? []);
  } catch (error) {
    // 失敗の種類（構造、上限、未知 type、型定義の違反）によらず同じ固定文言にし、
    // details の値（金額、口座、type 名）をエラー経由で漏らさない（RFC 9396 §13）。
    if (error instanceof RarError) {
      throw new AuthorizationError(
        error.code as AuthorizationErrorCode,
        'The authorization_details parameter is invalid',
        redirectUri,
        state,
      );
    }
    throw error;
  }

  const promptValues = prompt ?? [];
  if (promptValues.includes('none')) {
    // `none` 単独は、画面を出せないのに新規同意が要るので `consent_required`（OIDC Core 1.0 §3.1.2.1 の意味論）。
    // `none` と他の値の組み合わせは本機能の管轄外で、base の検査が `invalid_request` にする。
    if (promptValues.length === 1) {
      throw new AuthorizationError(
        'consent_required' as AuthorizationErrorCode,
        'authorization_details requires user consent',
        redirectUri,
        state,
      );
    }
    return { authorizationDetails: details, prompt };
  }

  // details は毎回ユーザーに見せて承認させる。`prompt=consent` は OIDC Core 1.0
  // §3.1.2.1 の「consent MUST re-display」にそのまま乗り、silent / SSO の同意
  // スキップの両方がこの値で止まる。
  return {
    authorizationDetails: details,
    prompt: promptValues.includes('consent') ? prompt : [...promptValues, 'consent'],
  };
}

/**
 * 検証済みの authorization details を、トランザクション ID をキーに保存する。
 *
 * details の無いリクエスト（`authorizationDetails` が `undefined`）では何もしない。
 * 保存の寿命は認可トランザクションと同じ（`transactionTtlSeconds`）で、同意まで
 * 進まなかったトランザクションの details はストアの失効で消える。
 *
 * 実験的な機能である。
 *
 * @spec RFC 9396 §3
 */
export async function recordAuthorizationDetails(
  transactionId: string,
  transactionTtlSeconds: number,
  authorizationDetails: AuthorizationDetail[] | undefined,
): Promise<void> {
  if (authorizationDetails === undefined) return;
  await rarTransactionStore.set(
    transactionId,
    authorizationDetails,
    Date.now() + transactionTtlSeconds * 1000,
  );
}
