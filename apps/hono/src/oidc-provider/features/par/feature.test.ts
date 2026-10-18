import { afterEach, describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { configOf, discoveryOf, tokenGrantsOf } from '../feature.js';
import { parConfig } from './config.js';
import { parApp } from './endpoints/par/pipeline.js';
import { par } from './feature.js';
import { parStore } from './store.js';

describe('par', () => {
  describe('routes', () => {
    // RFC 9126 §2: POST /par, called by clients with the token endpoint's CORS policy.
    it('should serve POST /par with the protected CORS policy', () => {
      expect(par.routes).toEqual([{ path: '/par', app: parApp, methods: ['POST'], cors: 'protected' }]);
    });
  });

  // RFC 9126 §5: authorization server metadata.
  describe('discovery', () => {
    afterEach(() => {
      parConfig.requirePushedAuthorizationRequests = false;
    });

    it('should advertise the endpoint under the issuer without requiring pushed requests', () => {
      expect(discoveryOf([par], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        pushed_authorization_request_endpoint: 'https://op.example.com/par',
      });
    });

    it('should advertise require_pushed_authorization_requests when pushed requests are required', () => {
      parConfig.requirePushedAuthorizationRequests = true;

      expect(discoveryOf([par], {}, TEST_ISSUER, createProviderConfig({ issuer: TEST_ISSUER }))).toEqual({
        pushed_authorization_request_endpoint: 'https://op.example.com/par',
        require_pushed_authorization_requests: true,
      });
    });
  });

  describe('context', () => {
    it('should put the shared PAR store into the request context', () => {
      expect(par.context).toEqual({ parStore });
      expect(par.context.parStore).toBe(parStore);
    });
  });

  describe('config and token', () => {
    it('should add no provider settings and no token grants', () => {
      expect(configOf([par])).toEqual({});
      expect(tokenGrantsOf([par])).toEqual([]);
    });
  });
});
