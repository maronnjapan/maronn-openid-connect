import { generateRandomString } from '@maronn-openid-connect/core';
import { step } from '../../step.js';

export const meta = step({
  id: 'establish-session',
  endpoint: 'login',
  kind: 'persist',
  label: 'ブラウザに OP のセッションを確立する',
  spec: 'OIDC Core 1.0 §3.1.2.3',
  function: 'establishBrowserSession',
  consumes: ['user'],
  produces: ['sessionId', 'authTime'],
  removable: false,
});

/**
 * OP のセッションを保存し、その ID と認証時刻を返す。
 *
 * セッション ID は 32 バイトの乱数を base64url で表した文字列で、認証時刻は現在時刻を秒で表した値（エポック秒）である。
 * このセッションは認可リクエストをまたいで残り、後の認可リクエストでは、このセッションをもとに SSO、`prompt=none`、`max_age` を処理する。
 * セッションの Cookie は、このステップではなく、後の `hand-off-to-consent` のステップが結果に付ける。
 *
 * @spec OIDC Core 1.0 §3.1.2.3
 */
export async function establishBrowserSession(
  c: any,
  subject: string,
): Promise<{ sessionId: string; authTime: number }> {
  const browserSessionStore = c.get('browserSessionStore');
  const authTime = Math.floor(Date.now() / 1000);
  const sessionId = await generateRandomString(32);
  await browserSessionStore.set(sessionId, { subject, authTime });
  return { sessionId, authTime };
}
