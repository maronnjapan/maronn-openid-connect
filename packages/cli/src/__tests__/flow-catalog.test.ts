import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES, type OidcFeatureConfig } from '../features.js';
import { buildOpFlow } from '../flow/catalog.js';
import { resolveFlowSelection } from '../flow/flow-file.js';

const ALL_FEATURES: OidcFeatureConfig = {
  pkce: true,
  refreshToken: true,
  introspection: true,
  revocation: true,
  requestObject: true,
  par: true,
  tokenExchange: true,
  jarm: true,
  deviceAuthorizationGrant: true,
  idJag: true,
  ciba: true,
  jwtIntrospectionResponse: true,
  rpInitiatedLogout: true,
  dynamicClientRegistration: true,
  googleLogin: true,
};

describe('buildOpFlow', () => {
  describe('endpoints', () => {
    it('should list the Basic OP endpoints in mount order by default', () => {
      const flow = buildOpFlow({ features: DEFAULT_FEATURES });
      expect(flow.endpoints.map((e) => e.id)).toEqual([
        'discovery',
        'jwks',
        'authorize',
        'login',
        'consent',
        'token',
        'userinfo',
        'introspection',
        'revocation',
      ]);
    });

    it('should add one box per experimental and extension endpoint when every feature is enabled', () => {
      const flow = buildOpFlow({ features: ALL_FEATURES });
      expect(flow.endpoints.map((e) => e.id)).toEqual([
        'discovery',
        'jwks',
        'authorize',
        'login',
        'login-google',
        'consent',
        'token',
        'userinfo',
        'introspection',
        'revocation',
        'par',
        'register',
        'device-authorization',
        'device',
        'backchannel-authentication',
        'ciba',
        'logout',
      ]);
    });

    it('should leave out the introspection and revocation endpoints when their features are disabled', () => {
      const flow = buildOpFlow({
        features: { ...DEFAULT_FEATURES, introspection: false, revocation: false },
      });
      expect(flow.endpoints.map((e) => e.id)).toEqual([
        'discovery',
        'jwks',
        'authorize',
        'login',
        'consent',
        'token',
        'userinfo',
      ]);
    });

    it('should record the paths and methods of the Basic OP endpoints', () => {
      const flow = buildOpFlow({ features: DEFAULT_FEATURES });
      expect(flow.endpoints.map((e) => [e.path, e.methods.join('|')])).toEqual([
        ['/.well-known/openid-configuration', 'GET'],
        ['/.well-known/jwks.json', 'GET'],
        ['/authorize', 'GET|POST'],
        ['/login', 'GET|POST'],
        ['/consent', 'GET|POST'],
        ['/token', 'POST'],
        ['/userinfo', 'GET|POST'],
        ['/introspect', 'POST'],
        ['/revoke', 'POST'],
      ]);
    });

    it('should copy the generation inputs into the document', () => {
      const flow = buildOpFlow({ features: DEFAULT_FEATURES, scopes: ['reports.read'], db: 'sql' });
      expect(flow.version).toBe(1);
      expect(flow.features).toEqual(DEFAULT_FEATURES);
      expect(flow.scopes).toEqual(['reports.read']);
      expect(flow.db).toBe('sql');
    });

    it('should record no database when --db was not given', () => {
      expect(buildOpFlow({ features: DEFAULT_FEATURES }).db).toBe(null);
    });
  });

  describe('journey edges', () => {
    it('should connect the Authorization Code Flow endpoints in the order a browser and client follow', () => {
      const flow = buildOpFlow({ features: DEFAULT_FEATURES });
      expect(flow.edges).toEqual([
        { from: 'authorize', to: 'login', label: 'login required', kind: 'flow' },
        { from: 'authorize', to: 'consent', label: 'SSO: consent required', kind: 'flow' },
        { from: 'authorize', to: 'token', label: 'code (prompt=none / SSO)', kind: 'flow' },
        { from: 'login', to: 'consent', label: 'authenticated', kind: 'flow' },
        { from: 'consent', to: 'token', label: 'code', kind: 'flow' },
        { from: 'token', to: 'userinfo', label: 'access_token', kind: 'flow' },
        { from: 'token', to: 'introspection', label: 'token', kind: 'flow' },
        { from: 'token', to: 'revocation', label: 'token', kind: 'flow' },
      ]);
    });

    it('should only draw edges between endpoints that exist', () => {
      const flow = buildOpFlow({ features: { ...DEFAULT_FEATURES, par: true } });
      const parEdges = flow.edges.filter((e) => e.from === 'par');
      expect(parEdges).toEqual([{ from: 'par', to: 'authorize', label: 'request_uri', kind: 'flow' }]);
      const ids = new Set(flow.endpoints.map((e) => e.id));
      expect(flow.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to))).toEqual([]);
    });
  });

  describe('token endpoint steps', () => {
    it('should list the standard pipeline by default', () => {
      const flow = buildOpFlow({ features: DEFAULT_FEATURES });
      const token = flow.endpoints.find((e) => e.id === 'token');
      expect(token?.steps.map((s) => s.id)).toEqual([
        'parse-request',
        'authenticate-client',
        'validate-grant-type',
        'validate-authorization-code-grant',
        'validate-refresh-token-grant',
        'select-signing-keys',
        'resolve-subject',
        'decide-refresh-token-issuance',
        'resolve-acr-amr',
        'issue-access-token',
        'issue-id-token',
        'persist-access-token',
        'issue-refresh-token',
        'revoke-rotated-refresh-token',
        'build-token-response',
        'respond',
        'respond-error',
      ]);
    });

    it('should drop every refresh token step when refresh-token is disabled', () => {
      const flow = buildOpFlow({ features: { ...DEFAULT_FEATURES, refreshToken: false } });
      const token = flow.endpoints.find((e) => e.id === 'token');
      expect(token?.steps.map((s) => s.id)).toEqual([
        'parse-request',
        'authenticate-client',
        'validate-grant-type',
        'validate-authorization-code-grant',
        'select-signing-keys',
        'resolve-subject',
        'resolve-acr-amr',
        'issue-access-token',
        'issue-id-token',
        'persist-access-token',
        'build-token-response',
        'respond',
        'respond-error',
      ]);
    });

    it('should place the experimental grant dispatches between client authentication and grant_type validation', () => {
      const flow = buildOpFlow({ features: ALL_FEATURES });
      const token = flow.endpoints.find((e) => e.id === 'token');
      expect(token?.steps.slice(0, 8).map((s) => s.id)).toEqual([
        'parse-request',
        'authenticate-client',
        'dispatch-id-jag-issuance',
        'dispatch-id-jag-redemption',
        'dispatch-token-exchange',
        'dispatch-device-code',
        'dispatch-ciba',
        'validate-grant-type',
      ]);
    });

    it('should branch from grant_type validation to the two grant validations', () => {
      const flow = buildOpFlow({ features: DEFAULT_FEATURES });
      const token = flow.endpoints.find((e) => e.id === 'token');
      expect(token?.edges.filter((e) => e.from === 'validate-grant-type')).toEqual([
        {
          from: 'validate-grant-type',
          to: 'validate-authorization-code-grant',
          label: 'authorization_code',
          kind: 'branch',
        },
        { from: 'validate-grant-type', to: 'validate-refresh-token-grant', label: 'refresh_token', kind: 'branch' },
        { from: 'validate-grant-type', to: 'respond-error', kind: 'error' },
      ]);
    });
  });

  describe('authorize endpoint steps', () => {
    it('should list the validation pipeline, the transaction and the three ways out', () => {
      const flow = buildOpFlow({ features: DEFAULT_FEATURES });
      const authorize = flow.endpoints.find((e) => e.id === 'authorize');
      expect(authorize?.steps.map((s) => s.id)).toEqual([
        'parse-request',
        'resolve-client',
        'resolve-request-object',
        'resolve-redirect-uri',
        'validate-request',
        'create-transaction',
        'validate-prompt-combination',
        'verify-id-token-hint',
        'authenticate-silently',
        'reuse-session',
        'issue-authorization-code',
        'continue-to-login',
        'respond-error',
      ]);
    });

    it('should add the PAR and JARM steps when those features are enabled', () => {
      const flow = buildOpFlow({ features: { ...DEFAULT_FEATURES, par: true, jarm: true } });
      const authorize = flow.endpoints.find((e) => e.id === 'authorize');
      expect(authorize?.steps.map((s) => s.id).slice(0, 7)).toEqual([
        'parse-request',
        'resolve-pushed-request',
        'resolve-client',
        'resolve-request-object',
        'resolve-redirect-uri',
        'resolve-jarm-response-mode',
        'validate-request',
      ]);
    });

    it('should list the scope policy call only when custom scopes are declared', () => {
      const without = buildOpFlow({ features: DEFAULT_FEATURES });
      const withScopes = buildOpFlow({ features: DEFAULT_FEATURES, scopes: ['reports.read'] });
      const calls = (flow: typeof without) =>
        flow.endpoints.find((e) => e.id === 'authorize')?.steps.find((s) => s.id === 'validate-request')?.calls;
      expect(calls(without)?.includes('findUnsupportedScopes')).toBe(false);
      expect(calls(withScopes)?.includes('findUnsupportedScopes')).toBe(true);
    });
  });

  describe('structure', () => {
    const flows = [
      buildOpFlow({ features: DEFAULT_FEATURES }),
      buildOpFlow({ features: ALL_FEATURES, scopes: ['reports.read'], db: 'kv' }),
      buildOpFlow({ features: { ...DEFAULT_FEATURES, refreshToken: false, requestObject: false } }),
    ];

    it('should give every step of an endpoint a unique id and a unique function name', () => {
      for (const flow of flows) {
        for (const endpoint of flow.endpoints) {
          const ids = endpoint.steps.map((s) => s.id);
          const functions = endpoint.steps.map((s) => s.function);
          expect(new Set(ids).size).toBe(ids.length);
          expect(new Set(functions).size).toBe(functions.length);
        }
      }
    });

    it('should only draw step edges between steps of the same endpoint', () => {
      for (const flow of flows) {
        for (const endpoint of flow.endpoints) {
          const ids = new Set(endpoint.steps.map((s) => s.id));
          expect(endpoint.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to))).toEqual([]);
        }
      }
    });

    it('should name existing steps in after, before and calledFrom', () => {
      for (const flow of flows) {
        for (const endpoint of flow.endpoints) {
          const ids = new Set(endpoint.steps.map((s) => s.id));
          for (const step of endpoint.steps) {
            const references = [...(step.after ?? []), ...(step.before ?? []), ...(step.calledFrom ?? [])];
            expect(references.filter((id) => !ids.has(id))).toEqual([]);
          }
        }
      }
    });

    it('should describe a default step order that --flow accepts unchanged', () => {
      for (const flow of flows) {
        const selection = resolveFlowSelection(flow);
        expect(selection.steps).toEqual({});
        expect(selection.endpointOrder).toEqual(flow.endpoints.map((e) => e.id));
      }
    });
  });
});
