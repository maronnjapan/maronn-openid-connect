import type { Express } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createApp, type OidcProviderOptions } from './app.js';
import { toWebRequest, writeWebResponse } from './node-adapter.js';

export type ApplyOidcOptions = OidcProviderOptions;

const OIDC_ENDPOINTS = [
  '/authorize',
  '/token',
  '/userinfo',
  '/introspect',
  '/revoke',
  '/device_authorization',
  '/device',
  '/.well-known/jwks.json',
  '/.well-known/openid-configuration',
  '/login',
  '/consent',
] as const;

export function applyOidc(app: Express, options: ApplyOidcOptions): void {
  const oidc = createApp(options);
  const baseUrl = options.config?.issuer ?? 'http://localhost';

  for (const endpoint of OIDC_ENDPOINTS) {
    app.use(endpoint, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const response = await oidc.request(toWebRequest(req, baseUrl));
        await writeWebResponse(res, response);
      } catch (error) {
        next(error);
      }
    });
  }
}
