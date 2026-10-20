/**
 * The features of this provider, in the order their hooks apply.
 *
 * `maronn-oidc generate` writes this file with the features of --enable /
 * --disable, one import and one entry each. To remove a feature by hand,
 * delete its line in both places, its directory under features/, the owner
 * blocks that name it in the pipelines (with their imports) and the lines of
 * its steps in the endpoint.ts files (with the edges to and from them).
 */
import type { Feature } from './feature.js';
import { pkce } from './pkce/feature.js';
import { refreshToken } from './refresh-token/feature.js';
import { introspection } from './introspection/feature.js';
import { revocation } from './revocation/feature.js';
import { requestObject } from './request-object/feature.js';
import { formPostResponseMode } from './form-post-response-mode/feature.js';
import { implicitFlow } from './implicit-flow/feature.js';
import { par } from './par/feature.js';
import { tokenExchange } from './token-exchange/feature.js';
import { jarm } from './jarm/feature.js';
import { deviceAuthorizationGrant } from './device-authorization-grant/feature.js';
import { idJag } from './id-jag/feature.js';
import { ciba } from './ciba/feature.js';
import { jwtIntrospectionResponse } from './jwt-introspection-response/feature.js';
import { rpInitiatedLogout } from './rp-initiated-logout/feature.js';
import { dynamicClientRegistration } from './dynamic-client-registration/feature.js';

export const features: readonly Feature[] = [
  pkce,
  refreshToken,
  introspection,
  revocation,
  requestObject,
  formPostResponseMode,
  implicitFlow,
  par,
  tokenExchange,
  jarm,
  deviceAuthorizationGrant,
  idJag,
  ciba,
  jwtIntrospectionResponse,
  rpInitiatedLogout,
  dynamicClientRegistration,
];
