import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '3020');
const issuer = process.env.ISSUER ?? 'http://127.0.0.1:3010';
const clientBaseUrl = process.env.CLIENT_BASE_URL ?? `http://${host}:${port}`;
const resourceServerUrl = process.env.RESOURCE_SERVER_URL ?? 'http://127.0.0.1:3030';
const clientId = process.env.CLIENT_ID ?? 'e2e-client';
const clientSecret = process.env.CLIENT_SECRET ?? 'e2e-client-secret';
const redirectUri = new URL('/callback', clientBaseUrl).toString();
const transactions = new Map();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', clientBaseUrl);
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      sendHtml(res, 200, '<!doctype html><html><body><a href="/start">Start</a></body></html>');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/start') {
      await startAuthorization(url, res);
      return;
    }
    // EXPERIMENTAL (RFC 9126): push the authorization request over the back
    // channel first, then send the browser to /authorize with only client_id and
    // the returned request_uri.
    if (req.method === 'GET' && url.pathname === '/start-par') {
      await startPushedAuthorization(url, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/callback') {
      await handleCallback(url, res);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    sendHtml(res, 500, renderError(error));
  }
});

server.listen(port, host, () => {
  console.log(`E2E client listening on http://${host}:${port}`);
});

async function startAuthorization(requestUrl, res) {
  const state = randomString(32);
  const nonce = randomString(32);
  const codeVerifier = randomString(64);
  const codeChallenge = pkceChallenge(codeVerifier);
  transactions.set(state, {
    nonce,
    codeVerifier,
    createdAt: Date.now(),
  });

  const authorizationUrl = new URL('/authorize', issuer);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set(
    'scope',
    requestUrl.searchParams.get('scope') ?? 'openid profile email',
  );
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('nonce', nonce);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('audience', resourceServerUrl);
  copyOptionalSearchParam(requestUrl, authorizationUrl, 'prompt');
  copyOptionalSearchParam(requestUrl, authorizationUrl, 'id_token_hint');
  copyOptionalSearchParam(requestUrl, authorizationUrl, 'acr_values');

  redirect(res, authorizationUrl.toString());
}

async function startPushedAuthorization(requestUrl, res) {
  const state = randomString(32);
  const nonce = randomString(32);
  const codeVerifier = randomString(64);
  const codeChallenge = pkceChallenge(codeVerifier);
  transactions.set(state, {
    nonce,
    codeVerifier,
    createdAt: Date.now(),
  });

  // RFC 9126 §2.1: the pushed request carries exactly the parameters the
  // authorization request would, plus client authentication.
  const pushed = await formPost(new URL('/par', issuer), {
    response_type: 'code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    scope: requestUrl.searchParams.get('scope') ?? 'openid profile email',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    audience: resourceServerUrl,
  });

  // RFC 9126 §4: the front-channel request carries only client_id and request_uri.
  const authorizationUrl = new URL('/authorize', issuer);
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('request_uri', pushed.request_uri);

  redirect(res, authorizationUrl.toString());
}

async function handleCallback(url, res) {
  const state = requireSearchParam(url, 'state');
  const responseIssuer = requireSearchParam(url, 'iss');
  const transaction = transactions.get(state);
  if (transaction === undefined) {
    throw new Error(`Unknown authorization state: ${state}`);
  }
  transactions.delete(state);
  if (responseIssuer !== issuer) {
    throw new Error(`Unexpected issuer: ${responseIssuer}`);
  }

  const authorizationError = url.searchParams.get('error');
  if (authorizationError !== null) {
    sendHtml(res, 200, renderAuthorizationError({
      error: authorizationError,
      errorDescription: url.searchParams.get('error_description') ?? '',
      state,
      issuer: responseIssuer,
    }));
    return;
  }

  const code = requireSearchParam(url, 'code');

  const tokens = await formPost(new URL('/token', issuer), {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: transaction.codeVerifier,
  });
  const userInfo = await fetchJson(new URL('/userinfo', issuer), {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });
  const resourceProfile = await fetchJson(new URL('/profile', resourceServerUrl), {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });

  sendHtml(res, 200, renderResult({
    code,
    state,
    issuer: responseIssuer,
    nonce: transaction.nonce,
    tokens,
    userInfo,
    resourceProfile,
  }));
}

async function formPost(url, fields) {
  return fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url.toString()} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function renderResult(result) {
  return `<!doctype html>
<html>
  <head><title>Authorization Complete</title></head>
  <body>
    <main>
      <h1>Authorization Complete</h1>
      <dl>
        <dt>code</dt><dd data-testid="authorization-code">${escapeHtml(result.code)}</dd>
        <dt>state</dt><dd data-testid="authorization-state">${escapeHtml(result.state)}</dd>
        <dt>iss</dt><dd data-testid="authorization-issuer">${escapeHtml(result.issuer)}</dd>
        <dt>nonce</dt><dd data-testid="authorization-nonce">${escapeHtml(result.nonce)}</dd>
        <dt>access token</dt><dd data-testid="token-access-token">${escapeHtml(result.tokens.access_token)}</dd>
        <dt>id token</dt><dd data-testid="token-id-token">${escapeHtml(result.tokens.id_token)}</dd>
        <dt>refresh token</dt><dd data-testid="token-refresh-token">${escapeHtml(result.tokens.refresh_token ?? '')}</dd>
        <dt>token type</dt><dd data-testid="token-type">${escapeHtml(result.tokens.token_type)}</dd>
        <dt>expires in</dt><dd data-testid="token-expires-in">${escapeHtml(String(result.tokens.expires_in))}</dd>
        <dt>scope</dt><dd data-testid="token-scope">${escapeHtml(result.tokens.scope)}</dd>
        <dt>userinfo sub</dt><dd data-testid="userinfo-sub">${escapeHtml(result.userInfo.sub)}</dd>
        <dt>userinfo email</dt><dd data-testid="userinfo-email">${escapeHtml(result.userInfo.email)}</dd>
        <dt>resource subject</dt><dd data-testid="resource-subject">${escapeHtml(result.resourceProfile.subject)}</dd>
        <dt>resource client</dt><dd data-testid="resource-client-id">${escapeHtml(result.resourceProfile.client_id)}</dd>
        <dt>resource scope</dt><dd data-testid="resource-scope">${escapeHtml(result.resourceProfile.scope)}</dd>
        <dt>resource audience</dt><dd data-testid="resource-audience">${escapeHtml(JSON.stringify(result.resourceProfile.audience))}</dd>
      </dl>
    </main>
  </body>
</html>`;
}

function renderAuthorizationError(result) {
  return `<!doctype html>
<html>
  <head><title>Authorization Error</title></head>
  <body>
    <main>
      <h1>Authorization Error</h1>
      <dl>
        <dt>error</dt><dd data-testid="authorization-error">${escapeHtml(result.error)}</dd>
        <dt>error description</dt><dd data-testid="authorization-error-description">${escapeHtml(result.errorDescription)}</dd>
        <dt>state</dt><dd data-testid="authorization-state">${escapeHtml(result.state)}</dd>
        <dt>iss</dt><dd data-testid="authorization-issuer">${escapeHtml(result.issuer)}</dd>
      </dl>
    </main>
  </body>
</html>`;
}

function renderError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `<!doctype html>
<html>
  <head><title>E2E Client Error</title></head>
  <body><main><h1>E2E Client Error</h1><pre>${escapeHtml(message)}</pre></main></body>
</html>`;
}

function requireSearchParam(url, name) {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new Error(`Missing search parameter: ${name}`);
  }
  return value;
}

function randomString(byteLength) {
  return randomBytes(byteLength).toString('base64url');
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function copyOptionalSearchParam(source, destination, name) {
  const value = source.searchParams.get(name);
  if (value !== null) destination.searchParams.set(name, value);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
