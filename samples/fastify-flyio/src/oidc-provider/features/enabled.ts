/**
 * The features of this provider, in the order their hooks apply.
 *
 * `maronn-oidc generate` writes this file with the features of --enable /
 * --disable, one import and one entry each. To remove a feature by hand,
 * delete its line in both places, its directory under features/ and the
 * owner blocks that name it in the pipelines (with their imports).
 */
import type { Feature } from './feature.js';
import { pkce } from './pkce/feature.js';
import { refreshToken } from './refresh-token/feature.js';
import { introspection } from './introspection/feature.js';
import { revocation } from './revocation/feature.js';
import { requestObject } from './request-object/feature.js';
import { deviceAuthorizationGrant } from './device-authorization-grant/feature.js';
import { ciba } from './ciba/feature.js';
import { googleLogin } from './google-login/feature.js';

export const features: readonly Feature[] = [
  pkce,
  refreshToken,
  introspection,
  revocation,
  requestObject,
  deviceAuthorizationGrant,
  ciba,
  googleLogin,
];
