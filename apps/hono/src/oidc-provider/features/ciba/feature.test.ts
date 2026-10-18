import { describe, expect, it } from 'vitest';
import { providerContext, TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { createEmptyDatabase } from '../../db/memory/database.js';
import { registerUser } from '../../db/memory/users.js';
import { discoveryOf } from '../feature.js';
import { backchannelAuthenticationApp } from './endpoints/backchannel-authentication/pipeline.js';
import { cibaPage } from './endpoints/ciba/page.js';
import { ciba } from './feature.js';
import { cibaAuthenticationRequestStore, cibaLoginTransactionStore } from './store.js';

describe('ciba', () => {
  it('should be the ciba feature', () => {
    expect(ciba.id).toBe('ciba');
  });

  // CIBA Core 1.0 §7: the backchannel authentication endpoint and the authentication device screens.
  it('should serve POST /backchannel_authentication with the token CORS policy and the /ciba screens', () => {
    expect(ciba.routes).toEqual([
      { path: '/backchannel_authentication', app: backchannelAuthenticationApp, methods: ['POST'], cors: 'protected' },
      { path: '/ciba', app: cibaPage, methods: ['GET'], subpaths: { '/login': ['POST'], '/approve': ['POST'] } },
    ]);
  });

  // CIBA Core 1.0 §4: only the poll delivery mode is implemented.
  it('should advertise the poll delivery mode and the backchannel_authentication_endpoint of the issuer', () => {
    const config = createProviderConfig({ issuer: TEST_ISSUER });

    expect(discoveryOf([ciba], {}, TEST_ISSUER, config)).toEqual({
      backchannel_token_delivery_modes_supported: ['poll'],
      backchannel_authentication_endpoint: 'https://op.example.com/backchannel_authentication',
    });
  });

  // CIBA Core 1.0 §10.1: the grant_type the token endpoint answers.
  it('should answer the CIBA grant at the token endpoint', () => {
    expect(ciba.token).toEqual({ grants: ['urn:openid:params:grant-type:ciba'] });
  });

  describe('context', () => {
    it('should put both CIBA stores into the request context', async () => {
      const { c } = await providerContext();

      expect(c.get('cibaAuthenticationRequestStore')).toBe(cibaAuthenticationRequestStore);
      expect(c.get('cibaLoginTransactionStore')).toBe(cibaLoginTransactionStore);
    });

    // CIBA Core 1.0 §7.1: by default the login_hint is a username of the user store.
    it('should resolve a login_hint naming a user of the user store to that subject by default', async () => {
      const db = createEmptyDatabase();
      await registerUser(db, { sub: 'alice' });
      const { c } = await providerContext({ db });

      expect(await c.get('cibaUserResolver')('alice')).toEqual({ subject: 'alice' });
    });

    it('should resolve a login_hint naming no user to null by default', async () => {
      const { c } = await providerContext();

      expect(await c.get('cibaUserResolver')('nobody')).toBeNull();
    });

    it('should use the cibaUserResolver option instead of the default', async () => {
      const cibaUserResolver = (loginHint: string) => ({ subject: 'by-email:' + loginHint });
      const { c } = await providerContext({ options: { cibaUserResolver } });

      expect(c.get('cibaUserResolver')).toBe(cibaUserResolver);
    });
  });
});
