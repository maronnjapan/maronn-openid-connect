/**
 * Users in the users Map of database.ts: registerUser() to put a user there,
 * and the password hashing that authenticate() (stores.ts) checks the login
 * form against.
 *
 * Passwords are hashed with PBKDF2-HMAC-SHA256 of the Web Crypto API, the same
 * way as the users of --db sql and --db kv, so the code that registers users
 * stays the same whichever database the provider is generated with.
 */
import type { UserClaims } from '@maronn-openid-connect/core';
import type { MemoryDatabase } from './database';

const PASSWORD_HASH_ALGORITHM = 'pbkdf2-sha256';
/**
 * OWASP recommends 600,000 iterations for PBKDF2-HMAC-SHA256, but Cloudflare
 * Workers accept at most 100,000, so the generated code uses that. Raise it
 * where the runtime allows more.
 */
const PASSWORD_HASH_ITERATIONS = 100_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 32;

/**
 * ユーザーをデータベースに保存する。
 *
 * `users` に `sub` で入れ、同じ `sub` で登録済みのユーザーを置き換える。
 * `password` 以外の値は、すべてクレームとして保存する。
 * `password` を渡せばハッシュ（`hashPassword()`）にして保存し、渡さなければパスワードのないユーザーになる。
 * パスワードのないユーザーは、OP のログインフォームを使えない。
 *
 * @example
 * ```ts
 * await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true, password: '...' });
 * ```
 */
export async function registerUser(
  db: MemoryDatabase,
  user: UserClaims & { password?: string },
): Promise<void> {
  const { password, ...claims } = user;
  db.users.set(claims.sub, {
    claims,
    ...(password === undefined ? {} : { passwordHash: await hashPassword(password) }),
  });
}

/**
 * パスワードのハッシュを新しいソルトで作って返す。
 *
 * ソルトは呼ぶたびに乱数で作る。
 * 返す値は `pbkdf2-sha256$<反復回数>$<ソルト>$<ハッシュ>` の形式で、ユーザーの `passwordHash` に保存する。
 * ソルトとハッシュは base64url でエンコードする。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derivePasswordHash(password, salt, PASSWORD_HASH_ITERATIONS);
  return [PASSWORD_HASH_ALGORITHM, PASSWORD_HASH_ITERATIONS, toBase64Url(salt), toBase64Url(hash)].join('$');
}

/**
 * パスワードがハッシュと一致すれば `true` を返す。
 *
 * ハッシュはユーザーの `passwordHash` の値である。
 * ハッシュがないとき（`null`、またはほかの形式の値）も、鍵を導出してから `false` を返す。
 * かかった時間から、ユーザーがいるかどうかや、パスワードを持っているかどうかがわからないようにするためである。
 * 導出したハッシュは定数時間で比較する（`constantTimeEqual()`）。
 *
 * @throws {DOMException} `InvalidCharacterError`: 値の形式は合っているが、ソルトかハッシュが base64url として正しくないとき（`parsePasswordHash()`）
 */
export async function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  const stored = passwordHash === null ? undefined : parsePasswordHash(passwordHash);
  const derived = await derivePasswordHash(
    password,
    stored?.salt ?? new Uint8Array(PASSWORD_SALT_BYTES),
    stored?.iterations ?? PASSWORD_HASH_ITERATIONS,
  );
  return stored !== undefined && constantTimeEqual(derived, stored.hash);
}

/**
 * パスワードから 32 バイトのハッシュを導出して返す。
 *
 * Web Crypto API の PBKDF2-HMAC-SHA256 で、引数のソルトと反復回数を使って導出する。
 */
async function derivePasswordHash(password: string, salt: ArrayLike<number>, iterations: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations },
    key,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * 保存されたパスワードのハッシュを解析して返す。
 *
 * `pbkdf2-sha256$<反復回数>$<ソルト>$<ハッシュ>` の形式の値から、反復回数と、ソルトとハッシュのバイト列を取り出す。
 * ほかの形式の値には `undefined` を返す。
 * ほかの形式とは、アルゴリズムが違う値、部分が足りない値、空の部分や余分な部分がある値、反復回数が正の整数でない値である。
 *
 * @throws {DOMException} `InvalidCharacterError`: ソルトかハッシュが base64url として正しくないとき
 */
function parsePasswordHash(value: string) {
  const [algorithm, iterations, salt, hash, ...rest] = value.split('$');
  const iterationCount = Number(iterations);
  if (
    algorithm !== PASSWORD_HASH_ALGORITHM ||
    rest.length > 0 ||
    !Number.isInteger(iterationCount) ||
    iterationCount < 1 ||
    !salt ||
    !hash
  ) {
    return undefined;
  }
  return { iterations: iterationCount, salt: fromBase64Url(salt), hash: fromBase64Url(hash) };
}

/**
 * 二つのバイト列が等しければ `true` を返す。
 *
 * 比較にかかる時間は、値の違う位置によらない。
 * 長さが違えば、すぐに `false` を返す。
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/**
 * バイト列を base64url でエンコードして返す。
 *
 * パディングは付けない。
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url の文字列をデコードして、バイト列を返す。
 *
 * パディングはあってもなくてもよい。
 *
 * @throws {DOMException} `InvalidCharacterError`: 値が base64url として正しくないとき
 */
function fromBase64Url(value: string) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
