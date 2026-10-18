import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { CLIENT_ID, confidentialClient, es256Key } from '../../../../test-support/token.js';
import { createClientResolver, registerClient } from '../../../db/memory/clients.js';
import { createEmptyDatabase } from '../../../db/memory/database.js';
import type { RegisteredClient } from '../../../config.js';
import { TokenEndpointError } from '../response.js';
import { selectTokenSigningKeys } from './select-signing-keys.js';

async function contextWithKeys(
  client: Partial<RegisteredClient>,
  keys: { signingKeys: unknown[]; idTokenSigningKeys: unknown[] },
) {
  const db = createEmptyDatabase();
  await registerClient(db, confidentialClient(client));
  return contextOf(undefined, { tokenClientResolver: createClientResolver(db), ...keys });
}

describe('selectTokenSigningKeys', () => {
  // SigningKeyProvider contract: the first registered key signs new access tokens.
  it('should sign the access token with the first signing key', async () => {
    const first = await rs256Key('signing-1');
    const second = await rs256Key('signing-2');
    const c = await contextWithKeys({}, { signingKeys: [first, second], idTokenSigningKeys: [first] });

    expect((await selectTokenSigningKeys(c, CLIENT_ID)).signingKey.keyId).toBe('signing-1');
  });

  // OIDC Dynamic Client Registration 1.0 §2: id_token_signed_response_alg defaults to RS256.
  it('should pick the RS256 ID Token key for a client without id_token_signed_response_alg', async () => {
    const es256 = await es256Key('id-token-es256');
    const rs256 = await rs256Key('id-token-rs256');
    const c = await contextWithKeys({}, { signingKeys: [rs256], idTokenSigningKeys: [es256, rs256] });

    expect((await selectTokenSigningKeys(c, CLIENT_ID)).idTokenSigningKey.keyId).toBe('id-token-rs256');
  });

  // OIDC Dynamic Client Registration 1.0 §2: id_token_signed_response_alg chooses the ID Token alg.
  it('should pick the ID Token key whose alg is the id_token_signed_response_alg of the client', async () => {
    const rs256 = await rs256Key('id-token-rs256');
    const es256 = await es256Key('id-token-es256');
    const c = await contextWithKeys(
      { idTokenSignedResponseAlg: 'ES256' },
      { signingKeys: [rs256], idTokenSigningKeys: [rs256, es256] },
    );

    expect((await selectTokenSigningKeys(c, CLIENT_ID)).idTokenSigningKey.keyId).toBe('id-token-es256');
  });

  it('should fail with a 500 server_error when no ID Token key has the alg the client registered', async () => {
    const rs256 = await rs256Key('id-token-rs256');
    const c = await contextWithKeys(
      { idTokenSignedResponseAlg: 'ES256' },
      { signingKeys: [rs256], idTokenSigningKeys: [rs256] },
    );

    const selection = selectTokenSigningKeys(c, CLIENT_ID);

    await expect(selection).rejects.toBeInstanceOf(TokenEndpointError);
    await expect(selection).rejects.toMatchObject({
      response: {
        status: 500,
        body: { error: 'server_error', error_description: 'No ID Token signing key registered for alg "ES256"' },
      },
    });
  });
});
