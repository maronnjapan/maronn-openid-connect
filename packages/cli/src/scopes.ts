/**
 * Custom scopes for the generated OpenID Connect Provider.
 *
 * The generated OP always handles the standard OIDC scopes (`openid` / `profile`
 * / `email` / `address` / `phone`, plus `offline_access` when the refresh-token
 * feature is generated). Anything beyond that is a **custom scope**, declared at
 * generation time with `--scope` so the OP knows which values it accepts.
 *
 * The declaration is deliberately global: which End-User may actually be granted
 * a scope is a policy that belongs in the generated code, not in a CLI flag. The
 * generated `scopes.ts` carries `resolveGrantableScopes()` — already wired into
 * every step that decides a grant — as the one place to write that filtering.
 */

/**
 * Scopes the generated provider handles itself (OIDC Core 1.0 §5.4 and §11), so
 * they can never be declared as custom scopes: `openid` is mandatory on every
 * authorization request, the four claim scopes drive `filterClaimsByScope`, and
 * `offline_access` is granted by `applyOfflineAccessPolicy` together with the
 * refresh-token feature.
 */
export const RESERVED_SCOPES = [
  'openid',
  'profile',
  'email',
  'address',
  'phone',
  'offline_access',
] as const;

/**
 * RFC 6749 §3.3 scope-token = 1*( %x21 / %x23-5B / %x5D-7E ): printable ASCII
 * without space, double quote and backslash. A value outside it could not travel
 * in the space-delimited `scope` parameter at all.
 */
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

function assertValidScopeName(name: string): void {
  if (!SCOPE_TOKEN_PATTERN.test(name)) {
    throw new Error(
      `Invalid scope value for --scope: "${name}". A scope must match RFC 6749 §3.3 ` +
        'scope-token (printable ASCII without space, \'"\' or \'\\\').',
    );
  }
  if ((RESERVED_SCOPES as readonly string[]).includes(name)) {
    throw new Error(
      `Scope "${name}" is a standard scope handled by the generated provider and cannot be ` +
        `declared with --scope. Standard scopes: ${RESERVED_SCOPES.join(', ')}`,
    );
  }
}

/**
 * Resolve the raw `--scope` arguments into the declared custom scope list.
 * Each argument is a comma-separated list; duplicates collapse and the
 * declaration order is kept.
 *
 * @throws {Error} on a malformed value, an empty list, or a standard scope name.
 */
export function resolveCustomScopes(options: { scope?: string[] }): string[] {
  const declared: string[] = [];
  for (const value of options.scope ?? []) {
    const names = value
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (names.length === 0) {
      throw new Error('--scope requires at least one scope name');
    }
    for (const name of names) {
      assertValidScopeName(name);
      if (!declared.includes(name)) declared.push(name);
    }
  }
  return declared;
}
