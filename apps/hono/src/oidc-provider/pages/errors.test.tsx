/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../test-support/context.js';
import { createViews, type ErrorPageParams } from '../views.js';
import { renderAuthorizationErrorPage, renderErrorPage } from './errors.js';

const customViews = createViews({
  errorPage: (params: ErrorPageParams) => (
    <main>
      {params.statusCode}: {params.error}
    </main>
  ),
});

describe('renderErrorPage', () => {
  it('should answer the default error view with statusCode as the HTTP status', async () => {
    const response = renderErrorPage(contextOf(), {
      error: 'Too many login attempts',
      statusCode: 429,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    expect(await response.text()).toBe(
      '<!DOCTYPE html><html><head><title>Error</title></head><body><h1>Error</h1><p>Too many login attempts</p></body></html>',
    );
  });

  it('should render the error view of the request context with the same statusCode', async () => {
    const response = renderErrorPage(contextOf(undefined, { views: customViews }), {
      error: 'Forbidden',
      statusCode: 403,
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('<main>403: Forbidden</main>');
  });
});

describe('renderAuthorizationErrorPage', () => {
  // OIDC Core 1.0 §3.1.2.2 / RFC 6749 §4.1.2.1: an error without a trusted redirect target stays on the OP.
  it('should answer 400 with the error and its description', async () => {
    const response = renderAuthorizationErrorPage(contextOf(), {
      error: 'invalid_request',
      errorDescription: 'redirect_uri is not registered',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      '<!DOCTYPE html><html><head><title>Error</title></head><body><h1>Error</h1><p>invalid_request</p><p>redirect_uri is not registered</p></body></html>',
    );
  });
});
