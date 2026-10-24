/**
 * HTML responses for the screens that are served by Route Handlers instead of
 * React pages: the device verification UI, the CIBA authentication device UI,
 * the RP-Initiated Logout screens and the form of a form_post authorization
 * response.
 *
 * Those screens set a cookie on the very response that renders them (a browser
 * binding, or a confirmation secret), and their failures carry a status code
 * (403, 429, ...) that the security model and its tests rely on. A Server
 * Component can do neither, and Next.js does not render React from a Route
 * Handler, so these stay plain HTML responses. Every other screen of the OP is
 * a React page (login, consent, oidc-error).
 */

/** Escape a value for HTML text and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An HTML page, with the Set-Cookie values the step that rendered it decided on.
 *
 * Every screen is rendered for the binding or session of this browser's cookie,
 * at a URL that names neither. A stored copy would show one browser's
 * csrf_token to another browser or to a later flow, so the page tells the
 * browser and any intermediary not to store it (RFC 9111 §5.2.2.5). Next.js
 * sends the React pages (login, consent) with no-store itself, because they
 * render dynamically, but leaves the headers of a Route Handler to the handler.
 */
export function htmlResponse(
  html: string,
  init: { status?: number; cookies?: readonly string[] } = {},
): Response {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' });
  for (const cookie of init.cookies ?? []) {
    headers.append('Set-Cookie', cookie);
  }
  return new Response(html, { status: init.status ?? 200, headers });
}

/**
 * The OP's own error page. statusCode is the HTTP status and nothing else, so
 * the page never claims a different outcome than the response (a 429 lockout
 * answers 429, a 403 binding failure 403).
 */
export function errorPage(error: string, statusCode: number, errorDescription?: string): Response {
  const descriptionHtml = errorDescription ? `  <p>${escapeHtml(errorDescription)}</p>\n` : '';
  return htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>Error</h1>
  <p>${escapeHtml(error)}</p>
${descriptionHtml}</body>
</html>`,
    { status: statusCode },
  );
}

/**
 * OAuth 2.0 Form Post Response Mode §2: the authorization response as an HTML
 * form whose action is the client's redirect URI and whose method is POST,
 * one hidden field per parameter. The script submits it as soon as it is
 * parsed (Appendix A does the same from body onload), and the button inside
 * noscript lets a browser without JavaScript continue. The response is used
 * only once, so the User Agent and any intermediaries are told not to store
 * it, with the headers of Appendix A.
 */
export function formPostPage(action: string, fields: Readonly<Record<string, string>>): Response {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `    <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}"/>\n`)
    .join('');
  const response = htmlResponse(
    `<!DOCTYPE html>
<html>
<head><title>Submit This Form</title></head>
<body>
  <form method="post" action="${escapeHtml(action)}">
${inputs}    <noscript><button type="submit">Continue</button></noscript>
  </form>
  <script>document.forms[0].submit();</script>
</body>
</html>`,
  );
  response.headers.set('Cache-Control', 'no-cache, no-store');
  response.headers.set('Pragma', 'no-cache');
  return response;
}
