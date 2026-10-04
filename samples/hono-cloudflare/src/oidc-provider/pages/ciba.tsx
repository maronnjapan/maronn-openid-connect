/** @jsxImportSource hono/jsx */
/**
 * EXPERIMENTAL — CIBA authentication device screens (CIBA Core 1.0 §7.1),
 * screen routing layer.
 *
 * The user signs in at /ciba, reviews the pending requests addressed to them
 * (client, scopes, binding_message) and approves or denies. All three routes of
 * that UI are here; none of them holds logic. prepareCibaDevice(),
 * submitCibaLogin() and submitCibaDecision() in routes/ciba-verification.ts
 * mint the login transaction, check the credentials, list the requests and
 * record the decision, and report what happened as an outcome. This file turns
 * each outcome into a screen, with the cookies the outcome carries. To
 * customize the CIBA UI, edit this file or the ciba* views in views.tsx; the
 * route module never has to change.
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import { Hono } from 'hono';
import {
  prepareCibaDevice,
  submitCibaDecision,
  submitCibaLogin,
  type CibaOutcome,
} from '../routes/ciba-verification.js';
import {
  defaultViews,
  renderView,
  type CibaCompletedPageParams,
  type CibaLoginPageParams,
  type CibaPendingRequestsPageParams,
  type Views,
} from '../views.js';
import { renderErrorPage } from './errors.js';
import { withCookies } from './respond.js';

export const cibaPage = new Hono<{ Variables: Record<string, any> }>();

/** Render the sign-in form of the authentication device UI. */
export function renderCibaLoginPage(c: any, params: CibaLoginPageParams): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.cibaLoginPage {...params} />);
}

/** Render the pending-requests approval screen (CIBA Core 1.0 §7.1 binding_message). */
export function renderCibaPendingRequestsPage(
  c: any,
  params: CibaPendingRequestsPageParams,
): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.cibaPendingRequestsPage {...params} />);
}

/** Render the decision-recorded screen. */
export function renderCibaCompletedPage(c: any, params: CibaCompletedPageParams): Response {
  const views: Views = c.get('views') ?? defaultViews;
  return renderView(<views.cibaCompletedPage {...params} />);
}

/** Turn the outcome of a step into the screen that follows it. */
function respond(c: any, outcome: CibaOutcome): Response {
  if (outcome.kind === 'error') return renderErrorPage(c, outcome);
  if (outcome.kind === 'session_required') {
    return renderErrorPage(c, {
      error: 'Sign in again to review this request',
      statusCode: 401,
    });
  }
  if (outcome.kind === 'invalid_decision') {
    return renderErrorPage(c, {
      error: 'invalid_request',
      errorDescription: 'decision must be approve or deny',
      statusCode: 400,
    });
  }
  if (outcome.kind === 'locked_out') {
    // The login transaction is gone: this form cannot be retried at all.
    return renderErrorPage(c, {
      error: 'Too many login attempts',
      statusCode: 429,
    });
  }
  if (outcome.kind === 'login') {
    return withCookies(renderCibaLoginPage(c, {
      loginTransactionId: outcome.loginTransactionId,
      csrfToken: outcome.csrfToken,
    }), outcome.cookies);
  }
  if (outcome.kind === 'invalid_credentials') {
    return renderCibaLoginPage(c, {
      loginTransactionId: outcome.loginTransactionId,
      csrfToken: outcome.csrfToken,
      error: 'Invalid credentials',
      remainingAttempts: outcome.remainingAttempts,
    });
  }
  if (outcome.kind === 'pending_requests') {
    return withCookies(
      renderCibaPendingRequestsPage(c, { requests: outcome.requests }),
      outcome.cookies,
    );
  }
  return renderCibaCompletedPage(c, {
    approved: outcome.approved,
    clientId: outcome.clientId,
  });
}

/**
 * Listing / login form - GET
 *
 * With an OP session: the pending requests addressed to the signed-in user.
 * Without one: the sign-in form, with the binding cookie its submission needs.
 */
cibaPage.get('/', async (c) => respond(c, await prepareCibaDevice(c)));

/** Sign in - POST */
cibaPage.post('/login', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitCibaLogin(c, {
    loginTransactionId: String(body['login_transaction_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    username: String(body['username'] ?? ''),
    password: String(body['password'] ?? ''),
  }));
});

/** Approve or deny - POST */
cibaPage.post('/approve', async (c) => {
  const body = await c.req.parseBody();
  return respond(c, await submitCibaDecision(c, {
    authReqId: String(body['auth_req_id'] ?? ''),
    csrfToken: String(body['csrf_token'] ?? ''),
    decision: String(body['decision'] ?? ''),
  }));
});
