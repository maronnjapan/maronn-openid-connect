import type { PreparedPremises, SandboxRequest } from './api.js';
import { prepareWithRequests, type PremiseRequestsContext } from './prepare.js';
import { PREMISES, type Premises } from './premises.js';

export type ScenarioContext = PremiseRequestsContext;

/** The provider configuration and HTTP requests that prepare a case. */
export interface ScenarioRecipe {
  plan?: (now: number) => Premises | Promise<Premises>;
  request: (context: ScenarioContext) => SandboxRequest | Promise<SandboxRequest>;
  /** Simulated time between setting up the case and sending the selected request. */
  elapsedSeconds?: number;
}

/** Prepare the selected request and the database it will see, within the sandbox's run queue. */
export async function prepareScenarioRecipe(recipe: ScenarioRecipe, label = 'scenario'): Promise<{ request: SandboxRequest; premises: PreparedPremises }> {
  const now = Math.floor(Date.now() / 1000);
  const plan = await recipe.plan?.(now) ?? { ...PREMISES, now, grants: [] };
  const { result: request, premises } = await prepareWithRequests(plan, label, recipe.request);
  return { request, premises: { ...premises, now: premises.now + (recipe.elapsedSeconds ?? 0) } };
}
