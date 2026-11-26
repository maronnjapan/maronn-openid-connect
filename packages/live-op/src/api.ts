/**
 * What the live OP takes and gives, as plain data: the requests a reader
 * writes, the exchanges the OP recorded (each request with its response,
 * the order of what it ran, and the records it read and wrote), the state a
 * workspace holds, and the paths of the control API the pages call
 * (`/__live/*`). Only types and constants, so the pages import it without
 * the OP (`@maronn-openid-connect/live-op/api`).
 *
 * The live OP is the server app of apps/hono (createServerApp, every
 * feature), deployed beside the map: on Cloudflare Workers, one Durable
 * Object per workspace (apps/map/worker); in Node, one process holding the
 * workspaces (src/node.ts). Every request to it, whether a page relays it
 * (`POST /__live/run`), a case's preparation sends it, or a browser or a
 * client sends it over HTTP to the OP's own paths, runs on the workspace's
 * state as it is: a code exchanged stays used, a session stays signed in,
 * the clock is the real one (moved on only by `POST /__live/clock`).
 */

/** A request as a page writes it: the method, the path with its query, the headers in order, the body as text. */
export interface LiveRequest {
  method: string;
  /** The path and the query (`/token`, `/authorize?client_id=…`); the OP's issuer is the origin. */
  path: string;
  headers: Array<[string, string]>;
  /** Absent for none. */
  body?: string;
}

/** A message as the OP saw it: lower-case header names (every Set-Cookie kept), the body as text cut at 16 KiB. */
export interface LiveMessage {
  headers: Array<[string, string]>;
  /** Absent when there is none or it is empty. */
  body?: string;
  /** The body was cut at 16 KiB. */
  truncated?: true;
}

/**
 * How a request reached the OP: a page relayed what a reader wrote
 * (`relay`), a case sent it to prepare the request it is about
 * (`scenario`), a grant made by a page sent it (`grant`), or a browser or a
 * client sent it over HTTP to the OP's paths (`http`); or a page asked what
 * a request would do without sending it (`preview`: run on a copy of the
 * workspace's state, and neither the copy nor the exchange is kept).
 */
export type ExchangeSource = 'relay' | 'scenario' | 'grant' | 'http' | 'preview';

/**
 * The order of what a request ran: the probes (src/recorder.ts) whose
 * counter went up while the OP answered it, one entry a time a counter went
 * up, in the order they did. A probe is a statement, a side of a branch, or
 * the entry of a function, at its place in the original source; the table
 * of the probes (ProbeTable) is the same for every request of one build of
 * the OP, named by its hash.
 */
export interface TraceEvents {
  /** ProbeTable.hash of the table the events index. */
  probes: string;
  events: number[];
  /** The request ran more probes than the OP keeps for one (MAX_EVENTS): the events stop there. */
  truncated?: true;
}

/**
 * The probes of one build of the OP: every statement, branch side and
 * function Istanbul counts in the files of the map's roots, at their start
 * in the original source (lines from 1, columns from 0), each
 * `[file, kind, line, column, a?, b?, c?]` with `kind` 0 a statement (`a`
 * 1 for a `throw`, 2 for a `return`, 0 for any other), 1 a
 * side of a branch (`a` the index of its type in `types`, `b` the side, `c`
 * how many sides it has; line and column are those of the branch, the same
 * for each side, as Istanbul counts it), 2 a function (`a` the index of its
 * name in `names`, -1 for none). A probe whose place does not map to the
 * original source has line 0.
 */
export interface ProbeTable {
  hash: string;
  /** Repository paths (`packages/core/src/token.ts`). */
  files: string[];
  types: string[];
  names: string[];
  probes: Array<[number, number, number, number, number?, number?, number?]>;
}

/** A record of the OP's database a request read; for a walk over a whole collection, no key. */
export interface StoreRead {
  /** The collection (`codes`, `refreshTokens`, `clients`, …, or a feature's store: `par`, `deviceCodes`, `cibaRequests`, `registeredClients`). */
  collection: string;
  key?: string;
  /** The member of a record that is a Map itself (the client_id of a user's consents). */
  member?: string;
  /** Whether the OP held it when the request read it. */
  found: boolean;
}

/** A record a request added, changed or removed. */
export interface StoreChange {
  collection: string;
  key: string;
  change: 'added' | 'changed' | 'removed';
  /** The record after the request, as plain JSON; absent for one removed. */
  value?: unknown;
  /** The record before, for one changed or removed. */
  before?: unknown;
  /** The top-level fields whose values changed, for a record changed. */
  fields?: string[];
}

/** What a request read and wrote of the OP's records. */
export interface StoreAccess {
  read: StoreRead[];
  wrote: StoreChange[];
}

/** One request the OP answered, as a list of a workspace shows it. */
export interface ExchangeSummary {
  /** Unique in its workspace, in the order the OP answered (`x1`, `x2`, …). */
  id: string;
  source: ExchangeSource;
  /** The OP's clock when it started, in Unix milliseconds. */
  at: number;
  method: string;
  /** The path and the query. */
  path: string;
  status?: number;
  /** The OAuth error of the response, if any (`invalid_grant`). */
  error?: string;
  /** The case whose preparation sent it. */
  scenario?: string;
}

/** One request the OP answered, whole: what it was sent, what it answered (or threw), what it ran, and what it read and wrote. */
export interface LiveExchange extends ExchangeSummary {
  request: LiveMessage & { method: string; url: string };
  response?: LiveMessage & { status: number; statusText?: string };
  /** What the app threw instead of answering. */
  thrown?: string;
  trace: TraceEvents;
  store: StoreAccess;
}

/** A record the workspace holds, with the exchanges that added and changed it; none for one of the OP's configuration (a client, a user). */
export interface LiveRecord {
  collection: string;
  key: string;
  value: unknown;
  addedBy?: string;
  changedBy?: string[];
}

/** A client the OP is configured with (OIDC_CLIENTS_JSON of apps/hono), as the pages show it: its secret is shown, the live OP being a playground. */
export interface LiveClient {
  clientId: string;
  clientSecret?: string;
  authMethod: string;
  grantTypes: string[];
  responseTypes?: string[];
  redirectUris: string[];
  scope?: string[];
  /** What the map uses it for. */
  note: string;
}

/** A user who signs in at the login page. */
export interface LiveUser {
  username: string;
  password: string;
}

/** What a workspace is: its OP's issuer, its clock, what it is configured with and what it holds. */
export interface LiveState {
  workspace: string;
  issuer: string;
  /** The OP's clock now, in Unix milliseconds. */
  now: number;
  /** How far `POST /__live/clock` moved the OP's clock past the real one, in seconds. */
  clockOffset: number;
  /** The hash of the probe table of the OP's build. */
  probes: string;
  clients: LiveClient[];
  users: LiveUser[];
  records: LiveRecord[];
  /** How many exchanges the workspace has recorded since it was made. */
  exchanges: number;
  /**
   * Why the workspace was started over without a reader asking for it (what
   * its host kept could not be read, the OP's code or configuration changed,
   * or what it held grew past what a workspace keeps), in Japanese for the
   * reader; absent once it is reset.
   */
  notice?: string;
}

/**
 * An authorization a page asks the OP for, run as a browser and a client
 * would: the client's authorization request, the user's login and consent
 * on the OP's pages, and, with `exchange`, the code sent to the token
 * endpoint.
 */
export interface GrantPlan {
  /** The query of the authorization request (OAuth 2.0 §4.1.1, OIDC Core 1.0 §3.1.2.1). */
  authorize: Record<string, string>;
  /** The PKCE verifier of its code_challenge, when it has one (RFC 7636 §4.1). */
  codeVerifier?: string;
  username: string;
  exchange: boolean;
}

/** What a grant left: the code, the tokens of its exchange, and the exchanges it sent; or why the OP gave no code. */
export interface GrantResult {
  clientId: string;
  redirectUri: string;
  code?: string;
  codeVerifier?: string;
  tokens?: Record<string, unknown>;
  failure?: string;
  steps: ExchangeSummary[];
}

/** The request a case is about, made on the workspace by the requests that prepare it. */
export interface PreparedScenario {
  id: string;
  /** The request to send: run it with `POST /__live/run` (the values in it are the workspace's own). */
  request: LiveRequest;
  /** The exchanges that prepared it, in order. */
  steps: ExchangeSummary[];
  /** What a step did that is not a request (`OP の時計を 601 秒進めた`). */
  notes?: string[];
}

/** The paths of the control API (all under LIVE_PREFIX). */
export const LIVE_PREFIX = '/__live/';

/** The cookie a page sets to send a browser's requests to its workspace. */
export const WORKSPACE_COOKIE = 'map_workspace';

/** The header a page names its workspace with. */
export const WORKSPACE_HEADER = 'x-map-workspace';

/** The header the OP's responses name the exchange of their request with, so a client can open it on the map. */
export const EXCHANGE_HEADER = 'x-map-exchange';

/** The workspace of a request that names none (a client over HTTP without the cookie). */
export const PUBLIC_WORKSPACE = 'public';

/** Whether a workspace id is one the OP takes: 1 to 64 letters, digits, `-` and `_`. */
export function isWorkspaceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/** The most probes one exchange keeps (TraceEvents.truncated past it). */
export const MAX_EVENTS = 400_000;

/** The most exchanges a workspace keeps; older ones are dropped, their summaries too. */
export const MAX_EXCHANGES = 200;

/**
 * The most bytes of a body the live OP takes (64 KiB), a request it relays
 * (`POST /__live/run`) included: a limit of the playground, which keeps
 * what a workspace holds small, not one of the OP. A larger one is
 * answered 413 before the OP runs.
 */
export const REQUEST_BODY_LIMIT = 64 * 1024;

/** The most characters of a URL the live OP takes (16 KiB), a limit of the playground as REQUEST_BODY_LIMIT is. */
export const REQUEST_URL_LIMIT = 16 * 1024;
