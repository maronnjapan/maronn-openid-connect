/**
 * The test every target extends: what a scenario received from the OP.
 *
 * A step that sends a request records the response here, whatever the target
 * sent it through (a Hono app, a Route Handler of Next.js, or HTTP to a running
 * OP), so the steps of common/ check it the same way on every target.
 *
 * The test of a target extends this one with what only that target can do
 * (in-process.ts, http.ts). A step file passes the test of its target to
 * createBdd(), together with the tags of the scenarios it serves, which is how
 * a step declares the targets it supports.
 */
import { test as base } from 'playwright-bdd';

/** A response as the steps check it: the status, the headers by lower-case name, and the body as text. */
export interface ReceivedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** What a scenario exchanged with the OP: the last response it received, once it sent a request. */
export interface Exchange {
  response?: ReceivedResponse;
}

export const test = base.extend<{ exchange: Exchange }>({
  // A new record for every scenario: nothing a scenario received is seen by the next.
  exchange: async ({}, use) => {
    await use({});
  },
});

/**
 * The last response of the scenario.
 *
 * @throws {Error} when the scenario has not sent a request yet
 */
export function lastResponse(exchange: Exchange): ReceivedResponse {
  if (exchange.response === undefined) {
    throw new Error('The scenario has not sent a request yet: a When step must send one before a Then step checks it');
  }
  return exchange.response;
}

/**
 * The body of the last response as a JSON object.
 *
 * @throws {Error} when the scenario has not sent a request yet, or the body is not a JSON object
 */
export function jsonBody(exchange: Exchange): Record<string, unknown> {
  const { body } = lastResponse(exchange);
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The body of the last response is not a JSON object: ${body}`);
  }
  return parsed as Record<string, unknown>;
}

/** The response of the Fetch API as the steps check it. */
export async function receivedFromFetch(response: Response): Promise<ReceivedResponse> {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}
