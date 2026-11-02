import { getJwaAlgorithm, type SigningKey } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'collect-signing-algorithms',
  endpoint: 'discovery',
  kind: 'resolve',
  label: '公開する署名アルゴリズムを集める',
  spec: 'OIDC Core 1.0 §15.1 / §5.3.2',
  function: 'collectAdvertisedSigningKeys',
  consumes: [],
  produces: ['idTokenSigningKeys', 'userinfoSigningAlgValues'],
  removable: false,
});

/**
 * 公開する署名鍵とアルゴリズムを集めて返す。
 *
 * 返すのは、ID トークンの署名鍵の `CryptoKey` と、UserInfo の署名アルゴリズムの一覧（重複を除いたもの）である。
 * `buildProviderMetadata()` は、ID トークンの署名鍵から `id_token_signing_alg_values_supported` を求める（OIDC Core 1.0 §15.1）。
 * UserInfo の署名アルゴリズムは `userinfo_signing_alg_values_supported` になる（OIDC Core 1.0 §5.3.2）。
 * どちらの鍵もリクエストコンテキストから読み、設定されていなければ空の配列にする。
 *
 * @spec OIDC Core 1.0 §15.1
 * @spec OIDC Core 1.0 §5.3.2
 */
export function collectAdvertisedSigningKeys(c: any): {
  idTokenSigningKeys: CryptoKey[];
  userinfoSigningAlgValues: string[];
} {
  // `id_token_signing_alg_values_supported` は、実際に登録した鍵の集合から求める（OIDC Core 1.0 §15.1）。
  // RS256 の鍵があることは `buildProviderMetadata()` が確かめる。
  // 登録したすべての ID トークンの鍵のアルゴリズムを集めるので、RS256 と ES256 が混在する鍵の集合も正しく公開できる。
  const idTokenSigningKeyArr = (c.get('idTokenSigningKeys') as SigningKey[] | undefined) ?? [];
  const idTokenSigningKeys: CryptoKey[] = idTokenSigningKeyArr.map((k) => k.privateKey);

  // 登録した UserInfo の鍵の集合（RS256、ES256 など）から、OP が実際に署名できるアルゴリズムを求めて公開する（OIDC Core 1.0 §5.3.2、OIDC Discovery 1.0 §3）。
  // `userinfo_signed_response_alg` を使うクライアントは、メタデータの値をそのまま信頼できる。
  const userinfoSigningKeyArr = (c.get('userinfoSigningKeys') as SigningKey[] | undefined) ?? [];
  const userinfoSigningAlgValues = [
    ...new Set(userinfoSigningKeyArr.map((k) => getJwaAlgorithm(k.privateKey))),
  ];
  return { idTokenSigningKeys, userinfoSigningAlgValues };
}
