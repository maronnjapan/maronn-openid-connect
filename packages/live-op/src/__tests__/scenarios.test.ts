import { describe, expect, it } from 'vitest';
import { REQUEST_SCENARIOS, type RequestScenario } from '../../../test-catalog/src/premises.js';
import type * as LiveOp from '../index.js';

// The built bundle (the package script builds it first), the OP a host runs; a URL, so the type checker leaves it to the types of the sources.
const { LiveWorkspace, prepareRecipe, RECIPES } = await import(new URL('../../dist/live-op.js', import.meta.url).href) as typeof LiveOp;

/** An issuer the OP's redirect URIs are valid under (an https origin). */
const ISSUER = 'https://op.example.com';

/** The paths of the endpoints whose id is not their path. */
const PATHS: Readonly<Record<string, string>> = {
  discovery: '/.well-known/openid-configuration',
  jwks: '/.well-known/jwks.json',
  introspection: '/introspect',
  revocation: '/revoke',
  'device-authorization': '/device_authorization',
  'backchannel-authentication': '/backchannel_authentication',
  'login-google': '/login/google',
};

/** The cases the live OP answers: those of apps/hono that need nothing outside it. */
const LIVE_CASES = REQUEST_SCENARIOS.filter((scenario) => scenario.external === undefined && scenario.frameworks?.includes('hono') !== false);

/** What the comparison of a case reads: the status, and the OAuth error and the path redirected to when the case names them (with no error when it names only the path). */
interface Outcome {
  status: number | undefined;
  error?: string | undefined;
  redirectPath?: string | undefined;
}

/** Whether a case names the OAuth error of its response: when it names an error or the path it redirects to (which it then expects without an error). */
function namesError(scenario: RequestScenario): boolean {
  return scenario.expected.error !== undefined || scenario.expected.redirectPath !== undefined;
}

/** What a case expects, in the shape of an Outcome. */
function expectedOutcome(scenario: RequestScenario): Outcome {
  const { status, error, redirectPath } = scenario.expected;
  return { status, ...(namesError(scenario) ? { error } : {}), ...(redirectPath === undefined ? {} : { redirectPath }) };
}

/** What a run of a case gave, prepared on a workspace and sent as a page relays a request, and where its preparation and its request went. */
interface CaseRun {
  outcome: Outcome;
  endpointPath: string;
  method: string;
  /** Whether every step of the preparation was recorded as one of the case. */
  stepsOfCase: boolean;
}

/** Prepare a case on a workspace by its recipe and send its request (source `relay`): what the OP answered, as the case compares it. */
async function runCase(workspace: LiveOp.LiveWorkspace, scenario: RequestScenario): Promise<CaseRun> {
  const recipe = RECIPES[scenario.id];
  if (recipe === undefined) throw new Error(`No recipe for ${scenario.id}`);
  const prepared = await prepareRecipe(workspace, scenario.id, recipe);
  const { exchange } = await workspace.send(prepared.request, 'relay');
  const location = exchange.response?.headers.find(([name]) => name === 'location')?.[1];
  return {
    outcome: {
      status: exchange.status,
      ...(namesError(scenario) ? { error: exchange.error } : {}),
      ...(scenario.expected.redirectPath === undefined ? {} : { redirectPath: location === undefined ? undefined : new URL(location, ISSUER).pathname }),
    },
    endpointPath: new URL(prepared.request.path, ISSUER).pathname,
    method: prepared.request.method,
    stepsOfCase: prepared.steps.every((step) => step.source === 'scenario' && step.scenario === scenario.id),
  };
}

/** Whether a path is the endpoint of a case, or a path beneath it. */
function isEndpointOf(path: string, scenario: RequestScenario): boolean {
  const endpoint = PATHS[scenario.endpoint] ?? `/${scenario.endpoint}`;
  return path === endpoint || path.startsWith(`${endpoint}/`);
}

describe('request cases on the live OP', () => {
  it('should have one recipe for each case and a case for each recipe', () => {
    expect(Object.keys(RECIPES).sort()).toEqual(REQUEST_SCENARIOS.map((scenario) => scenario.id).sort());
  });

  it('should prepare the external Google case at its endpoint without sending it', async () => {
    const workspace = await LiveWorkspace.open('case-external', ISSUER);
    const external = REQUEST_SCENARIOS.filter((scenario) => scenario.external !== undefined);
    expect(external.length).toBeGreaterThan(0);
    for (const scenario of external) {
      const recipe = RECIPES[scenario.id];
      expect(recipe).toBeDefined();
      if (recipe === undefined) continue;
      const prepared = await prepareRecipe(workspace, scenario.id, recipe);
      expect(isEndpointOf(new URL(prepared.request.path, ISSUER).pathname, scenario)).toBe(true);
    }
  });

  it.each(LIVE_CASES.map((scenario, index) => ({ ...scenario, index })))('should answer $id as the case expects, twice on one workspace', async (scenario) => {
    const workspace = await LiveWorkspace.open(`case-${scenario.index}`, ISSUER);
    const first = await runCase(workspace, scenario);
    // The OP keeps what the first run left (the code it used, the consent given, the clock moved on): the recipe gives the same case again.
    const second = await runCase(workspace, scenario);
    expect(isEndpointOf(first.endpointPath, scenario)).toBe(true);
    expect(first.method).toMatch(/^(GET|POST)$/);
    expect(first.stepsOfCase).toBe(true);
    expect(first.outcome).toEqual(expectedOutcome(scenario));
    expect(second.outcome).toEqual(expectedOutcome(scenario));
  });
});
