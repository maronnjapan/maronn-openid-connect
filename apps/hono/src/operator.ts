/**
 * Operator routes: change the public keys of a registered client while the
 * app runs, the way an operator changes the client_jwks rows of a provider
 * generated with --db sql. The provider reads the keys on every request, so
 * the next request uses them (tests/e2e/specs/client-keys.spec.ts relies on
 * that).
 *
 * They exist only when APP_OPERATOR_TOKEN is set, and answer only a request
 * that presents it as a Bearer token. Never set it in production.
 */
import type { JwkSet } from '@maronn-openid-connect/core';
import { Hono } from 'hono';
import type { Database } from './oidc-provider/db/index.js';

/** Whether an Authorization header presents the operator token. */
export function presentsOperatorToken(authorization: string | undefined, token: string): boolean {
  return authorization === `Bearer ${token}`;
}

/** One public key of a JWK Set. */
type Jwk = JwkSet['keys'][number];

/** Add key to the keys of purpose. false when the client is not registered. */
export function addClientKey(db: Database, clientId: string, purpose: string, key: Jwk): boolean {
  const registration = db.clients.get(clientId);
  if (!registration) return false;
  const keys = registration.keys?.[purpose]?.keys ?? [];
  db.clients.set(clientId, {
    ...registration,
    keys: { ...registration.keys, [purpose]: { keys: [...keys, key] } },
  });
  return true;
}

/** Remove the key with kid from the keys of purpose. */
export function removeClientKey(db: Database, clientId: string, purpose: string, kid: string): boolean {
  const registration = db.clients.get(clientId);
  if (!registration) return false;
  const keys = (registration.keys?.[purpose]?.keys ?? []).filter((key) => key.kid !== kid);
  db.clients.set(clientId, {
    ...registration,
    keys: { ...registration.keys, [purpose]: { keys } },
  });
  return true;
}

/** Remove every key of the client. */
export function clearClientKeys(db: Database, clientId: string): boolean {
  const registration = db.clients.get(clientId);
  if (!registration) return false;
  const { keys: _keys, ...client } = registration;
  db.clients.set(clientId, client);
  return true;
}

export function createOperatorApp(db: Database, token: string): Hono {
  const operator = new Hono();
  operator.use('*', async (c, next) => {
    if (!presentsOperatorToken(c.req.header('Authorization'), token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
  operator.post('/clients/:clientId/keys/:purpose', async (c) => {
    const key = (await c.req.json()) as Jwk;
    const found = addClientKey(db, c.req.param('clientId'), c.req.param('purpose'), key);
    return found ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });
  operator.delete('/clients/:clientId/keys/:purpose/:kid', (c) => {
    const found = removeClientKey(db, c.req.param('clientId'), c.req.param('purpose'), c.req.param('kid'));
    return found ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });
  operator.delete('/clients/:clientId/keys', (c) => {
    const found = clearClientKeys(db, c.req.param('clientId'));
    return found ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });
  return operator;
}
