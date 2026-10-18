/**
 * What the pushed authorization request endpoint answers, and the failure a
 * step answers with a fixed response.
 */

/** What the pushed authorization request endpoint answers; respondPar() turns it into HTTP. */
export interface ParEndpointResponse {
  status: number;
  body: object;
  headers?: Record<string, string>;
}

/** A failure a step answers with a fixed response (a malformed request). */
export class ParEndpointError extends Error {
  constructor(readonly response: ParEndpointResponse) {
    const details = (response.body ?? {}) as { error?: unknown; error_description?: unknown };
    super(String(details.error_description ?? details.error ?? 'pushed authorization request endpoint error'));
    this.name = 'ParEndpointError';
  }
}
