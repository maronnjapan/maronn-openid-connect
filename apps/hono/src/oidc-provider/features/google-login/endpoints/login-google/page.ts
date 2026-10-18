import { Hono } from 'hono';
import { consentScreenUrl } from '../../../../endpoints/login/page.js';
import { renderErrorPage } from '../../../../pages/errors.js';
import { redirectWithCookies } from '../../../../pages/respond.js';
import { completeGoogleLogin } from './pipeline.js';

/**
 * EXTENSION (google-login) — Google login callback (login_uri) - POST
 *
 * completeGoogleLogin() (pipeline.ts) verifies the posted ID token and
 * establishes the OP session exactly like a password login; this handler only
 * continues to the consent step or shows the error page.
 */
export const loginGooglePage = new Hono<{ Variables: Record<string, any> }>();

loginGooglePage.post('/', async (c) => {
  const outcome = await completeGoogleLogin(c);
  if (outcome.kind === 'not_configured') {
    return renderErrorPage(c, {
      error: 'not_found',
      errorDescription: 'Google login is not configured',
      statusCode: 404,
    });
  }
  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  return redirectWithCookies(consentScreenUrl(c), outcome.cookies);
});
