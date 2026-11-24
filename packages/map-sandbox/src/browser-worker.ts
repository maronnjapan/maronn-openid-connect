import { preparePremises, prepareRequestScenario, runRequest, type PreparedPremises, type PreparedRequestScenario, type Premises, type SandboxRequest, type SandboxRun } from '@maronn-openid-connect/map-sandbox';

export type SandboxCommand =
  | { request: SandboxRequest; premises?: PreparedPremises }
  | { prepare: Premises }
  | { scenario: string; framework?: string };
export type SandboxAnswer = { id: number } & ({ result: SandboxRun | PreparedPremises | PreparedRequestScenario } | { error: string });

/** Execute one command and return its result to the viewer. */
async function answer(command: SandboxCommand & { id: number }): Promise<SandboxAnswer> {
  const { id } = command;
  try {
    if ('scenario' in command) return { id, result: await prepareRequestScenario(command.scenario, command.framework) };
    if ('prepare' in command) return { id, result: await preparePremises(command.prepare) };
    return { id, result: await runRequest(command.request, command.premises) };
  } catch (error) {
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
}

self.addEventListener('message', (event: MessageEvent<SandboxCommand & { id: number }>) => {
  void answer(event.data).then((response) => self.postMessage(response));
});
