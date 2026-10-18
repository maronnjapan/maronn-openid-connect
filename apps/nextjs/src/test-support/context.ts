/**
 * Requests for the tests, on the issuer the tests use.
 */
export const TEST_ISSUER = 'https://op.example.com';

/** A request to path on the test issuer. */
export function requestTo(path: string, init?: RequestInit): Request {
  return new Request(new URL(path, TEST_ISSUER), init);
}
