import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
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
const deviceFlows = new Map();

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
    // EXPERIMENTAL (RFC 8693): run the ordinary code flow, then exchange the
    // resulting access token for a narrowed one over the back channel.
    if (req.method === 'GET' && url.pathname === '/start-exchange') {
      await startAuthorization(url, res, { exchange: true });
      return;
    }
    // EXPERIMENTAL (RFC 9126): push the authorization request over the back
    // channel first, then send the browser to /authorize with only client_id and
    // the returned request_uri.
    if (req.method === 'GET' && url.pathname === '/start-par') {
      await startPushedAuthorization(url, res);
      return;
    }
    // EXPERIMENTAL (JARM §2.3.1): ask the OP to return the authorization
    // response as one signed JWT in the `response` query parameter.
    if (req.method === 'GET' && url.pathname === '/start-jarm') {
      await startAuthorization(url, res, { responseMode: 'query.jwt' });
      return;
    }
    // EXPERIMENTAL (RFC 8628): act as the input-constrained device — ask for a
    // device_code / user_code pair and start polling the token endpoint in the
    // background while the browser side of the flow runs.
    if (req.method === 'GET' && url.pathname === '/start-device') {
      await startDeviceAuthorization(url, res);
      return;
    }
    // Report what the background polling has reached so far, so the spec can
    // wait for the outcome instead of reimplementing the poll loop.
    if (req.method === 'GET' && url.pathname === '/device-result') {
      reportDeviceResult(url, res);
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

async function startAuthorization(requestUrl, res, options = {}) {
  const state = randomString(32);
  const nonce = randomString(32);
  const codeVerifier = randomString(64);
  const codeChallenge = pkceChallenge(codeVerifier);
  transactions.set(state, {
    nonce,
    codeVerifier,
    createdAt: Date.now(),
    exchange: options.exchange === true,
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
  // EXPERIMENTAL (JARM §2.3): query.jwt / jwt select the JWT-secured response.
  // The request itself is otherwise identical to the plain code flow.
  const responseMode = requestUrl.searchParams.get('response_mode') ?? options.responseMode;
  if (responseMode) authorizationUrl.searchParams.set('response_mode', responseMode);

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

/**
 * EXPERIMENTAL — OAuth 2.0 Device Authorization Grant (RFC 8628 §3.1 / §3.4).
 *
 * Plays the consumption device: one back-channel POST to get the codes, then a
 * poll loop that honors the interval the OP asked for, including the +5 seconds
 * a slow_down response demands (§3.5).
 */
async function startDeviceAuthorization(requestUrl, res) {
  const authorization = await formPost(new URL('/device_authorization', issuer), {
    client_id: clientId,
    client_secret: clientSecret,
    scope: requestUrl.searchParams.get('scope') ?? 'openid profile email',
  });

  const flowId = randomString(16);
  const flow = {
    status: 'pending',
    userCode: authorization.user_code,
    verificationUri: authorization.verification_uri,
    verificationUriComplete: authorization.verification_uri_complete,
    tokens: null,
    error: null,
  };
  deviceFlows.set(flowId, flow);

  // Deliberately not awaited: the device keeps polling while the spec drives
  // the browser through the verification UI.
  void pollDeviceToken(flow, authorization.device_code, authorization.interval);

  sendJson(res, 200, {
    flow_id: flowId,
    user_code: authorization.user_code,
    verification_uri: authorization.verification_uri,
    verification_uri_complete: authorization.verification_uri_complete,
    expires_in: authorization.expires_in,
    interval: authorization.interval,
  });
}

async function pollDeviceToken(flow, deviceCode, initialInterval) {
  let intervalSeconds = initialInterval ?? 5;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const response = await fetch(new URL('/token', issuer), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const body = await response.json();

    if (response.ok) {
      flow.status = 'complete';
      flow.tokens = body;
      return;
    }
    if (body.error === 'authorization_pending') continue;
    // RFC 8628 §3.5: after slow_down the client MUST add 5 seconds.
    if (body.error === 'slow_down') {
      intervalSeconds += 5;
      continue;
    }
    flow.status = 'failed';
    flow.error = body.error;
    return;
  }

  flow.status = 'failed';
  flow.error = 'timeout';
}

function reportDeviceResult(url, res) {
  const flowId = requireSearchParam(url, 'flow_id');
  const flow = deviceFlows.get(flowId);
  if (flow === undefined) {
    sendJson(res, 404, { error: 'unknown_flow' });
    return;
  }
  sendJson(res, 200, {
    status: flow.status,
    error: flow.error,
    user_code: flow.userCode,
    access_token: flow.tokens?.access_token ?? null,
    id_token: flow.tokens?.id_token ?? null,
    scope: flow.tokens?.scope ?? null,
    token_type: flow.tokens?.token_type ?? null,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleCallback(url, res) {
  // EXPERIMENTAL (JARM §2.3.1): a JARM response carries no plain parameters at
  // all — everything is inside the signed JWT of the `response` parameter.
  if (url.searchParams.has('response')) {
    await handleJarmCallback(url, res);
    return;
  }

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

  if (transaction.exchange) {
    await completeTokenExchange(res, tokens);
    return;
  }

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

/**
 * EXPERIMENTAL — OAuth 2.0 Token Exchange (RFC 8693 §2.1).
 *
 * Trade the access token just obtained for one restricted to a narrower scope.
 * `audience` / `resource` are omitted on purpose: the exchange then inherits the
 * subject token's audience, which already names the resource server, so the
 * exchanged token passes its aud check with the generated default
 * `allowedTargets: []`.
 */
async function completeTokenExchange(res, tokens) {
  const exchanged = await formPost(new URL('/token', issuer), {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: tokens.access_token,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    scope: 'openid profile',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const userInfo = await fetchJson(new URL('/userinfo', issuer), {
    headers: {
      Authorization: `Bearer ${exchanged.access_token}`,
    },
  });
  const resourceProfile = await fetchJson(new URL('/profile', resourceServerUrl), {
    headers: {
      Authorization: `Bearer ${exchanged.access_token}`,
    },
  });

  sendHtml(res, 200, renderExchangeResult({
    subjectScope: tokens.scope,
    exchanged,
    userInfo,
    resourceProfile,
  }));
}

/**
 * EXPERIMENTAL — JWT Secured Authorization Response Mode (JARM), client side.
 *
 * Implements the client processing rules of JARM §2.4 in the order §5.1 requires:
 * the issuer is confirmed BEFORE anything from the JWT is used to fetch keys, so
 * a forged `iss` can never point the client at an attacker-chosen JWKS URL.
 */
async function handleJarmCallback(url, res) {
  const responseJwt = requireSearchParam(url, 'response');

  // JARM §2.3.1: `response` is the only parameter of a JARM authorization
  // response. A plain code / state / iss alongside it means the OP did not
  // actually switch response modes.
  const plainParams = [...url.searchParams.keys()].filter((name) => name !== 'response');
  if (plainParams.length > 0) {
    throw new Error(`JARM response carried plain parameters: ${plainParams.join(', ')}`);
  }

  const [encodedHeader = '', encodedPayload = '', encodedSignature = ''] = responseJwt.split('.');
  const header = decodeJwtSegment(encodedHeader);
  const claims = decodeJwtSegment(encodedPayload);

  // JARM §5.1 (MUST): the issuer must be known and expected before its metadata
  // (here: the JWKS URI) is used.
  if (claims.iss !== issuer) {
    throw new Error(`Unexpected JARM issuer: ${claims.iss}`);
  }

  // JARM §2.4: the client MUST reject alg=none, and this OP only signs RS256.
  if (header.alg !== 'RS256') {
    throw new Error(`Unexpected JARM signing algorithm: ${header.alg}`);
  }

  const jwks = await fetchJson(new URL('/.well-known/jwks.json', issuer));
  const jwk = (jwks.keys ?? []).find((candidate) => candidate.kid === header.kid);
  if (jwk === undefined) {
    throw new Error(`No JWKS key matches kid ${header.kid}`);
  }
  const signatureValid = verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(encodedSignature, 'base64url'),
  );
  if (!signatureValid) {
    throw new Error('JARM response signature verification failed');
  }

  // JARM §2.1: aud identifies this client, exp bounds the response's lifetime.
  if (claims.aud !== clientId) {
    throw new Error(`Unexpected JARM audience: ${claims.aud}`);
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new Error(`JARM response is expired: exp=${claims.exp}`);
  }

  const state = claims.state;
  const transaction = transactions.get(state);
  if (transaction === undefined) {
    throw new Error(`Unknown authorization state: ${state}`);
  }
  transactions.delete(state);

  const jarm = {
    alg: header.alg,
    kid: header.kid,
    iss: claims.iss,
    aud: claims.aud,
    signatureValid,
    claimNames: Object.keys(claims).sort().join(' '),
  };

  if (claims.error !== undefined) {
    sendHtml(res, 200, renderAuthorizationError({
      error: claims.error,
      errorDescription: claims.error_description ?? '',
      state,
      issuer: claims.iss,
      jarm,
    }));
    return;
  }

  const code = claims.code;
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
    issuer: claims.iss,
    nonce: transaction.nonce,
    tokens,
    userInfo,
    resourceProfile,
    jarm,
  }));
}

function decodeJwtSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function renderJarmDetails(jarm) {
  if (jarm === undefined) return '';
  return `
        <dt>jarm alg</dt><dd data-testid="jarm-alg">${escapeHtml(jarm.alg)}</dd>
        <dt>jarm kid</dt><dd data-testid="jarm-kid">${escapeHtml(jarm.kid)}</dd>
        <dt>jarm iss</dt><dd data-testid="jarm-iss">${escapeHtml(jarm.iss)}</dd>
        <dt>jarm aud</dt><dd data-testid="jarm-aud">${escapeHtml(jarm.aud)}</dd>
        <dt>jarm signature</dt><dd data-testid="jarm-signature-valid">${escapeHtml(String(jarm.signatureValid))}</dd>
        <dt>jarm claims</dt><dd data-testid="jarm-claim-names">${escapeHtml(jarm.claimNames)}</dd>`;
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
        <dt>resource audience</dt><dd data-testid="resource-audience">${escapeHtml(JSON.stringify(result.resourceProfile.audience))}</dd>${renderJarmDetails(result.jarm)}
      </dl>
    </main>
  </body>
</html>`;
}

function renderExchangeResult(result) {
  return `<!doctype html>
<html>
  <head><title>Token Exchange Complete</title></head>
  <body>
    <main>
      <h1>Token Exchange Complete</h1>
      <dl>
        <dt>subject scope</dt><dd data-testid="exchange-subject-scope">${escapeHtml(result.subjectScope)}</dd>
        <dt>issued token type</dt><dd data-testid="exchange-issued-token-type">${escapeHtml(result.exchanged.issued_token_type)}</dd>
        <dt>token type</dt><dd data-testid="exchange-token-type">${escapeHtml(result.exchanged.token_type)}</dd>
        <dt>scope</dt><dd data-testid="exchange-scope">${escapeHtml(result.exchanged.scope)}</dd>
        <dt>expires in</dt><dd data-testid="exchange-expires-in">${escapeHtml(String(result.exchanged.expires_in))}</dd>
        <dt>refresh token</dt><dd data-testid="exchange-refresh-token">${escapeHtml(result.exchanged.refresh_token ?? '')}</dd>
        <dt>userinfo sub</dt><dd data-testid="exchange-userinfo-sub">${escapeHtml(result.userInfo.sub)}</dd>
        <dt>userinfo email</dt><dd data-testid="exchange-userinfo-email">${escapeHtml(result.userInfo.email ?? '')}</dd>
        <dt>resource subject</dt><dd data-testid="exchange-resource-subject">${escapeHtml(result.resourceProfile.subject)}</dd>
        <dt>resource client</dt><dd data-testid="exchange-resource-client-id">${escapeHtml(result.resourceProfile.client_id)}</dd>
        <dt>resource scope</dt><dd data-testid="exchange-resource-scope">${escapeHtml(result.resourceProfile.scope)}</dd>
        <dt>resource audience</dt><dd data-testid="exchange-resource-audience">${escapeHtml(JSON.stringify(result.resourceProfile.audience))}</dd>
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
        <dt>iss</dt><dd data-testid="authorization-issuer">${escapeHtml(result.issuer)}</dd>${renderJarmDetails(result.jarm)}
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
