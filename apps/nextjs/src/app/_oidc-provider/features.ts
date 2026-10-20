/**
 * The features of this provider, in the order their hooks apply.
 *
 * `maronn-oidc generate` writes this file with the features of --enable /
 * --disable, one import and one entry each. To remove a feature by hand,
 * delete its line in both places, its directory under features/, its route
 * group app/(<feature-id>)/, and the owner blocks that name it in the
 * route.ts files (with their imports and their steps in endpoint.ts).
 */
import type { Feature } from './feature';
import { pkce } from './features/pkce/feature';
import { refreshToken } from './features/refresh-token/feature';
import { introspection } from './features/introspection/feature';
import { revocation } from './features/revocation/feature';
import { requestObject } from './features/request-object/feature';
import { formPostResponseMode } from './features/form-post-response-mode/feature';
import { par } from './features/par/feature';
import { tokenExchange } from './features/token-exchange/feature';
import { jarm } from './features/jarm/feature';
import { deviceAuthorizationGrant } from './features/device-authorization-grant/feature';
import { idJag } from './features/id-jag/feature';
import { ciba } from './features/ciba/feature';
import { jwtIntrospectionResponse } from './features/jwt-introspection-response/feature';
import { rpInitiatedLogout } from './features/rp-initiated-logout/feature';
import { dynamicClientRegistration } from './features/dynamic-client-registration/feature';
import { googleLogin } from './features/google-login/feature';

export const features: readonly Feature[] = [
  pkce,
  refreshToken,
  introspection,
  revocation,
  requestObject,
  formPostResponseMode,
  par,
  tokenExchange,
  jarm,
  deviceAuthorizationGrant,
  idJag,
  ciba,
  jwtIntrospectionResponse,
  rpInitiatedLogout,
  dynamicClientRegistration,
  googleLogin,
];
