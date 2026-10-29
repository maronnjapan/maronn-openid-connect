import type { ClientKeyResolver, ClientKeysByPurpose, JwkSet } from '@maronn-openid-connect/core';
import type { DynamicallyRegisteredClient } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import type { ClientRegistration, RegisteredClient } from '../../config.js';

/**
 * EXPERIMENTAL — store contract for dynamically registered clients (RFC 7591).
 *
 * - get(clientId): return the registration, or undefined when unknown.
 * - save(registration): persist it under registration.clientId. The record is
 *   a ClientRegistration as registerClient() of db/ takes it: the client and
 *   its public keys by purpose (keys), the client_secret as its hash.
 * - count(): how many dynamic registrations exist, for the
 *   maxRegisteredClients inventory cap (RFC 7591 §5 DoS consideration).
 * - delete(clientId): remove one registration — the register endpoint
 *   withdraws its own save when concurrent requests overshot the cap.
 */
export interface DynamicallyRegisteredClientStore {
  get(clientId: string): Promise<ClientRegistration | undefined>;
  save(registration: ClientRegistration): Promise<void>;
  count(): Promise<number>;
  delete(clientId: string): Promise<void>;
}

/**
 * EXPERIMENTAL — in-memory store for dynamically registered clients (RFC 7591).
 *
 * Dynamic registrations live only in this process: they survive neither a
 * restart nor a second instance (the statically registered clients do), so a
 * long-running deployment needs a persistent implementation of the contract
 * above. There is no expiry: RFC 7592 (deregistration) is not implemented, so
 * the inventory cap and a restart are the only ways a registration goes away.
 */
export class InMemoryDynamicallyRegisteredClientStore
  implements DynamicallyRegisteredClientStore
{
  private clients = new Map<string, ClientRegistration>();

  async get(clientId: string): Promise<ClientRegistration | undefined> {
    return this.clients.get(clientId);
  }

  async save(registration: ClientRegistration): Promise<void> {
    this.clients.set(registration.clientId, registration);
  }

  async count(): Promise<number> {
    return this.clients.size;
  }

  async delete(clientId: string): Promise<void> {
    this.clients.delete(clientId);
  }
}

// Kept on globalThis so every module that asks for the store gets the same one,
// also where a framework loads a module more than once (dev-mode hot reloads,
// separate module layers).
const dynamicClientStoreRegistry = globalThis as typeof globalThis & {
  __oidcDynamicallyRegisteredClientStore?: DynamicallyRegisteredClientStore;
};

export const dynamicClientStore: DynamicallyRegisteredClientStore =
  (dynamicClientStoreRegistry.__oidcDynamicallyRegisteredClientStore ??=
    new InMemoryDynamicallyRegisteredClientStore());

/**
 * EXPERIMENTAL — the record the store keeps for a client the register endpoint
 * built (RFC 7591): the fields the provider reads (what registerClient() of db/
 * takes), the public keys of its jwks under every purpose of jwksPurposes, and
 * the registered metadata for a project's own code (RegisteredClient.registrationMetadata).
 *
 * The experimental package types the auth method and the signed response algs
 * as strings, because it does not know the methods and algs of this provider.
 * The register endpoint validated them against the registration config and the
 * signing keys of this provider, so the record narrows them to the values
 * RegisteredClient takes without another check.
 */
export function toClientRegistration(
  client: DynamicallyRegisteredClient,
  options: { clientSecretHash?: string; jwksPurposes: readonly string[] },
): ClientRegistration {
  const tokenEndpointAuthMethods: readonly string[] = client.tokenEndpointAuthMethods;
  return {
    clientId: client.clientId,
    clientType: client.clientType,
    redirectUris: [...client.redirectUris],
    grantTypes: [...client.grantTypes],
    responseTypes: [...client.responseTypes],
    tokenEndpointAuthMethods: tokenEndpointAuthMethods as RegisteredClient['tokenEndpointAuthMethods'],
    ...(client.scope === undefined ? {} : { scope: [...client.scope] }),
    ...(client.defaultMaxAge === undefined ? {} : { defaultMaxAge: client.defaultMaxAge }),
    ...(client.idTokenSignedResponseAlg === undefined
      ? {}
      : { idTokenSignedResponseAlg: client.idTokenSignedResponseAlg as RegisteredClient['idTokenSignedResponseAlg'] }),
    ...(client.userinfoSignedResponseAlg === undefined
      ? {}
      : { userinfoSignedResponseAlg: client.userinfoSignedResponseAlg as RegisteredClient['userinfoSignedResponseAlg'] }),
    ...(client.requestUris === undefined ? {} : { requestUris: [...client.requestUris] }),
    ...(client.requestObjectSigningAlg === undefined ? {} : { requestObjectSigningAlg: client.requestObjectSigningAlg }),
    ...(options.clientSecretHash === undefined ? {} : { clientSecretHash: options.clientSecretHash }),
    ...(client.jwks === undefined ? {} : { keys: keysByPurpose(client.jwks, options.jwksPurposes) }),
    registrationMetadata: { ...client.metadata },
  };
}

function keysByPurpose(jwks: JwkSet, purposes: readonly string[]): ClientKeysByPurpose {
  const keys: ClientKeysByPurpose = {};
  for (const purpose of purposes) {
    keys[purpose] = { keys: jwks.keys.map((key) => ({ ...key })) };
  }
  return keys;
}

/**
 * EXPERIMENTAL — consult the dynamically registered clients (RFC 7591) after
 * the configured resolver, so a statically registered client can never be
 * shadowed by a dynamic registration (ids minted at /register carry the dcr-
 * prefix and cannot collide with human-named static ids anyway).
 *
 * The wrapper keeps the base resolver's own type: a value serving as both
 * ClientResolver and TokenClientResolver stays usable as both, and the
 * RegisteredClient records the store adds satisfy either view. The keys of
 * the registration stay out of the client, as in db/ (the ClientKeyResolver
 * hands them out by purpose).
 */
export function withDynamicallyRegisteredClients<
  Resolver extends { findClient(clientId: string): Promise<any> },
>(base: Resolver): Resolver {
  return {
    ...base,
    async findClient(clientId: string): Promise<RegisteredClient | null> {
      const registered = (await base.findClient(clientId)) as RegisteredClient | null;
      if (registered) {
        return registered;
      }
      const registration = await dynamicClientStore.get(clientId);
      if (!registration) {
        return null;
      }
      const { keys: _keys, ...client } = registration;
      return client;
    },
  } as Resolver;
}

/**
 * EXPERIMENTAL — hand out the public keys a dynamic registration carried in its
 * jwks (RFC 7591 §2) by purpose, after the keys of the configured resolver: a
 * client db/ knows keeps its own keys, and a dynamically registered one gets
 * those of its registration (under the purposes of jwksPurposes). A client
 * neither knows, or a purpose without keys, resolves to an empty key set, as
 * core's ClientKeyResolver contract asks.
 */
export function withDynamicallyRegisteredClientKeys(base: ClientKeyResolver): ClientKeyResolver {
  return {
    ...base,
    async findClientKeys(clientId, purpose): Promise<JwkSet> {
      const registered = await base.findClientKeys(clientId, purpose);
      if (registered.keys.length > 0) {
        return registered;
      }
      const registration = await dynamicClientStore.get(clientId);
      return { keys: [...(registration?.keys?.[purpose]?.keys ?? [])] };
    },
  };
}
