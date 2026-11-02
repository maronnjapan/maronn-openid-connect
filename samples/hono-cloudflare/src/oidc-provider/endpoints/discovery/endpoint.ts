import { defineEndpoint } from '../step.js';

/**
 * Publish the OpenID Provider metadata as JSON: the issuer, the URLs of the
 * endpoints, and the response types, grants, scopes, claims and signing
 * algorithms the provider supports.
 *
 * @spec OIDC Discovery 1.0 §4
 */
export const endpoint = defineEndpoint({
  id: 'discovery',
  order: 10,
  label: 'Discovery',
  path: '/.well-known/openid-configuration',
  methods: ['GET'],
  layer: 'metadata',
  group: { id: 'metadata', label: 'Metadata' },
  spec: 'OIDC Discovery 1.0 §4',
  rearrangeable: true,
  steps: [
    'collect-signing-algorithms',
    'build-metadata',
    'respond',
  ],
  edges: {
    chain: true,
  },
});
