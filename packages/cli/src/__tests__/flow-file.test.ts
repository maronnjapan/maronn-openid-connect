import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES } from '../registry.js';
import { buildOpFlow } from '../flow/build.js';
import { FlowFileError, parseFlowFile, resolveFlowSelection } from '../flow/flow-file.js';
import type { OpFlow } from '../flow/types.js';

/** The JSON `graph --format json` writes for the given inputs, as a plain document. */
function document(overrides: Partial<Parameters<typeof buildOpFlow>[0]> = {}): OpFlow {
  return structuredClone(buildOpFlow({ features: DEFAULT_FEATURES, ...overrides }));
}

function endpointOf(flow: OpFlow, id: string) {
  const endpoint = flow.endpoints.find((e) => e.id === id);
  if (endpoint === undefined) throw new Error(`no endpoint ${id}`);
  return endpoint;
}

describe('resolveFlowSelection', () => {
  describe('document shape', () => {
    it('should reject a document that is not an object', () => {
      expect(() => resolveFlowSelection([])).toThrow('A flow document must be a JSON object');
    });

    it('should reject a document without version 1', () => {
      expect(() => resolveFlowSelection({ version: 2, endpoints: [] })).toThrow(
        'A flow document must have "version": 1',
      );
    });

    it('should reject an unknown feature flag', () => {
      expect(() => resolveFlowSelection({ version: 1, features: { dpop: true }, endpoints: [] })).toThrow(
        'features has an unknown feature "dpop"',
      );
    });

    it('should reject a feature flag that is not a boolean', () => {
      expect(() => resolveFlowSelection({ version: 1, features: { pkce: 'yes' }, endpoints: [] })).toThrow(
        'features.pkce must be true or false',
      );
    });

    it('should reject a feature that needs a disabled feature', () => {
      expect(() =>
        resolveFlowSelection({
          version: 1,
          features: { introspection: false, jwtIntrospectionResponse: true },
          endpoints: [],
        }),
      ).toThrow('Feature "jwt-introspection-response" requires the introspection feature');
    });

    it('should reject an unknown db kind', () => {
      const doc = document();
      (doc as unknown as { db: string }).db = 'redis';
      expect(() => resolveFlowSelection(doc)).toThrow('Unknown --db kind: "redis"');
    });

    it('should reject a scope that is a standard scope', () => {
      const doc = document();
      doc.scopes = ['openid'];
      expect(() => resolveFlowSelection(doc)).toThrow('Scope "openid" is a standard scope');
    });

    it('should throw a FlowFileError for every rejection', () => {
      expect(() => resolveFlowSelection({ version: 1, endpoints: 'token' })).toThrow(FlowFileError);
    });
  });

  describe('endpoints', () => {
    it('should accept the document graph writes and select the catalog as it is', () => {
      const selection = resolveFlowSelection(document());
      expect(selection).toEqual({
        features: DEFAULT_FEATURES,
        scopes: [],
        db: undefined,
        endpointOrder: [
          'discovery',
          'jwks',
          'authorize',
          'login',
          'consent',
          'token',
          'userinfo',
          'introspection',
          'revocation',
        ],
        steps: {},
      });
    });

    it('should carry the generation inputs of the document', () => {
      const selection = resolveFlowSelection(document({ scopes: ['reports.read'], db: 'kv' }));
      expect(selection.scopes).toEqual(['reports.read']);
      expect(selection.db).toBe('kv');
    });

    it('should keep the endpoint order of the document', () => {
      const doc = document();
      doc.endpoints.reverse();
      expect(resolveFlowSelection(doc).endpointOrder).toEqual([
        'revocation',
        'introspection',
        'userinfo',
        'token',
        'consent',
        'login',
        'authorize',
        'jwks',
        'discovery',
      ]);
    });

    it('should accept endpoints given as bare ids', () => {
      const selection = resolveFlowSelection({
        version: 1,
        features: { introspection: false, revocation: false },
        endpoints: ['token', 'authorize', 'login', 'consent', 'userinfo', 'discovery', 'jwks'],
      });
      expect(selection.endpointOrder).toEqual([
        'token',
        'authorize',
        'login',
        'consent',
        'userinfo',
        'discovery',
        'jwks',
      ]);
    });

    it('should reject an unknown endpoint', () => {
      const doc = document();
      doc.endpoints.push({ ...endpointOf(doc, 'token'), id: 'dpop' });
      expect(() => resolveFlowSelection(doc)).toThrow(
        'Unknown endpoint "dpop". Endpoints of this configuration: discovery, jwks, authorize, login, consent, token, userinfo, introspection, revocation',
      );
    });

    it('should reject an endpoint listed twice', () => {
      const doc = document();
      doc.endpoints.push(endpointOf(doc, 'token'));
      expect(() => resolveFlowSelection(doc)).toThrow('endpoints lists "token" twice');
    });

    it('should reject a document that leaves out a required endpoint', () => {
      const doc = document();
      doc.endpoints = doc.endpoints.filter((e) => e.id !== 'token');
      expect(() => resolveFlowSelection(doc)).toThrow(
        'Endpoint "token" (/token) is required and cannot be left out',
      );
    });

    it('should tell how to leave out an endpoint a feature generates', () => {
      const doc = document();
      doc.endpoints = doc.endpoints.filter((e) => e.id !== 'introspection');
      expect(() => resolveFlowSelection(doc)).toThrow(
        'Endpoint "introspection" (/introspect) is generated by features.introspection. Set features.introspection to false to leave it out',
      );
    });

    it('should leave out an endpoint whose feature the document disables', () => {
      const doc = document({ features: { ...DEFAULT_FEATURES, introspection: false } });
      expect(resolveFlowSelection(doc).endpointOrder.includes('introspection')).toBe(false);
    });
  });

  describe('steps of a rearrangeable endpoint', () => {
    it('should record nothing for an endpoint whose steps match the catalog', () => {
      expect(resolveFlowSelection(document()).steps).toEqual({});
    });

    it('should accept steps given as bare ids', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      (token as unknown as { steps: string[] }).steps = token.steps.map((s) => s.id);
      expect(resolveFlowSelection(doc).steps).toEqual({});
    });

    it('should record the remaining steps when a removable step is left out', () => {
      const doc = document();
      const authorize = endpointOf(doc, 'authorize');
      authorize.steps = authorize.steps.filter((s) => s.id !== 'verify-id-token-hint');
      expect(resolveFlowSelection(doc).steps).toEqual({
        authorize: [
          'parse-request',
          'resolve-client',
          'resolve-request-object',
          'resolve-redirect-uri',
          'resolve-form-post-response-mode',
          'validate-request',
          'create-transaction',
          'validate-prompt-combination',
          'authenticate-silently',
          'reuse-session',
          'issue-authorization-code',
          'continue-to-login',
          'respond-error',
        ],
      });
    });

    it('should record a reordered pipeline when the data flow still holds', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      const ids = token.steps.map((s) => s.id);
      // revoke the presented refresh token right after the new one is stored,
      // before the response body is built: same data flow, different order.
      const persist = ids.indexOf('persist-access-token');
      const issueRefresh = ids.indexOf('issue-refresh-token');
      [ids[persist], ids[issueRefresh]] = [ids[issueRefresh] as string, ids[persist] as string];
      (token as unknown as { steps: string[] }).steps = ids;
      expect(resolveFlowSelection(doc).steps['token']).toEqual(ids);
    });

    it('should reject an unknown step', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      (token as unknown as { steps: string[] }).steps = [...token.steps.map((s) => s.id), 'dpop'];
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "token" has an unknown step "dpop". Steps of this endpoint: parse-request, authenticate-client, validate-grant-type',
      );
    });

    it('should reject a step listed twice', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      (token as unknown as { steps: string[] }).steps = [...token.steps.map((s) => s.id), 'respond'];
      expect(() => resolveFlowSelection(doc)).toThrow('endpoints[5].steps lists "respond" twice');
    });

    it('should reject leaving out a step that cannot be removed', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      token.steps = token.steps.filter((s) => s.id !== 'authenticate-client');
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "token" leaves out step "authenticate-client", which cannot be removed',
      );
    });

    it('should tell how to leave out a step a feature generates', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      token.steps = token.steps.filter((s) => s.id !== 'validate-refresh-token-grant');
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "token" leaves out step "validate-refresh-token-grant", which the feature features.refreshToken generates. Set features.refreshToken to false to leave the feature out',
      );
    });

    it('should reject leaving out a step another kept step calls', () => {
      const doc = document();
      const authorize = endpointOf(doc, 'authorize');
      authorize.steps = authorize.steps.filter((s) => s.id !== 'issue-authorization-code');
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "authorize" leaves out step "issue-authorization-code", which step "authenticate-silently" and "reuse-session" calls',
      );
    });

    it('should accept leaving out a called step together with every caller', () => {
      const doc = document();
      const authorize = endpointOf(doc, 'authorize');
      authorize.steps = authorize.steps.filter(
        (s) => !['authenticate-silently', 'reuse-session', 'issue-authorization-code'].includes(s.id),
      );
      expect(resolveFlowSelection(doc).steps['authorize']).toEqual([
        'parse-request',
        'resolve-client',
        'resolve-request-object',
        'resolve-redirect-uri',
        'resolve-form-post-response-mode',
        'validate-request',
        'create-transaction',
        'validate-prompt-combination',
        'verify-id-token-hint',
        'continue-to-login',
        'respond-error',
      ]);
    });

    it('should reject an order in which a step reads a value produced later', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      const ids = token.steps.map((s) => s.id);
      const [authenticate] = ids.splice(1, 1);
      ids.splice(2, 0, authenticate as string);
      (token as unknown as { steps: string[] }).steps = ids;
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "token": step "validate-grant-type" reads "tokenClient", which no earlier step produces (produced by "authenticate-client")',
      );
    });

    it('should reject an order that breaks a required precedence', () => {
      const doc = document({ features: { ...DEFAULT_FEATURES, tokenExchange: true } });
      const token = endpointOf(doc, 'token');
      const ids = token.steps.map((s) => s.id);
      const dispatch = ids.indexOf('dispatch-token-exchange');
      const grantType = ids.indexOf('validate-grant-type');
      [ids[dispatch], ids[grantType]] = [ids[grantType] as string, ids[dispatch] as string];
      (token as unknown as { steps: string[] }).steps = ids;
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "token": step "dispatch-token-exchange" must come before step "validate-grant-type"',
      );
    });

    it('should reject an order that moves a step before the one it must follow', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      const ids = token.steps.map((s) => s.id);
      const revoke = ids.indexOf('revoke-rotated-refresh-token');
      const issueRefresh = ids.indexOf('issue-refresh-token');
      [ids[revoke], ids[issueRefresh]] = [ids[issueRefresh] as string, ids[revoke] as string];
      (token as unknown as { steps: string[] }).steps = ids;
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "token": step "revoke-rotated-refresh-token" must come after step "issue-refresh-token"',
      );
    });

    // RFC 9068 §2.2.1: the access token carries the acr the step resolves, so
    // the step can be left out (no acr) but not moved after the access token.
    it('should accept leaving out the acr / amr resolution of the token endpoint', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      token.steps = token.steps.filter((s) => s.id !== 'resolve-acr-amr');
      expect(resolveFlowSelection(doc).steps['token']).toEqual(token.steps.map((s) => s.id));
    });

    it('should reject resolving the acr after the access token that carries it', () => {
      const doc = document();
      const token = endpointOf(doc, 'token');
      const ids = token.steps.map((s) => s.id);
      const resolveAcr = ids.indexOf('resolve-acr-amr');
      const issueAccessToken = ids.indexOf('issue-access-token');
      [ids[resolveAcr], ids[issueAccessToken]] = [ids[issueAccessToken] as string, ids[resolveAcr] as string];
      (token as unknown as { steps: string[] }).steps = ids;
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "token": step "issue-access-token" reads "acr", which no earlier step produces (produced by "resolve-acr-amr")',
      );
    });
  });

  describe('steps of a fixed endpoint', () => {
    it('should accept the catalog steps of a screen endpoint unchanged', () => {
      const doc = document();
      expect(resolveFlowSelection(doc).steps['login']).toBe(undefined);
    });

    it('should reject removing a step of a screen endpoint', () => {
      const doc = document();
      const login = endpointOf(doc, 'login');
      login.steps = login.steps.filter((s) => s.id !== 'validate-csrf-token');
      expect(() => resolveFlowSelection(doc)).toThrow(
        'endpoint "login" has a fixed sequence of steps: load-transaction, describe-login-screen, reject-cross-origin-post, validate-csrf-token, authenticate-user, record-login-failure, discard-session-for-fresh-login, establish-session, hand-off-to-consent. Its steps cannot be removed or reordered',
      );
    });
  });
});

describe('parseFlowFile', () => {
  it('should name the file in a JSON error', () => {
    expect(() => parseFlowFile('{', 'op.flow.json')).toThrow(/^op\.flow\.json is not valid JSON: /);
  });

  it('should name the file in a validation error', () => {
    expect(() => parseFlowFile('{"version":1,"endpoints":[]}', 'op.flow.json')).toThrow(
      'op.flow.json: Endpoint "discovery" (/.well-known/openid-configuration) is required and cannot be left out',
    );
  });

  it('should resolve a valid document', () => {
    const text = JSON.stringify(buildOpFlow({ features: DEFAULT_FEATURES }));
    expect(parseFlowFile(text, 'op.flow.json').endpointOrder[0]).toBe('discovery');
  });
});
