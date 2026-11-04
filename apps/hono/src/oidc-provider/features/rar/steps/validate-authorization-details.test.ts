import { AuthorizationError, type ValidatedAuthorizationRequest } from '@maronn-openid-connect/core';
import { RarError, type AuthorizationDetailTypeDefinition } from '@maronn-openid-connect/experimental/rar';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../test-support/context.js';
import type { AuthorizationRequestInput } from '../../../endpoints/authorize/outcome.js';
import { validateAuthorizationDetailsRequest } from './validate-authorization-details.js';

const PAYMENT_DETAIL = {
  type: 'payment_initiation',
  actions: ['initiate'],
  instructedAmount: { currency: 'EUR', amount: '123.50' },
};

const PAYMENT_TYPE: AuthorizationDetailTypeDefinition = {
  type: 'payment_initiation',
  validate(detail): void {
    if (!Array.isArray(detail.actions) || detail.actions.length === 0) {
      throw new RarError('payment_initiation requires actions');
    }
  },
  describe(): readonly string[] {
    return ['Initiate a payment of EUR 123.50'];
  },
};

function contextWithTypes(rarTypes: readonly AuthorizationDetailTypeDefinition[] | undefined) {
  return contextOf(undefined, { config: { rarTypes } });
}

function validated(overrides: Partial<ValidatedAuthorizationRequest> = {}): ValidatedAuthorizationRequest {
  return {
    responseType: 'code',
    clientId: 'client-1',
    redirectUri: 'https://rp.example.com/callback',
    redirectUriExplicit: true,
    scope: ['openid'],
    state: 'state-1',
    ...overrides,
  } as ValidatedAuthorizationRequest;
}

function params(values: Record<string, string>): AuthorizationRequestInput {
  return values as AuthorizationRequestInput;
}

/** The AuthorizationError a call throws, for asserting code and redirect target. */
function errorOf(run: () => unknown): AuthorizationError {
  try {
    run();
  } catch (error) {
    if (error instanceof AuthorizationError) return error;
    throw error;
  }
  throw new Error('expected an AuthorizationError');
}

describe('validateAuthorizationDetailsRequest', () => {
  describe('Requests Without authorization_details', () => {
    it('should return undefined and leave prompt unchanged without the parameter', () => {
      const request = validated({ prompt: ['login'] });
      const result = validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
        params: params({ client_id: 'client-1' }),
        validatedRequest: request,
      });
      expect(result).toBe(undefined);
      expect(request.prompt).toEqual(['login']);
    });
  });

  describe('Parameter Sources', () => {
    it('should read the parameter from the query params', () => {
      const result = validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
        params: params({ authorization_details: JSON.stringify([PAYMENT_DETAIL]) }),
        validatedRequest: validated(),
      });
      expect(result).toEqual([PAYMENT_DETAIL]);
    });

    // OIDC Core 1.0 §6.1: a parameter inside the request object supersedes the query value.
    it('should prefer the request object claim over the query value', () => {
      const queryOnly = { type: 'payment_initiation', actions: ['initiate'], instructedAmount: { currency: 'USD', amount: '1.00' } };
      const result = validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
        params: params({ authorization_details: JSON.stringify([queryOnly]) }),
        requestObjectClaims: { authorization_details: [PAYMENT_DETAIL] },
        validatedRequest: validated(),
      });
      expect(result).toEqual([PAYMENT_DETAIL]);
    });

    it('should accept the parsed array a request object claim carries', () => {
      const result = validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
        params: params({}),
        requestObjectClaims: { authorization_details: [PAYMENT_DETAIL] },
        validatedRequest: validated(),
      });
      expect(result).toEqual([PAYMENT_DETAIL]);
    });
  });

  describe('Validation Failures (RFC 9396 §5)', () => {
    it('should redirect an invalid structure as invalid_authorization_details', () => {
      const error = errorOf(() =>
        validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
          params: params({ authorization_details: '{not json' }),
          validatedRequest: validated(),
        }),
      );
      expect(error.error).toBe('invalid_authorization_details');
      expect(error.redirectUri).toBe('https://rp.example.com/callback');
      expect(error.state).toBe('state-1');
    });

    it('should reject every request while no type definitions are configured', () => {
      // fail-closed: rarTypes 未設定なら全拒否（RFC 9396 §5）。
      const error = errorOf(() =>
        validateAuthorizationDetailsRequest(contextWithTypes(undefined), {
          params: params({ authorization_details: JSON.stringify([PAYMENT_DETAIL]) }),
          validatedRequest: validated(),
        }),
      );
      expect(error.error).toBe('invalid_authorization_details');
    });

    it('should keep the detail values out of the error description', () => {
      const error = errorOf(() =>
        validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
          params: params({ authorization_details: JSON.stringify([{ type: 'secret-type-name' }]) }),
          validatedRequest: validated(),
        }),
      );
      expect(error.errorDescription).toBe('The authorization_details parameter is invalid');
    });

    it('should propagate a non-RarError thrown by a type definition unchanged', () => {
      const throwing: AuthorizationDetailTypeDefinition = {
        type: 'payment_initiation',
        validate(): void {
          throw new TypeError('validator bug');
        },
        describe(): readonly string[] {
          return [];
        },
      };
      expect(() =>
        validateAuthorizationDetailsRequest(contextWithTypes([throwing]), {
          params: params({ authorization_details: JSON.stringify([PAYMENT_DETAIL]) }),
          validatedRequest: validated(),
        }),
      ).toThrow(TypeError);
    });
  });

  describe('Prompt Control', () => {
    it('should reject prompt=none alone with consent_required', () => {
      const error = errorOf(() =>
        validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
          params: params({ authorization_details: JSON.stringify([PAYMENT_DETAIL]) }),
          validatedRequest: validated({ prompt: ['none'] }),
        }),
      );
      expect(error.error).toBe('consent_required');
      expect(error.redirectUri).toBe('https://rp.example.com/callback');
    });

    it('should skip the none check and keep prompt unchanged when none is combined with other values', () => {
      // base の [validate-prompt-combination] が invalid_request にする組み合わせには手を出さない。
      const request = validated({ prompt: ['none', 'login'] });
      const result = validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
        params: params({ authorization_details: JSON.stringify([PAYMENT_DETAIL]) }),
        validatedRequest: request,
      });
      expect(result).toEqual([PAYMENT_DETAIL]);
      expect(request.prompt).toEqual(['none', 'login']);
    });

    it('should add consent to an absent prompt', () => {
      const request = validated();
      validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
        params: params({ authorization_details: JSON.stringify([PAYMENT_DETAIL]) }),
        validatedRequest: request,
      });
      expect(request.prompt).toEqual(['consent']);
    });

    it('should append consent to other prompt values', () => {
      const request = validated({ prompt: ['login'] });
      validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
        params: params({ authorization_details: JSON.stringify([PAYMENT_DETAIL]) }),
        validatedRequest: request,
      });
      expect(request.prompt).toEqual(['login', 'consent']);
    });

    it('should keep an existing consent value without duplicating it', () => {
      const request = validated({ prompt: ['consent'] });
      validateAuthorizationDetailsRequest(contextWithTypes([PAYMENT_TYPE]), {
        params: params({ authorization_details: JSON.stringify([PAYMENT_DETAIL]) }),
        validatedRequest: request,
      });
      expect(request.prompt).toEqual(['consent']);
    });
  });
});
