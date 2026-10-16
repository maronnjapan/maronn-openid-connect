import { describe, it, expect } from 'vitest';
import { DEFAULT_FEATURES } from '../features.js';
import { buildOpFlow } from '../flow/catalog.js';
import { renderMermaid } from '../flow/mermaid.js';
import type { OpFlow } from '../flow/types.js';

/** A two-endpoint OP, small enough to pin the whole rendering. */
const tinyFlow: OpFlow = {
  version: 1,
  features: DEFAULT_FEATURES,
  scopes: [],
  db: null,
  endpoints: [
    {
      id: 'jwks',
      label: 'JWKS',
      path: '/.well-known/jwks.json',
      methods: ['GET'],
      layer: 'metadata',
      group: { id: 'metadata', label: 'Metadata' },
      rearrangeable: true,
      steps: [
        {
          id: 'collect-public-keys',
          label: 'Collect every registered signing key',
          kind: 'resolve',
          function: 'collectPublishedKeys',
          calls: [],
          consumes: [],
          produces: ['keys'],
          removable: false,
        },
        {
          id: 'respond',
          label: 'Respond with the "cacheable" JWK Set',
          kind: 'respond',
          spec: 'RFC 7517 §5',
          function: 'respondJwks',
          calls: [],
          consumes: ['keys'],
          produces: [],
          removable: false,
        },
      ],
      edges: [{ from: 'collect-public-keys', to: 'respond', kind: 'flow' }],
    },
    {
      id: 'token',
      label: 'Token endpoint',
      path: '/token',
      methods: ['POST'],
      layer: 'api',
      group: { id: 'authorization-code', label: 'Authorization Code Flow' },
      rearrangeable: true,
      steps: [
        {
          id: 'validate-grant-type',
          label: 'Validate grant_type',
          kind: 'validate',
          function: 'validateTokenGrantType',
          calls: [],
          consumes: [],
          produces: ['grantType'],
          removable: false,
        },
        {
          id: 'respond-error',
          label: 'Respond with the OAuth error',
          kind: 'respond',
          function: 'respondTokenError',
          calls: [],
          consumes: [],
          produces: [],
          removable: false,
        },
      ],
      edges: [
        { from: 'validate-grant-type', to: 'respond-error', label: 'authorization_code', kind: 'branch' },
        { from: 'validate-grant-type', to: 'respond-error', kind: 'error' },
      ],
    },
  ],
  edges: [{ from: 'jwks', to: 'token', label: 'keys', kind: 'flow' }],
};

describe('renderMermaid', () => {
  describe('endpoint detail', () => {
    it('should draw one box per endpoint inside its group and the arrows between them', () => {
      expect(renderMermaid(tinyFlow)).toBe(
        [
          'flowchart LR',
          '  subgraph metadata["Metadata"]',
          '    jwks["GET /.well-known/jwks.json<br/>JWKS"]',
          '  end',
          '  subgraph authorization_code["Authorization Code Flow"]',
          '    token["POST /token<br/>Token endpoint"]',
          '  end',
          '  jwks -->|"keys"| token',
          '',
        ].join('\n'),
      );
    });

    it('should draw only the selected endpoints and the arrows among them', () => {
      expect(renderMermaid(tinyFlow, { endpoints: ['token'] })).toBe(
        [
          'flowchart LR',
          '  subgraph authorization_code["Authorization Code Flow"]',
          '    token["POST /token<br/>Token endpoint"]',
          '  end',
          '',
        ].join('\n'),
      );
    });

    it('should reject an endpoint that is not in the flow', () => {
      expect(() => renderMermaid(tinyFlow, { endpoints: ['userinfo'] })).toThrow(
        'Unknown endpoint: "userinfo". Endpoints of this configuration: jwks, token',
      );
    });
  });

  describe('step detail', () => {
    it('should draw every step as a box inside its endpoint with the pipeline arrows', () => {
      expect(renderMermaid(tinyFlow, { detail: 'steps' })).toBe(
        [
          'flowchart TD',
          '  subgraph jwks["GET /.well-known/jwks.json<br/>JWKS"]',
          '    direction TB',
          '    jwks__collect_public_keys["<b>Collect every registered signing key</b><br/>collectPublishedKeys()"]:::resolve',
          '    jwks__respond["<b>Respond with the #quot;cacheable#quot; JWK Set</b><br/>respondJwks()<br/><small>RFC 7517 §5</small>"]:::respond',
          '    jwks__collect_public_keys --> jwks__respond',
          '  end',
          '  subgraph token["POST /token<br/>Token endpoint"]',
          '    direction TB',
          '    token__validate_grant_type["<b>Validate grant_type</b><br/>validateTokenGrantType()"]:::validate',
          '    token__respond_error["<b>Respond with the OAuth error</b><br/>respondTokenError()"]:::respond',
          '    token__validate_grant_type -->|"authorization_code"| token__respond_error',
          '    token__validate_grant_type -.-> token__respond_error',
          '  end',
          '  jwks -->|"keys"| token',
          '  classDef resolve fill:#ecfeff,stroke:#0891b2',
          '  classDef validate fill:#fff7ed,stroke:#ea580c',
          '  classDef respond fill:#f8fafc,stroke:#475569',
          '',
        ].join('\n'),
      );
    });

    it('should leave out the error arrows when asked', () => {
      const rendered = renderMermaid(tinyFlow, { detail: 'steps', errorEdges: false });
      expect(rendered.includes('-.->')).toBe(false);
      expect(rendered.includes('token__validate_grant_type -->|"authorization_code"| token__respond_error')).toBe(true);
    });
  });

  describe('catalog', () => {
    it('should render the default OP with its Authorization Code Flow arrows', () => {
      const rendered = renderMermaid(buildOpFlow({ features: DEFAULT_FEATURES }));
      expect(rendered.split('\n').slice(0, 4)).toEqual([
        'flowchart LR',
        '  subgraph metadata["Metadata"]',
        '    discovery["GET /.well-known/openid-configuration<br/>Discovery"]',
        '    jwks["GET /.well-known/jwks.json<br/>JWKS"]',
      ]);
      expect(rendered.includes('  authorize -->|"login required"| login\n')).toBe(true);
      expect(rendered.includes('  consent -->|"code"| token\n')).toBe(true);
    });
  });
});
