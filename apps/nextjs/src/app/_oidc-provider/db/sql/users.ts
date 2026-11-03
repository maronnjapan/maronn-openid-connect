/**
 * Users in the users table of schema.sql: registerUser() to put a user
 * there, and the password hashing that authenticate() (stores.ts) checks the
 * login form against.
 *
 * Passwords are hashed with PBKDF2-HMAC-SHA256 of the Web Crypto API, which
 * every runtime of the generated OP has. A stored hash records its own
 * iteration count and salt ('pbkdf2-sha256$<iterations>$<salt>$<hash>'), so
 * raising PASSWORD_HASH_ITERATIONS later keeps the existing hashes valid.
 */
import type { UserClaims } from '@maronn-openid-connect/core';
import type { SqlDatabase } from './database';

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
 * ユーザーを `users` テーブルに保存する。
 *
 * `sub` を `id` にした行を書き、同じ `sub` で登録済みの行を置き換える。
 * `email` と `email_verified` はそれぞれの列に、ほかのクレームは JSON にして `claims` の列に入れる。
 * `password` を渡せばハッシュ（`hashPassword()`）にして保存し、渡さなければパスワードのないユーザーになる。
 * パスワードのないユーザーは、OP のログインフォームを使えない。
 *
 * 登録済みの行の作成日時（`created_at`）は元の値のまま残り、紐付いた外部アカウント（`federated_identities` の行）も消えない。
 *
 * @example
 * ```ts
 * await registerUser(db, { sub: 'alice', email: 'alice@example.com', email_verified: true, password: '...' });
 * ```
 */
export async function registerUser(
  db: SqlDatabase,
  user: UserClaims & { password?: string },
): Promise<void> {
  const { sub, email, email_verified, password, ...otherClaims } = user;
  const now = Math.floor(Date.now() / 1000);
  await db.run({
    sql:
      'INSERT INTO users (id, email, is_verified, password_hash, created_at, updated_at, claims) ' +
      'VALUES (?, ?, ' + (email_verified === true ? 'TRUE' : 'FALSE') + ', ?, ?, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET email = excluded.email, is_verified = excluded.is_verified, ' +
      'password_hash = excluded.password_hash, updated_at = excluded.updated_at, claims = excluded.claims',
    params: [
      sub,
      email ?? null,
      password === undefined ? null : await hashPassword(password),
      now,
      now,
      JSON.stringify(otherClaims),
    ],
  });
}

/**
 * パスワードのハッシュを新しいソルトで作って返す。
 *
 * ソルトは呼ぶたびに乱数で作る。
 * 返す値は `pbkdf2-sha256$<反復回数>$<ソルト>$<ハッシュ>` の形式で、`users.password_hash` に保存する。
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
 * ハッシュは `users.password_hash` の値である。
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
