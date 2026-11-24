import type { PreparedPremises, PreparedRequestScenario, Premises, SandboxRequest, SandboxRun } from './api.js';
import type { SandboxAnswer, SandboxCommand } from './browser-worker.js';

type Result = Extract<SandboxAnswer, { result: unknown }>['result'];
const waiting = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void }>();
let worker: Worker | undefined;
let lastId = 0;

/** Start the provider worker on the first request and share it across the viewer. */
function sandboxWorker(): Worker {
  if (worker !== undefined) return worker;
  const made = new Worker(new URL('./browser-worker.ts', import.meta.url), { type: 'module', name: 'map-sandbox' });
  made.addEventListener('message', (event: MessageEvent<SandboxAnswer>) => {
    const answer = event.data;
    const pending = waiting.get(answer.id);
    waiting.delete(answer.id);
    if ('result' in answer) pending?.resolve(answer.result);
    else pending?.reject(new Error(answer.error));
  });
  made.addEventListener('error', (event) => {
    for (const pending of waiting.values()) pending.reject(new Error(event.message || '地図の OP を読み込めませんでした'));
    waiting.clear();
    made.terminate();
    if (worker === made) worker = undefined;
  });
  worker = made;
  return made;
}

/** Send a command to the provider worker and wait for its result. */
function ask(command: SandboxCommand): Promise<Result> {
  return new Promise((resolve, reject) => {
    const provider = sandboxWorker();
    const id = ++lastId;
    waiting.set(id, { resolve, reject });
    try {
      provider.postMessage({ ...command, id });
    } catch (error) {
      waiting.delete(id);
      reject(error);
    }
  });
}

/** Run a request with the specified provider state. */
export function runInSandbox(request: SandboxRequest, premises?: PreparedPremises): Promise<SandboxRun> {
  return ask({ request, premises }) as Promise<SandboxRun>;
}

/** Prepare the provider state from its configured grants. */
export function prepareInSandbox(prepare: Premises): Promise<PreparedPremises> {
  return ask({ prepare }) as Promise<PreparedPremises>;
}

/** Make the selected case's prerequisites and its final request. */
export function prepareRequestScenarioInSandbox(scenario: string, framework?: string): Promise<PreparedRequestScenario> {
  return ask({ scenario, framework }) as Promise<PreparedRequestScenario>;
}
