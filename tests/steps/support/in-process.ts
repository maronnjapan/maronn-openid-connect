/**
 * The test of the in-process targets (in-process-hono, in-process-nextjs):
 * an OP of one app in the worker process, on stores of its own for every
 * scenario, with no browser and no server.
 *
 * The project picks the app with the `target` option. The driver module of the
 * app is imported only when a scenario of the project runs, so generating the
 * tests (bddgen) and the http target never load the code of the apps. The
 * specifier is not a literal on purpose: the two apps typecheck with different
 * JSX settings, so each driver has a tsconfig of its own and this file must
 * not pull them into one program.
 *
 * The steps of in-process/ are defined with this test and IN_PROCESS_TARGETS:
 * a scenario tagged @http that uses one of them has no definition for it on
 * any target, and bddgen fails.
 */
import type { ConfidentialClient, InProcessDriver, InProcessDriverModule } from './drivers/driver.js';
import { receivedFromFetch, test as base, type Exchange } from './target.js';

export type InProcessTargetName = 'hono' | 'nextjs';

/** The option each in-process project sets (playwright.config.ts). */
export interface InProcessOptions {
  target: InProcessTargetName | undefined;
}

/** The tags of the scenarios the in-process steps serve: any scenario that is not also run over HTTP. */
export const IN_PROCESS_TARGETS = 'not @http';

/** A client the scenario registered, and the secret it presents (another one once it presents invalid credentials). */
export interface ScenarioClient extends ConfidentialClient {
  presentedSecret: string;
}

/** An authorization code the scenario stored, its code_verifier, and the tokens redeeming it returned. */
export interface ScenarioCode {
  clientId: string;
  codeVerifier?: string;
  accessToken?: string;
  refreshToken?: string;
}

/** The OP of the scenario and what the scenario set up on it. */
export interface InProcessOp {
  driver: InProcessDriver;
  clients: Map<string, ScenarioClient>;
  codes: Map<string, ScenarioCode>;
}

const DRIVER_MODULES: Record<InProcessTargetName, string> = {
  hono: './drivers/hono.ts',
  nextjs: './drivers/nextjs.ts',
};

export const test = base.extend<{ op: InProcessOp }, InProcessOptions>({
  target: [undefined, { option: true, scope: 'worker' }],
  // A new OP on new stores for every scenario, dropped after it (nothing to write in the feature).
  op: async ({ target }, use) => {
    const driver = await openDriver(target);
    await use({ driver, clients: new Map(), codes: new Map() });
    await driver.close();
  },
});

/**
 * Opens the driver of the app the project names.
 *
 * @throws {Error} when the project sets no in-process target
 */
async function openDriver(target: InProcessTargetName | undefined): Promise<InProcessDriver> {
  if (target === undefined) {
    throw new Error('The project runs no in-process target: set use.target to hono or nextjs (tests/steps/playwright.config.ts)');
  }
  const module = (await import(new URL(DRIVER_MODULES[target], import.meta.url).href)) as InProcessDriverModule;
  return module.openDriver();
}

/**
 * The client the scenario registered.
 *
 * @throws {Error} when the scenario registered no client of that client_id
 */
export function scenarioClient(op: InProcessOp, clientId: string): ScenarioClient {
  const client = op.clients.get(clientId);
  if (client === undefined) throw new Error(`The scenario registered no client "${clientId}": add a Given that registers it`);
  return client;
}

/**
 * Sends a token request of the client with the form fields and records the
 * response.
 *
 * The client authenticates with the method it registered and the secret it
 * presents: client_secret_basic in the Authorization header (RFC 6749 §2.3.1),
 * client_secret_post in the body.
 */
export async function requestToken(
  op: InProcessOp,
  exchange: Exchange,
  clientId: string,
  fields: Record<string, string>,
): Promise<void> {
  const client = scenarioClient(op, clientId);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(fields);
  if (client.authMethod === 'client_secret_basic') {
    headers.Authorization = basicAuthorization(client.clientId, client.presentedSecret);
  } else {
    body.set('client_id', client.clientId);
    body.set('client_secret', client.presentedSecret);
  }
  const response = await op.driver.request(
    new Request(new URL('/token', op.driver.issuer), { method: 'POST', headers, body: body.toString() }),
  );
  exchange.response = await receivedFromFetch(response);
}

/** The form fields of a complete authorization_code token request for a code the scenario knows (RFC 6749 §4.1.3, RFC 7636 §4.5). */
export function authorizationCodeFields(op: InProcessOp, clientId: string, code: string): Record<string, string> {
  const client = scenarioClient(op, clientId);
  const codeVerifier = op.codes.get(code)?.codeVerifier;
  return {
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirectUri,
    ...(codeVerifier === undefined ? {} : { code_verifier: codeVerifier }),
  };
}

/** The Authorization header of client_secret_basic (RFC 6749 §2.3.1). */
function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
}

/** The S256 code_challenge of a code_verifier (RFC 7636 §4.2). */
export async function s256Challenge(codeVerifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier)));
  return Buffer.from(digest).toString('base64url');
}
