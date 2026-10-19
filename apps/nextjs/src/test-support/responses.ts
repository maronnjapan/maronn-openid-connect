import { expect } from 'vitest';
import type { AuthorizationResponse } from '../app/authorize/response-mode';

/**
 * The parts of a JSON response the tests of the token endpoint blocks check:
 * the status, the headers of a credential-bearing response (RFC 6749 §5.1 /
 * §5.2) and the parsed body.
 */
export interface JsonResponseParts {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  pragma: string | null;
  body: unknown;
}

export async function jsonResponseOf(response: Response | undefined): Promise<JsonResponseParts | undefined> {
  if (response === undefined) return undefined;
  return {
    status: response.status,
    contentType: response.headers.get('Content-Type'),
    cacheControl: response.headers.get('Cache-Control'),
    pragma: response.headers.get('Pragma'),
    body: await response.json(),
  };
}

/** Assert that the authorization response is a redirect and return its location. */
export function locationOf(response: AuthorizationResponse | undefined): string {
  expect(response).toMatchObject({ method: 'redirect', location: expect.any(String) });
  return (response as { location: string }).location;
}
