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

/** The records of the OP's memory database as plain JSON (a Map as an object, a Set as an array), by collection (`codes`, `clients`, …), then by key. */
export type PlainDatabase = Record<string, Record<string, unknown>>;

/** A record a request read from the OP's memory database, a member of a record that is a Map itself, or, without a key, a collection it went through whole. */
export interface StoreRead {
  /** The collection of the database (`codes`, `refreshTokens`, `clients`, …). */
  collection: string;
  /** The key it looked up (the code, the token, the client_id, …); absent for a walk over the whole collection. */
  key?: string;
  /** The member of the record it looked up, for a record that is a Map itself (the client_id of a user's consents: `consentScopes`, `consentGrants`). */
  member?: string;
  /** Whether the database held the record (the member; for a walk, any record) when the request read it. */
  found: boolean;
}

/** A record a request added to the OP's memory database, changed, or removed. */
export interface StoreChange {
  collection: string;
  key: string;
  change: 'added' | 'changed' | 'removed';
  /** The record after the request, as plain JSON; absent for one removed. */
  value?: unknown;
  /** The record before the request, for one changed or removed. */
  before?: unknown;
  /** The top-level fields whose values changed, for a record changed. */
  fields?: string[];
}

/** What a request read and wrote of the OP's memory database (store.ts). */
export interface StoreAccess {
  /** The records it read, the first read of each, in the order read; not those it wrote before reading them. */
  read: StoreRead[];
  /** The records it added, changed or removed. */
  wrote: StoreChange[];
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
  /** What it read and wrote of the records the OP held. */
  store: StoreAccess;
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
