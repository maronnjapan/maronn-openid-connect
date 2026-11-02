import { step } from '../../step.js';

export const meta = step({
  id: 'authenticate-user',
  endpoint: 'login',
  kind: 'validate',
  label: 'Check the credentials',
  function: 'authenticateEndUser',
  calls: ['userStore.authenticate'],
  consumes: ['username', 'password'],
  produces: ['user'],
  removable: false,
});

/**
 * 認証情報を確かめ、エンドユーザーの `sub` を返す。
 *
 * 確認には、app.ts がリクエストコンテキストに設定した `authenticateUser` 関数を使う。
 * 既定では、この関数はユーザーストアの `authenticate()` を呼ぶ。
 * 認証情報が誤っていれば `undefined` を返す。
 */
export async function authenticateEndUser(
  c: any,
  username: string,
  password: string,
): Promise<{ sub: string } | undefined> {
  const authenticateUser = c.get('authenticateUser');
  return (await authenticateUser(username, password)) ?? undefined;
}
