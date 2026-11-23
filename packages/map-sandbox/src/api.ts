/**
 * What the OP of the map takes and gives: the types of dist/sandbox.js,
 * which runs one request on the OP (index.ts). Only types and the premises,
 * so the page reads them without loading the OP.
 */
import type { RanInFile } from '@maronn-openid-connect/test-reach/exchanges';
import type { Premises } from './premises.js';

export type { RanInFile };
export type { PremiseClient, PremiseCode, PremiseRefreshToken, PremiseUser, Premises } from './premises.js';

/** A request to run on the OP of the map, as the page writes it. */
export interface SandboxRequest {
  method: string;
  /** The path and the query (`/token`, `/authorize?client_id=client-1&…`); the OP's issuer is the origin. */
  path: string;
  /** The headers, in the order written. */
  headers: Array<[string, string]>;
  /** The body as text; absent for none. */
  body?: string;
}

/** A message as the OP of the map saw it: lower-case header names, the body as text cut at 16 KiB. */
export interface SandboxMessage {
  headers: Array<[string, string]>;
  /** Absent when there is none or it is empty. */
  body?: string;
  /** The body was cut at 16 KiB. */
  truncated?: true;
}

/** What one request run on the OP of the map gave. */
export interface SandboxRun {
  /** The request as sent: its method and absolute URL, its headers and body. */
  request: SandboxMessage & { method: string; url: string };
  /** What the OP answered; absent when it threw instead (`error`). */
  response?: SandboxMessage & { status: number; statusText?: string };
  /** What the OP threw instead of answering. */
  error?: string;
  /** What ran while the OP answered: the Istanbul counters that went up, by repository path of the original source. */
  ran: Record<string, RanInFile>;
}

/**
 * Run a request on the OP of the map: a new OP on a memory database seeded
 * with the premises, its clock stopped at theirs, with what ran counted.
 * Requests asked for together run one after another. It rejects when the
 * request cannot be made (a body on a GET, a header name that is not one).
 */
export declare function runRequest(request: SandboxRequest): Promise<SandboxRun>;

/** What the OP of the map holds when a request starts. */
export declare const PREMISES: Premises;

/** The endpoints the map tries requests at, by id (candidates.ts). */
export declare const SAMPLED_ENDPOINTS: readonly string[];

/** The requests to try at an endpoint to find a request for each of its ways, in the order to try them (candidates.ts). */
export declare function candidateRequests(endpoint: string): SandboxRequest[];
