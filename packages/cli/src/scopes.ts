/**
 * Custom scope configuration for the generated OpenID Connect Provider.
 *
 * The generated OP always allows the standard OIDC scopes (`openid` / `profile`
 * / `email` / `address` / `phone`, plus `offline_access` when the refresh-token
 * feature is generated). Anything beyond that is a **custom scope**, declared at
 * generation time so the OP knows which values it is willing to accept:
 *
 * - `--scope <name>` — allowed for every authenticated End-User (一律許容).
 * - `--user-scope <subject>:<name>` — allowed only for the named subjects
 *   (ユーザーごとの許容).
 *
 * Both land in the generated `scopes.ts` policy module. Declaring any custom
 * scope also turns the OP's scope handling into an allow list: a request asking
 * for a value that was never declared is rejected with `invalid_scope`
 * (RFC 6749 §3.3 / §4.1.2.1). Without a declaration nothing is generated and the
 * output is unchanged, so the default OP keeps accepting arbitrary scope values.
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

/**
 * `--user-scope` is split on the first `:`, which is also what lets a scope name
 * keep colons of its own (`urn:example:reports` stays one scope). The price is
 * that the subject cannot contain one, so it is restricted to printable ASCII
 * without space or `:`. A subject that needs a colon (a URI-shaped `sub`) is
 * added to the generated scopes.ts by hand.
 */
const SUBJECT_PATTERN = /^[\x21-\x39\x3B-\x7E]+$/;

/** Resolved custom scope policy passed through the generator pipeline. */
export interface CustomScopeConfig {
  /** Custom scopes every authenticated End-User may be granted (`--scope`). */
  global: string[];
  /**
   * Custom scopes only the listed subjects may be granted
   * (`--user-scope <subject>:<scope>`), keyed by subject.
   */
  perUser: Record<string, string[]>;
}

/** Default: no custom scope declared, so nothing scope-related is generated. */
export const NO_CUSTOM_SCOPES: CustomScopeConfig = { global: [], perUser: {} };

/** True when at least one custom scope was declared (globally or per user). */
export function hasCustomScopes(config: CustomScopeConfig): boolean {
  return config.global.length > 0 || Object.keys(config.perUser).length > 0;
}

/** True when at least one custom scope is restricted to specific subjects. */
export function hasPerUserScopes(config: CustomScopeConfig): boolean {
  return Object.keys(config.perUser).length > 0;
}

/**
 * Every declared custom scope, in declaration order (global first). This is what
 * the generated discovery document adds to `scopes_supported`, and what the
 * authorization endpoint accepts on top of the standard scopes.
 */
export function listCustomScopes(config: CustomScopeConfig): string[] {
  const all = [...config.global, ...Object.values(config.perUser).flat()];
  return [...new Set(all)];
}

/**
 * Custom scopes that are NOT allowed for everyone, i.e. the ones the generated
 * provider must drop from a grant when the End-User is not on their list.
 */
export function listRestrictedScopes(config: CustomScopeConfig): string[] {
  return listCustomScopes(config).filter((scope) => !config.global.includes(scope));
}

/** Subjects that were given at least one custom scope, in declaration order. */
export function listScopedSubjects(config: CustomScopeConfig): string[] {
  return Object.keys(config.perUser);
}

function assertValidScopeName(name: string, option: string): void {
  if (!SCOPE_TOKEN_PATTERN.test(name)) {
    throw new Error(
      `Invalid scope value for ${option}: "${name}". A scope must match RFC 6749 §3.3 ` +
        'scope-token (printable ASCII without space, \'"\' or \'\\\').',
    );
  }
  if ((RESERVED_SCOPES as readonly string[]).includes(name)) {
    throw new Error(
      `Scope "${name}" is a standard scope handled by the generated provider and cannot be ` +
        `declared with ${option}. Standard scopes: ${RESERVED_SCOPES.join(', ')}`,
    );
  }
}

function splitScopeList(value: string, option: string): string[] {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(`${option} requires at least one scope name`);
  }
  for (const name of names) {
    assertValidScopeName(name, option);
  }
  return names;
}

/**
 * Resolve the raw `--scope` / `--user-scope` arguments into a CustomScopeConfig.
 *
 * `--scope` takes a comma-separated list. `--user-scope` takes
 * `<subject>:<scope>[,<scope>...]` and is split on the FIRST colon, so the scope
 * names may contain colons (`urn:example:reports`) while the subject may not.
 *
 * @throws {Error} on a malformed value, a standard scope name, or a scope that
 *   is declared both globally and per user (the per-user restriction would be
 *   meaningless because the global declaration already grants it to everyone).
 */
export function resolveCustomScopes(options: {
  scope?: string[];
  userScope?: string[];
}): CustomScopeConfig {
  const global: string[] = [];
  for (const value of options.scope ?? []) {
    for (const name of splitScopeList(value, '--scope')) {
      if (!global.includes(name)) global.push(name);
    }
  }

  const perUser: Record<string, string[]> = {};
  for (const value of options.userScope ?? []) {
    const separatorIndex = value.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(
        `Invalid --user-scope value: "${value}". Expected <subject>:<scope>[,<scope>...], ` +
          'e.g. --user-scope alice:reports.read',
      );
    }
    const subject = value.slice(0, separatorIndex).trim();
    if (!SUBJECT_PATTERN.test(subject)) {
      throw new Error(
        `Invalid --user-scope subject: "${subject}". A subject must be printable ASCII ` +
          "without space or ':' (--user-scope splits on the first ':', so the scope names " +
          'after it may contain colons but the subject may not).',
      );
    }
    const names = splitScopeList(value.slice(separatorIndex + 1), '--user-scope');
    const existing = perUser[subject] ?? [];
    for (const name of names) {
      if (global.includes(name)) {
        throw new Error(
          `Scope "${name}" is declared with --scope (allowed for every user), so restricting ` +
            `it to "${subject}" with --user-scope has no effect. Declare it with only one of them.`,
        );
      }
      if (!existing.includes(name)) existing.push(name);
    }
    perUser[subject] = existing;
  }

  return { global, perUser };
}
