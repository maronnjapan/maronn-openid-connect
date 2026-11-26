/**
 * How a case of the map prepares the request it is about on a workspace:
 * the grants it needs, run as a browser and a client would (grant.ts), the
 * other requests that lead up to it (a login form opened, a token revoked,
 * a device code approved), sent one after another to the same OP, and,
 * where the case is about time passing, the OP's clock moved on. Every
 * request is an exchange of the workspace, so the map shows the reader what
 * prepared the request, and the request it gives is the workspace's own:
 * the code in it was issued by this OP, the cookie names this OP's session.
 *
 * The values a recipe reads are only those the OP gave (a code from the
 * redirect, a token from a response, a CSRF token from a page), never ones
 * made up for the OP to take.
 */
import type { GrantPlan, GrantResult, LiveRequest, PreparedScenario } from './api.js';
import { runGrant, sendStep, type StepResponse } from './grant.js';
import type { LiveWorkspace } from './workspace.js';

/** What a recipe prepares its request with. */
export interface ScenarioContext {
  issuer: string;
  /** The OP's clock now, in Unix seconds. */
  now(): number;
  /** What the grants of the recipe left, in order. */
  grants: ReadonlyArray<GrantResult>;
  /** Send a request leading up to the case's, as a step of the case. */
  send(request: LiveRequest): Promise<StepResponse>;
  /** Run one more grant, as a step of the case. */
  grant(plan: GrantPlan): Promise<GrantResult>;
  /** Move the OP's clock on, as a step of the case. */
  advanceClock(seconds: number): Promise<void>;
}

/** How a case makes its request (see the module comment). */
export interface ScenarioRecipe {
  /** The grants to run first. */
  grants?: (issuer: string) => GrantPlan[] | Promise<GrantPlan[]>;
  /** Make the request, sending what leads up to it. */
  request: (context: ScenarioContext) => LiveRequest | Promise<LiveRequest>;
}

/** Prepare a case's request on a workspace by its recipe (see the module comment). */
export async function prepareRecipe(workspace: LiveWorkspace, id: string, recipe: ScenarioRecipe): Promise<PreparedScenario> {
  const steps: PreparedScenario['steps'] = [];
  const notes: string[] = [];
  const grants: GrantResult[] = [];
  const grant = async (plan: GrantPlan): Promise<GrantResult> => {
    const { browser: _browser, ...result } = await runGrant(workspace, plan, 'scenario', id);
    steps.push(...result.steps);
    if (result.failure !== undefined) throw new Error(`The case ${id} could not get its grant: ${result.failure}`);
    return result;
  };
  for (const plan of (await recipe.grants?.(workspace.issuer)) ?? []) grants.push(await grant(plan));
  const context: ScenarioContext = {
    issuer: workspace.issuer,
    now: () => Math.floor(workspace.now() / 1000),
    grants,
    async send(request) {
      const response = await sendStep(workspace, request, 'scenario', id);
      steps.push(response.exchange);
      return response;
    },
    grant,
    async advanceClock(seconds) {
      await workspace.advanceClock(seconds);
      notes.push(`OP の時計を ${seconds} 秒進めた`);
    },
  };
  const request = await recipe.request(context);
  return { id, request, steps, ...(notes.length === 0 ? {} : { notes }) };
}
