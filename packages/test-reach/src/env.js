/**
 * Whether this process measures what each test runs: only when
 * MARONN_REACH is 1, so `pnpm test` and the OPs started by hand stay as they
 * are.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function reachEnabled(env = process.env) {
  return env['MARONN_REACH'] === '1';
}
