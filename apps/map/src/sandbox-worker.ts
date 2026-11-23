/**
 * The worker the OP of the map runs in (packages/map-sandbox): it takes a
 * request of the page with an id and the premises to run it on (those the
 * build made by requests, MapData.premises, or those the reader made again
 * here), runs it, and answers with the same id and what the run gave, or
 * why it could not be run; or it makes premises from grants the reader
 * changed, and answers with them. The OP and its counters
 * stay in this worker, out of the page, and the page loads them only when
 * the reader runs a first request (useSandbox.ts).
 */
import { preparePremises, runRequest, type PreparedPremises, type Premises, type SandboxRequest, type SandboxRun } from '@maronn-openid-connect/map-sandbox';

/** What the page asks: to run a request on premises (without them, a build that made none, the OP as it is configured, with no code or token), or to make premises from grants the reader changed. */
export type SandboxAsk = { id: number; request: SandboxRequest; premises?: PreparedPremises } | { id: number; prepare: Premises };

/** The answer of the worker: what the run gave, the premises made, or why it could not do what was asked. */
export type SandboxAnswer = { id: number; run: SandboxRun } | { id: number; premises: PreparedPremises } | { id: number; error: string };

/** Do what the page asks and answer it. */
async function answer(ask: SandboxAsk): Promise<SandboxAnswer> {
  try {
    if ('prepare' in ask) return { id: ask.id, premises: await preparePremises(ask.prepare) };
    return { id: ask.id, run: await runRequest(ask.request, ask.premises) };
  } catch (error) {
    return { id: ask.id, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The requests waiting for the one before to finish: one runs at a time, as the OP stops the clock of this worker while it runs. */
let queue: Promise<void> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<SandboxAsk>) => {
  queue = queue.then(async () => self.postMessage(await answer(event.data)));
});
