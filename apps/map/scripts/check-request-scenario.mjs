import { generateRequestScenario } from '@maronn-openid-connect/test-catalog/premises';

// Smoke-test the same signed Request Object that the map and tests generate.
const scenario = 'authorize-request-object';
const issuer = new URL(process.argv[2] ?? 'http://127.0.0.1:3010').href.replace(/\/$/, '');
const redirectUri = new URL('/request-scenario-callback', issuer).href;

async function json(url, status, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  if (response.status !== status) {
    throw new Error(`${url}: expected HTTP ${status}, received ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

const discovery = await json(`${issuer}/.well-known/openid-configuration`, 200);
if (discovery.issuer !== issuer || typeof discovery.registration_endpoint !== 'string') {
  throw new Error('The issuer must match discovery and expose a client registration endpoint.');
}

const signingKey = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);
const options = { issuer, redirectUri, signingKey };
const { registration } = await generateRequestScenario(scenario, options);
const { client_id: _exampleClientId, ...metadata } = registration;
const { client_id: clientId } = await json(discovery.registration_endpoint, 201, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(metadata),
});
if (typeof clientId !== 'string' || clientId.length === 0) {
  throw new Error('Client registration did not return a client_id.');
}

const { request, url } = await generateRequestScenario(scenario, { ...options, clientId });
const response = await fetch(url, {
  method: request.method,
  headers: request.headers,
  redirect: 'manual',
  signal: AbortSignal.timeout(15_000),
});
const location = new URL(response.headers.get('location') ?? '', issuer);
if (response.status !== 302 || location.origin !== new URL(issuer).origin ||
    location.pathname !== '/login' || !location.searchParams.get('transaction_id')) {
  throw new Error(`The Request Object did not reach login (HTTP ${response.status}): ${await response.text()}`);
}
console.log(`${request.method} ${new URL(url).pathname} accepted by ${issuer} (302 to /login with transaction_id)`);
