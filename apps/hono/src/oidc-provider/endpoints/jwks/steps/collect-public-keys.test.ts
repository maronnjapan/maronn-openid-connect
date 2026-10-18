import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import { rs256Key } from '../../../../test-support/keys.js';
import { collectPublishedKeys } from './collect-public-keys.js';

describe('collectPublishedKeys', () => {
  it('should list the keys of every purpose in the order signing, ID Token, UserInfo', async () => {
    const signing = await rs256Key('signing');
    const idToken = await rs256Key('id-token');
    const userinfo = await rs256Key('userinfo');
    const c = contextOf(undefined, {
      signingKeys: [signing],
      idTokenSigningKeys: [idToken],
      userinfoSigningKeys: [userinfo],
    });

    expect(collectPublishedKeys(c).map((key) => key.keyId)).toEqual(['signing', 'id-token', 'userinfo']);
  });

  it('should return no keys when no key set is on the context', () => {
    expect(collectPublishedKeys(contextOf())).toEqual([]);
  });
});
