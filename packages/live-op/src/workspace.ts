/**
 * A workspace of the live OP: the server app of apps/hono (createServerApp,
 * the app a deployment of apps/hono runs) with the state of one reader, kept
 * from one request to the next: its database, the stores of its features,
 * its signing key and its clock. Every request it answers is recorded as an
 * exchange: the request and the response as they were, the order of what
 * the OP ran (recorder.ts), and what it read and wrote of the records.
 *
 * The app finds its database where apps/hono keeps it, on the global scope
 * (db/memory/database.ts), and the features their stores in their modules;
 * several workspaces may share one isolate (Durable Objects of one class do)
 * or one process (src/node.ts), and the counters the recorder reads are the
 * isolate's. So one request of one workspace runs at a time in an isolate
 * (`exclusive`), with the global scope set to the workspace's database, its
 * features' stores and its clock while it runs.
 *
 * A host keeps what a workspace holds through a WorkspaceStorage: a Durable
 * Object's storage on Workers (apps/map/worker), memory in Node.
 */
import { createServerApp } from '../../../apps/hono/src/app.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import {
  MAX_EXCHANGES,
  type ExchangeSource,
  type ExchangeSummary,
  type LiveExchange,
  type LiveMessage,
  type LiveRecord,
  type LiveRequest,
  type LiveState,
  type StoreAccess,
  type StoreChange,
  type TraceEvents,
} from './api.js';
import { withClockOffset } from './clock.js';
import { decodeValue, encodeValue, type EncodedValue } from './codec.js';
import { FeatureStores, type FeatureWrite } from './feature-stores.js';
import { probeTable, startRecording, stopRecording } from './recorder.js';
import { liveClients, liveEnvironment, LIVE_USERS } from './seed.js';
import { changesBetween, plainDatabase, plainOf, watchDatabase } from './store.js';

/** The global apps/hono keeps its memory database on (db/memory/database.ts). */
const DATABASE_KEY = '__oidcMemoryDatabase';

/** The bodies an exchange keeps are cut at this many characters (16 KiB). */
const BODY_LIMIT = 16 * 1024;

/** The run before the next in this isolate (see the module comment). */
let queue: Promise<unknown> = Promise.resolve();

/** Run after every run asked for before in this isolate, alone. */
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}

/** Run with the global database of apps/hono set to a database, and give the earlier one back after. */
async function onDatabase<T>(db: MemoryDatabase, run: () => Promise<T>): Promise<T> {
  const global = globalThis as Record<string, unknown>;
  const before = global[DATABASE_KEY];
  global[DATABASE_KEY] = db;
  try {
    return await run();
  } finally {
    global[DATABASE_KEY] = before;
  }
}

/** Where a record of a workspace came from: the exchange that added it last and those that changed it after. */
interface Provenance {
  addedBy?: string;
  changedBy?: string[];
}

/** What a workspace holds, as its host keeps it between two of its runs. */
export interface WorkspaceSnapshot {
  version: 1;
  id: string;
  issuer: string;
  /** When it was made, in Unix milliseconds of the real clock. */
  createdAt: number;
  /** How far its clock is moved past the real one, in seconds. */
  clockOffset: number;
  /** The private JWK of the key its OP signs with (OIDC_SIGNING_KEY_JWK). */
  signingKey: JsonWebKey & { kid: string };
  database: EncodedValue;
  featureWrites: FeatureWrite[];
  /** The exchanges kept, oldest first. */
  exchanges: ExchangeSummary[];
  /** The number of the last exchange (`x<n>`). */
  counter: number;
  /** Where each record came from, by `<collection> <key>`. */
  provenance: Record<string, Provenance>;
}

/** How a host keeps what a workspace holds (see the module comment). */
export interface WorkspaceStorage {
  load(): Promise<WorkspaceSnapshot | undefined>;
  save(snapshot: WorkspaceSnapshot): Promise<void>;
  putExchange(exchange: LiveExchange): Promise<void>;
  getExchange(id: string): Promise<LiveExchange | undefined>;
  deleteExchanges(ids: readonly string[]): Promise<void>;
}

/** A WorkspaceStorage in memory: the workspace lasts as long as the process. */
export class MemoryStorage implements WorkspaceStorage {
  private snapshot: WorkspaceSnapshot | undefined;
  private readonly exchanges = new Map<string, LiveExchange>();

  async load(): Promise<WorkspaceSnapshot | undefined> {
    return this.snapshot === undefined ? undefined : structuredClone(this.snapshot);
  }

  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }

  async putExchange(exchange: LiveExchange): Promise<void> {
    this.exchanges.set(exchange.id, exchange);
  }

  async getExchange(id: string): Promise<LiveExchange | undefined> {
    return this.exchanges.get(id);
  }

  async deleteExchanges(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.exchanges.delete(id);
  }
}

/** A key of the provenance of a record. */
function recordKey(collection: string, key: string): string {
  return `${collection} ${key}`;
}

/** A body as an exchange keeps it: absent when empty, cut at BODY_LIMIT characters. */
function keptBody(text: string): Pick<LiveMessage, 'body' | 'truncated'> {
  if (text === '') return {};
  return text.length > BODY_LIMIT ? { body: text.slice(0, BODY_LIMIT), truncated: true } : { body: text };
}

/** The headers of a message as an exchange keeps them: lower-case names, in order, every Set-Cookie on a line of its own. */
function keptHeaders(headers: Headers): Array<[string, string]> {
  const kept: Array<[string, string]> = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'set-cookie') kept.push([name.toLowerCase(), value]);
  }
  for (const cookie of headers.getSetCookie()) kept.push(['set-cookie', cookie]);
  return kept;
}

/** The OAuth error a response names: the `error` of its JSON body, of the URL it redirects to (query or fragment), or of its WWW-Authenticate. */
export function oauthErrorOf(status: number, headers: Headers, body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed?.error === 'string') return parsed.error;
  } catch {
    // Not JSON.
  }
  const location = headers.get('location');
  if (location !== null) {
    try {
      const url = new URL(location, 'https://op.invalid');
      const error = url.searchParams.get('error') ?? new URLSearchParams(url.hash.slice(1)).get('error');
      if (error !== null) return error;
    } catch {
      // Not a URL.
    }
  }
  const challenge = /\berror="([^"]+)"/.exec(headers.get('www-authenticate') ?? '');
  if (challenge?.[1] !== undefined) return challenge[1];
  return status >= 400 && /^[a-z_]+$/.test(body.trim()) ? body.trim() : undefined;
}

/** A new RS256 key for a workspace's OP, as a private JWK with its kid. */
async function newSigningKey(id: string): Promise<JsonWebKey & { kid: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { ...jwk, kid: `live-op-${id}-${Date.now().toString(36)}` };
}

/**
 * A request as the OP is sent it, with every header given: a Request made in
 * a page would drop Cookie and Origin, but this runs on a server, where a
 * Request keeps them.
 */
export function requestOf(issuer: string, request: LiveRequest): Request {
  const url = new URL(request.path, issuer);
  if (url.origin !== new URL(issuer).origin) throw new Error(`The path ${request.path} is not one of the OP.`);
  return new Request(url, {
    method: request.method.toUpperCase(),
    headers: request.headers.map(([name, value]): [string, string] => [name, value]),
    ...(request.body === undefined || ['GET', 'HEAD'].includes(request.method.toUpperCase()) ? {} : { body: request.body }),
    redirect: 'manual',
  });
}

/** What a workspace's OP answered a request with: the response to give the client, and the exchange it was recorded as. */
export interface Answered {
  response: Response;
  exchange: LiveExchange;
}

/** A workspace of the live OP (see the module comment). */
export class LiveWorkspace {
  private app!: { fetch: (request: Request) => Response | Promise<Response> };
  private db!: MemoryDatabase;
  private features!: FeatureStores;
  private snapshot!: WorkspaceSnapshot;

  private constructor(
    readonly id: string,
    readonly issuer: string,
    private readonly storage: WorkspaceStorage,
  ) {}

  /** The workspace a host keeps in a storage: made again from what it holds, or a new one of an issuer when it holds none. */
  static async open(id: string, issuer: string, storage: WorkspaceStorage = new MemoryStorage()): Promise<LiveWorkspace> {
    const workspace = new LiveWorkspace(id, issuer, storage);
    const kept = await storage.load();
    await workspace.start(kept !== undefined && kept.issuer === issuer && kept.version === 1 ? kept : undefined);
    return workspace;
  }

  /** Make the app and the state: from a snapshot, or new (the clients and users the app registers itself, a new key). */
  private async start(kept: WorkspaceSnapshot | undefined): Promise<void> {
    const signingKey = kept?.signingKey ?? (await newSigningKey(this.id));
    const fresh = createEmptyDatabase();
    // createServerApp registers the clients of OIDC_CLIENTS_JSON and the development users into the global database.
    this.app = await exclusive(() => onDatabase(fresh, () => createServerApp(liveEnvironment(this.issuer, signingKey))));
    this.db = kept === undefined ? fresh : (decodeValue(kept.database) as MemoryDatabase);
    this.features = await exclusive(() => FeatureStores.restore(kept?.featureWrites));
    this.snapshot = kept ?? {
      version: 1,
      id: this.id,
      issuer: this.issuer,
      createdAt: Date.now(),
      clockOffset: 0,
      signingKey,
      database: encodeValue(fresh),
      featureWrites: [],
      exchanges: [],
      counter: 0,
      provenance: {},
    };
    if (kept === undefined) await this.storage.save(this.snapshot);
  }

  /** The OP's clock now, in Unix milliseconds. */
  now(): number {
    return Date.now() + this.snapshot.clockOffset * 1000;
  }

  /** Run a request a page wrote (or a case or a grant sent) on the OP, recorded as an exchange. */
  send(request: LiveRequest, source: ExchangeSource, scenario?: string): Promise<Answered> {
    return this.answer(requestOf(this.issuer, request), source, scenario);
  }

  /**
   * Answer a request with the OP, on the workspace's state, and record the
   * exchange: the request and the response, the order of what ran, and the
   * records read and written. The state is kept before the response is
   * given back.
   */
  async answer(request: Request, source: ExchangeSource, scenario?: string): Promise<Answered> {
    const sentBody = request.body === null ? '' : await request.clone().text();
    const sent = { method: request.method, url: request.url, headers: keptHeaders(request.headers), ...keptBody(sentBody) };
    const outcome = await exclusive(() => this.run(request));
    this.snapshot.counter += 1;
    const id = `x${this.snapshot.counter}`;
    const text = outcome.body === undefined ? '' : new TextDecoder().decode(outcome.body);
    const response = outcome.response;
    const error = response === undefined ? undefined : oauthErrorOf(response.status, response.headers, text);
    const exchange: LiveExchange = {
      id,
      source,
      at: outcome.at,
      method: request.method,
      path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
      ...(response === undefined ? {} : { status: response.status }),
      ...(error === undefined ? {} : { error }),
      ...(scenario === undefined ? {} : { scenario }),
      request: sent,
      ...(response === undefined ? {} : { response: { status: response.status, ...(response.statusText === '' ? {} : { statusText: response.statusText }), headers: keptHeaders(response.headers), ...keptBody(text) } }),
      ...(outcome.thrown === undefined ? {} : { thrown: outcome.thrown }),
      trace: outcome.trace,
      store: outcome.store,
    };
    this.noteProvenance(id, outcome.store.wrote);
    await this.keep(exchange);
    const headers = new Headers();
    if (response !== undefined) {
      for (const [name, value] of response.headers) if (name.toLowerCase() !== 'set-cookie') headers.append(name, value);
      for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie);
    }
    const given = response === undefined
      ? new Response(JSON.stringify({ error: 'server_error', error_description: outcome.thrown }), { status: 500, headers: { 'content-type': 'application/json' } })
      : new Response(outcome.body === undefined || [101, 204, 205, 304].includes(response.status) ? null : outcome.body, { status: response.status, statusText: response.statusText, headers });
    return { response: given, exchange };
  }

  /** Run a request on the app with the workspace's state on the global scope, recording what ran (one at a time in the isolate). */
  private async run(request: Request): Promise<{ at: number; response?: Response; body?: ArrayBuffer; thrown?: string; trace: TraceEvents; store: StoreAccess }> {
    const at = this.now();
    return onDatabase(this.db, async () => {
      const reads = watchDatabase(this.db);
      const before = plainDatabase(this.db);
      let trace: TraceEvents = { probes: probeTable().hash, events: [] };
      const { result, access } = await this.features.bind(() => withClockOffset(this.snapshot.clockOffset * 1000, async () => {
        startRecording();
        try {
          const response = await this.app.fetch(request);
          // The body is read while recording: a streamed body runs the app's code as it is read.
          const body = await response.arrayBuffer();
          return { response, body };
        } catch (thrown) {
          return { thrown: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown) };
        } finally {
          trace = stopRecording();
        }
      }));
      const wrote: StoreChange[] = [...changesBetween(before, plainDatabase(this.db)), ...access.wrote];
      this.snapshot.database = encodeValue(this.db);
      return { at, ...result, trace, store: { read: [...reads, ...access.read], wrote } };
    });
  }

  /** Note which exchange added or changed each record it wrote. */
  private noteProvenance(id: string, wrote: readonly StoreChange[]): void {
    for (const change of wrote) {
      const key = recordKey(change.collection, change.key);
      if (change.change === 'added') this.snapshot.provenance[key] = { addedBy: id };
      else if (change.change === 'removed') delete this.snapshot.provenance[key];
      else this.snapshot.provenance[key] = { ...this.snapshot.provenance[key], changedBy: [...(this.snapshot.provenance[key]?.changedBy ?? []), id] };
    }
  }

  /** Keep an exchange and the state after it, dropping the oldest exchanges past MAX_EXCHANGES. */
  private async keep(exchange: LiveExchange): Promise<void> {
    const { request: _request, response: _response, trace: _trace, store: _store, thrown: _thrown, ...summary } = exchange;
    this.snapshot.exchanges.push(summary);
    const dropped = this.snapshot.exchanges.splice(0, Math.max(0, this.snapshot.exchanges.length - MAX_EXCHANGES)).map((old) => old.id);
    this.snapshot.featureWrites = this.features.writes;
    await this.storage.putExchange(exchange);
    if (dropped.length > 0) await this.storage.deleteExchanges(dropped);
    await this.storage.save(this.snapshot);
  }

  /** The exchanges kept, oldest first; those after an exchange only, when one is named. */
  summaries(after?: string): ExchangeSummary[] {
    const all = this.snapshot.exchanges;
    if (after === undefined) return [...all];
    const index = all.findIndex((summary) => summary.id === after);
    return index < 0 ? [...all] : all.slice(index + 1);
  }

  /** An exchange kept, whole; undefined for one dropped or never made. */
  exchange(id: string): Promise<LiveExchange | undefined> {
    return this.storage.getExchange(id);
  }

  /** What the workspace is and holds (LiveState). */
  state(): LiveState {
    const records: LiveRecord[] = [];
    for (const [collection, entries] of Object.entries(plainDatabase(this.db))) {
      for (const [key, value] of Object.entries(entries)) {
        const provenance = this.snapshot.provenance[recordKey(collection, key)];
        records.push({ collection, key, value, ...(provenance?.addedBy === undefined ? {} : { addedBy: provenance.addedBy }), ...(provenance?.changedBy === undefined ? {} : { changedBy: provenance.changedBy }) });
      }
    }
    for (const record of this.features.records()) {
      const provenance = this.snapshot.provenance[recordKey(record.collection, record.key)];
      records.push({ ...record, value: plainOf(record.value), ...(provenance?.addedBy === undefined ? {} : { addedBy: provenance.addedBy }), ...(provenance?.changedBy === undefined ? {} : { changedBy: provenance.changedBy }) });
    }
    return {
      workspace: this.id,
      issuer: this.issuer,
      now: this.now(),
      clockOffset: this.snapshot.clockOffset,
      probes: probeTable().hash,
      clients: liveClients(this.issuer),
      users: [...LIVE_USERS],
      records,
      exchanges: this.snapshot.counter,
    };
  }

  /** Move the OP's clock on by some seconds (the real clock goes on too). */
  async advanceClock(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 366 * 24 * 3600) throw new Error('The clock moves on by 0 seconds to a year.');
    this.snapshot.clockOffset += Math.floor(seconds);
    await this.storage.save(this.snapshot);
  }

  /** Start the workspace over: a new OP with only what it is configured with, the exchanges dropped. */
  async reset(): Promise<void> {
    const dropped = this.snapshot.exchanges.map((summary) => summary.id);
    if (dropped.length > 0) await this.storage.deleteExchanges(dropped);
    const counter = this.snapshot.counter;
    await this.start(undefined);
    // Exchange ids are not reused, so a page that held an old one does not open a new exchange by it.
    this.snapshot.counter = counter;
    await this.storage.save(this.snapshot);
  }
}
