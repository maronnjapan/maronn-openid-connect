import { step } from '../../step.js';
import type { UserStorage } from '../../../store.js';

export const meta = step({
  id: 'authenticate-user',
  endpoint: 'login',
  kind: 'validate',
  label: '認証情報を確かめる',
  function: 'authenticateEndUser',
  calls: ['userStore.authenticate'],
  consumes: ['username', 'password'],
  produces: ['user'],
  removable: false,
});

/**
 * 認証情報を確かめ、エンドユーザーの `sub` を返す。
 *
 * リクエストのユーザーストアの `authenticate()` を呼ぶ。
 * 認証情報が誤っていれば `undefined` を返す。
 */
export async function authenticateEndUser(
  c: any,
  username: string,
  password: string,
): Promise<{ sub: string } | undefined> {
  const userStore: UserStorage = c.get('userStore');
  return (await userStore.authenticate(username, password)) ?? undefined;
}
