/**
 * Apply the OpenID Connect Provider to an Express app.
 *
 * Every path the provider serves (providerRoutes() of app.ts: the endpoints
 * of every provider and those of the generated features) is handed to the
 * provider's router; app.use() matches a path with everything below it, so
 * /device also covers /device/login and /device/approve.
 *
 * @example
 * import express from 'express';
 * import { applyOidc } from './oidc-provider/apply.js';
 *
 * const app = express();
 * applyOidc(app, { signingKeyProvider: yourProvider, config: { issuer: 'https://op.example.com' } });
 */
import type { Express, NextFunction, Request, Response } from 'express';
import { createApp, providerRoutes, type OidcProviderOptions } from './app.js';
import { toWebRequest, writeWebResponse } from './node-adapter.js';

export type ApplyOidcOptions = OidcProviderOptions;

export function applyOidc(app: Express, options: ApplyOidcOptions): void {
  const oidc = createApp(options);
  // The advertised issuer is the source of truth for the OP's own origin
  // (OIDC Discovery 1.0 §3); the node adapter drops the request's Host-derived
  // origin in favor of this value.
  const baseUrl = options.config?.issuer ?? 'http://localhost';

  for (const route of providerRoutes()) {
    app.use(route.path, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const response = await oidc.request(toWebRequest(req, baseUrl));
        await writeWebResponse(res, response);
      } catch (error) {
        next(error);
      }
    });
  }
}
