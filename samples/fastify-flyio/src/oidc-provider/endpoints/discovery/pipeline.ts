import { WebRouter } from '../../web-router.js';
import { buildDiscoveryMetadata } from './steps/build-metadata.js';
import { collectAdvertisedSigningKeys } from './steps/collect-signing-algorithms.js';
import { respondDiscovery } from './steps/respond.js';

/**
 * OpenID Connect Discovery endpoint (API layer).
 * OIDC Discovery 1.0 Section 4
 *
 * Each block below calls one step of the endpoint (steps/), one box of
 * `maronn-oidc graph --detail steps --endpoint discovery`.
 */
export const discoveryApp = new WebRouter();

discoveryApp.get('/', (c) => {
  // [collect-signing-algorithms] 公開する署名アルゴリズムを集める — OIDC Core 1.0 §15.1 / §5.3.2
  const { idTokenSigningKeys, userinfoSigningAlgValues } = collectAdvertisedSigningKeys(c);

  // [build-metadata] OP のメタデータを組み立てる — OIDC Discovery 1.0 §3 / RFC 8414
  const metadata = buildDiscoveryMetadata(c, { idTokenSigningKeys, userinfoSigningAlgValues });

  // [respond] キャッシュ可能な JSON で応答する — RFC 8414 §3.2
  return respondDiscovery(c, metadata);
});
