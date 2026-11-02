import {
  resolveAcrAmr,
  type AcrResolver,
  type ValidatedTokenRequest,
  selectPreferredAcr,
  selectRequestedAcrValues,
} from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'resolve-acr-amr',
  endpoint: 'token',
  kind: 'resolve',
  label: 'トークンに含める acr と amr を決める',
  spec: 'OIDC Core 1.0 §3.1.2.1 / §12.1 / RFC 9068 §2.2.1',
  function: 'resolveTokenAcrAmr',
  consumes: ['subject', 'validatedRequest'],
  produces: ['acr', 'amr'],
  removable: true,
  fallback: true,
});

/**
 * トークンに入れる `acr` と `amr` を決めて返す。
 *
 * ID トークンには両方を、アクセストークンには `acr` を入れ、エンドユーザーがどう認証されたかをリソースサーバーが判断できるようにする（RFC 9068 §2.2.1）。
 *
 * 値はグラントタイプによって次のように決める。
 * - `authorization_code`: アプリのオプションの `acrResolver` が、クライアントが要求した `acr` の値（`acr_values`、なければ `claims.id_token.acr.values`。OIDC Core 1.0 §5.5.1.1）から決める。
 *   `acrResolver` がなければ、要求された値のうち最も優先する値を `acr` にして `amr` は入れず、要求がなければ `acr` も入れない。
 * - `refresh_token`: 最初の認証のときの `acr` と `amr` を引き継ぎ、リゾルバには問い合わせない（OIDC Core 1.0 §12.1）。
 *
 * @spec OIDC Core 1.0 §2
 * @spec OIDC Core 1.0 §3.1.2.1
 * @spec OIDC Core 1.0 §12.1
 */
export async function resolveTokenAcrAmr(
  c: any,
  input: { subject: string; validatedRequest: ValidatedTokenRequest },
): Promise<{ acr: string | undefined; amr: string[] | undefined }> {
  const { subject, validatedRequest } = input;
  if (validatedRequest.grantType === 'refresh_token') {
    return { acr: validatedRequest.acr, amr: validatedRequest.amr };
  }

  // クライアントが要求した `acr` の値（優先する順に空白で区切った文字列）を取り出す。
  const requestedAcrValues = selectRequestedAcrValues(validatedRequest.acrValues, validatedRequest.claims);

  const acrResolver = c.get('acrResolver') as AcrResolver | undefined;
  if (acrResolver !== undefined) {
    const { acr, amr } = await resolveAcrAmr({
      subject,
      clientId: validatedRequest.clientId,
      requestedAcrValues,
      acrResolver,
    });
    return { acr, amr };
  }

  // `acrResolver` がなければ、要求された値のうち最も優先する `acr` をそのままトークンに入れ、`amr` は入れない。
  // この値はリクエストを信じただけのものなので、リソースサーバーがこの値に頼る前に、ログインが実際に満たした `acr` を返す `acrResolver` を渡す。
  return { acr: selectPreferredAcr(requestedAcrValues), amr: undefined };
}
