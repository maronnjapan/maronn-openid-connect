import { describe, expect, it } from 'vitest';
import { TEST_ISSUER } from '../../../test-support/context.js';
import { createProviderConfig } from '../../config.js';
import { configOf, discoveryOf, responseModesOf, routesOf, tokenGrantsOf } from '../feature.js';
import { formPostResponseMode } from './feature.js';
import { formPostResponseModeHandler } from './response-mode.js';

describe('formPostResponseMode', () => {
  // OIDC Discovery 1.0 §3: response_modes_supported.
  describe('discovery', () => {
    it('should advertise form_post next to the response modes the provider already advertises', () => {
      expect(
        discoveryOf(
          [formPostResponseMode],
          { response_modes_supported: ['query'] },
          TEST_ISSUER,
          createProviderConfig({ issuer: TEST_ISSUER }),
        ),
      ).toEqual({ response_modes_supported: ['query', 'form_post'] });
    });
  });

  // Form Post Response Mode §2: /consent answers in the mode the transaction stored.
  describe('authorize', () => {
    it('should answer in the Form Post Response Mode at /consent', () => {
      expect(responseModesOf([formPostResponseMode])).toEqual([formPostResponseModeHandler]);
      expect(responseModesOf([formPostResponseMode])[0]).toBe(formPostResponseModeHandler);
    });
  });

  describe('routes, config and token', () => {
    it('should add no routes, no provider settings and no token grants', () => {
      expect(routesOf([formPostResponseMode])).toEqual([]);
      expect(configOf([formPostResponseMode])).toEqual({});
      expect(tokenGrantsOf([formPostResponseMode])).toEqual([]);
    });
  });
});
