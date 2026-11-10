/**
 * POST /operator/signing-keys/rotate: rotates the OP's signing key while the
 * sample runs (OIDC Core 1.0 §10.1.1; signing-keys.ts). It answers only a
 * request that presents OIDC_SIGNING_KEY_ROTATION_TOKEN as a Bearer token, and
 * 404 when the variable is unset (the conformance run and tests/e2e set it;
 * never set it in production). Every other request goes on to the app.
 *
 * Next.js runs proxy.ts on the Node.js runtime, in the process of the Route
 * Handlers, so it rotates the keys they sign with.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { rotateSigningKey } from './signing-keys';

export const config = { matcher: '/operator/signing-keys/rotate' };

/** Rotates the signing key for a POST with the rotation token, and answers 401, 404 or 405 otherwise. */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const token = process.env.OIDC_SIGNING_KEY_ROTATION_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (request.method !== 'POST') {
    return NextResponse.json({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'POST' } });
  }
  if (request.headers.get('authorization') !== `Bearer ${token}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await rotateSigningKey());
}
