import { signingKeysToJwkSet, type JwkSet, type SigningKey } from '@maronn-openid-connect/core';

/**
 * ID トークンの検証鍵を、渡されたプロバイダか OP の署名鍵から読んで返す。
 *
 * 既定の振る舞いをコンテキストのコールバックに隠さず、使うエンドポイントから呼ぶ。
 * 独自のプロバイダと署名鍵がどちらも無ければ undefined を返す。
 */
export async function idTokenHintJwks(c: any): Promise<JwkSet | undefined> {
  const provider: (() => Promise<JwkSet> | JwkSet) | undefined = c.get('jwksProvider');
  if (provider !== undefined) return provider();
  const keys: SigningKey[] | undefined = c.get('idTokenSigningKeys');
  if (keys === undefined) return undefined;
  return signingKeysToJwkSet(keys);
}
