import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { es256Key } from '../../../../test-support/screens.js';
import { collectAdvertisedSigningKeys } from './collect-signing-algorithms.js';

describe('collectAdvertisedSigningKeys', () => {
  // OIDC Core 1.0 §15.1: id_token_signing_alg_values_supported is derived from these keys.
  it('should return the private keys of the ID Token key set in order', async () => {
    const first = await rs256Key('id-1');
    const second = await es256Key('id-2');
    const c = contextOf(undefined, { idTokenSigningKeys: [first, second], userinfoSigningKeys: [] });

    expect(collectAdvertisedSigningKeys(c).idTokenSigningKeys).toEqual([first.privateKey, second.privateKey]);
  });

  // OIDC Core 1.0 §5.3.2: the algorithms a client may register as userinfo_signed_response_alg.
  it('should list each UserInfo signing algorithm once, in key order', async () => {
    const c = contextOf(undefined, {
      idTokenSigningKeys: [],
      userinfoSigningKeys: [await rs256Key('ui-1'), await es256Key('ui-2'), await rs256Key('ui-3')],
    });

    expect(collectAdvertisedSigningKeys(c).userinfoSigningAlgValues).toEqual(['RS256', 'ES256']);
  });

  it('should return empty lists when no key set is on the context', () => {
    expect(collectAdvertisedSigningKeys(contextOf())).toEqual({
      idTokenSigningKeys: [],
      userinfoSigningAlgValues: [],
    });
  });
});
