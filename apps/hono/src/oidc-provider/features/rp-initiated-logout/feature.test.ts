import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { discoveryOf } from '../feature.js';
import { logoutPage } from './endpoints/logout/page.js';
import { rpInitiatedLogout } from './feature.js';

describe('rpInitiatedLogout', () => {
  it('should be the rp-initiated-logout feature', () => {
    expect(rpInitiatedLogout.id).toBe('rp-initiated-logout');
  });

  // RP-Initiated Logout 1.0 §2: GET and POST at the end session endpoint, and the confirmation POST.
  it('should serve GET and POST /logout and POST /logout/approve', () => {
    expect(rpInitiatedLogout.routes).toEqual([
      { path: '/logout', app: logoutPage, methods: ['GET', 'POST'], subpaths: { '/approve': ['POST'] } },
    ]);
  });

  // RP-Initiated Logout 1.0 §2.1: end_session_endpoint metadata.
  it('should advertise the end_session_endpoint of the issuer', () => {
    const config = createProviderConfig({ issuer: TEST_ISSUER });

    expect(discoveryOf([rpInitiatedLogout], {}, TEST_ISSUER, config)).toEqual({
      end_session_endpoint: 'https://op.example.com/logout',
    });
  });

  it('should add no context values and no token grants', () => {
    expect(rpInitiatedLogout).toEqual({
      id: 'rp-initiated-logout',
      routes: rpInitiatedLogout.routes,
      discovery: rpInitiatedLogout.discovery,
    });
  });
});
