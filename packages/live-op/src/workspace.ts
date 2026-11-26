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
 * Object's storage on Workers (apps/map/worker), memory in Node. What it
 * keeps is opened again only by the same build of the OP with the same
 * configuration (WorkspaceSnapshot.build); a workspace whose storage cannot
 * be opened, or was kept by another build, or grows past SNAPSHOT_LIMIT,
 * starts over and says why (LiveState.notice), so a reader is never left
 * with a workspace that cannot answer.
 *
 * The requests of one workspace run one at a time too (`serial`), from
 * the recording to the keeping of their exchange, as do its reset and the
 * moving of its clock: an exchange's id is never given twice, and a reset
 * never interleaves with a request.
 */
import { createServerApp } from '../../../apps/hono/src/app.js';
import { createEmptyDatabase, type MemoryDatabase } from '../../../apps/hono/src/oidc-provider/db/memory/database.js';
import { rpInitiatedLogoutConfig } from '../../../apps/hono/src/oidc-provider/features/rp-initiated-logout/config.js';
import {
  MAX_EXCHANGES,
  PUBLIC_WORKSPACE,
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
import { liveClients, liveConfigurationHash, liveEnvironment, LIVE_USERS } from './seed.js';
import { changesBetween, plainDatabase, plainOf, watchDatabase } from './store.js';

/** The global apps/hono keeps its memory database on (db/memory/database.ts). */
const DATABASE_KEY = '__oidcMemoryDatabase';

/** The bodies an exchange keeps are cut at this many characters (16 KiB). */
const BODY_LIMIT = 16 * 1024;

/**
 * The most characters a workspace's snapshot takes as JSON (8 MiB): what a
 * workspace holds is read, written and made again on every request, so one
 * that grows past it starts over (a limit of the playground, not of the OP).
 */
export const SNAPSHOT_LIMIT = 8 * 1024 * 1024;

/** The form of a snapshot: 2 since an object with a member named `$…` is escaped (codec.ts). */
const SNAPSHOT_VERSION = 2;

/** What a workspace says when it started over without a reader asking for it (LiveState.notice). */
const NOTICES = {
  unreadable: (reason: string): string => `保存していた状態を読めなかったので、ワークスペースを作り直しました（${reason}）。`,
  changed: 'OP のコードか設定が変わったので、ワークスペースを作り直しました。',
  tooLarge: `ワークスペースが保つ状態が ${SNAPSHOT_LIMIT / 1024 / 1024} MiB を超えたので、ワークスペースを作り直しました（地図の OP の遊び場としての制限です）。`,
};

/** The text an exchange keeps in place of a credential of a request in the public workspace, which anyone can read. */
const HIDDEN = '（公開ワークスペースでは隠す）';

/** The run before the next in this isolate (see the module comment). */
let queue: Promise<unknown> = Promise.resolve();

/** Run after every run asked for before in this isolate, alone. */
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run);
  queue = result.catch(() => undefined);
  return result;
}

/** The message of an error, for a notice. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The build of the OP a snapshot is kept by: the probe table of its code and the hash of its configuration for an issuer (seed.ts). */
function buildOf(issuer: string): string {
  return `${probeTable().hash}.${liveConfigurationHash(issuer)}`;
}

/**
 * Run with the global database of apps/hono set to a database, and give the
 * earlier one back after; with a logout registry, the registry of the
 * rp-initiated-logout feature set to it too (createServerApp writes it into
 * the module from the environment, which names the issuer, so workspaces of
 * two issuers in one isolate would read each other's).
 */
async function onDatabase<T>(db: MemoryDatabase, run: () => Promise<T>, postLogoutRedirectUris?: Record<string, string[]>): Promise<T> {
  const global = globalThis as Record<string, unknown>;
  const before = global[DATABASE_KEY];
  const registryBefore = rpInitiatedLogoutConfig.postLogoutRedirectUris;
  global[DATABASE_KEY] = db;
  if (postLogoutRedirectUris !== undefined) rpInitiatedLogoutConfig.postLogoutRedirectUris = postLogoutRedirectUris;
  try {
    return await run();
  } finally {
    global[DATABASE_KEY] = before;
    rpInitiatedLogoutConfig.postLogoutRedirectUris = registryBefore;
  }
}

/** Where a record of a workspace came from: the exchange that added it last and those that changed it after. */
interface Provenance {
  addedBy?: string;
  changedBy?: string[];
}

/** What a workspace holds, as its host keeps it between two of its runs. */
export interface WorkspaceSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** The build of the OP that kept it (buildOf): another build does not open it again, but starts over. */
  build: string;
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
  /** Why the workspace started over without a reader asking for it (LiveState.notice), until it is reset. */
  notice?: string;
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

/** Whether a header of a request is one a host adds on its way to the OP (Cloudflare's `cf-*`, a proxy's `x-forwarded-*`, `x-real-ip`), not one the client sent. */
function isHostHeader(name: string): boolean {
  return name.startsWith('cf-') || name.startsWith('x-forwarded-') || ['x-real-ip', 'true-client-ip', 'cdn-loop'].includes(name);
}

/** The value of an Authorization or a Cookie as the public workspace keeps it: the scheme, or the names of the cookies, with the rest hidden. */
function hiddenValue(name: string, value: string): string {
  if (name === 'authorization') {
    const scheme = /^(\S+)\s/.exec(value)?.[1];
    return scheme === undefined ? HIDDEN : `${scheme} ${HIDDEN}`;
  }
  return value.split(';').map((part) => {
    const cookie = part.split('=')[0]?.trim() ?? '';
    return cookie === '' ? HIDDEN : `${cookie}=${HIDDEN}`;
  }).join('; ');
}

/**
 * The headers of a request as an exchange keeps them (keptHeaders): one
 * sent over HTTP without those its host added, which are not the client's
 * request; in the public workspace, which anyone can read, with the values
 * of its Authorization and Cookie hidden.
 */
function keptRequestHeaders(headers: Headers, overHttp: boolean, inPublic: boolean): Array<[string, string]> {
  return keptHeaders(headers)
    .filter(([name]) => !overHttp || !isHostHeader(name))
    .map(([name, value]): [string, string] => (inPublic && (name === 'authorization' || name === 'cookie') ? [name, hiddenValue(name, value)] : [name, value]));
}

/** Text of HTML with its character references read (the value of an attribute). */
function unescapeHtml(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, reference: string) => {
    if (reference.startsWith('#')) {
      const code = reference[1] === 'x' || reference[1] === 'X' ? Number.parseInt(reference.slice(2), 16) : Number.parseInt(reference.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[reference.toLowerCase()] ?? whole;
  });
}

/** The fields an HTML page's forms post (the page of a form_post response, OAuth 2.0 Form Post Response Mode §2): each input's name and value, the first of each name. */
function formFieldsOf(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [tag] of html.matchAll(/<input\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([^\s=/<>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attributes.set((match[1] ?? '').toLowerCase(), unescapeHtml(match[2] ?? match[3] ?? match[4] ?? ''));
    }
    const name = attributes.get('name');
    const value = attributes.get('value');
    if (name !== undefined && value !== undefined && !fields.has(name)) fields.set(name, value);
  }
  return fields;
}

/** The `error` claim of a JWT's payload, read without verifying it: the error of a JARM response (JARM §2.1); undefined for none or a value that is not a JWT. */
function jwtErrorOf(jwt: string | null | undefined): string | undefined {
  const payload = jwt?.split('.')[1];
  if (payload === undefined || payload === '') return undefined;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))) as { error?: unknown };
    return typeof claims?.error === 'string' ? claims.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The OAuth error a response names: the `error` of its JSON body; of the
 * URL it redirects to (query or fragment), or of the JARM response JWT
 * there (`response`, JARM §2.3.1); of the form a form_post page posts
 * (OAuth 2.0 Form Post Response Mode §2), or of a JARM response JWT it
 * posts; of its WWW-Authenticate; or the body itself when it is one word.
 */
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
      const fragment = new URLSearchParams(url.hash.slice(1));
      const error = url.searchParams.get('error') ?? fragment.get('error') ?? jwtErrorOf(url.searchParams.get('response') ?? fragment.get('response'));
      if (error !== null && error !== undefined) return error;
    } catch {
      // Not a URL.
    }
  }
  if ((headers.get('content-type') ?? '').includes('html') && /<form\b/i.test(body)) {
    const fields = formFieldsOf(body);
    const error = fields.get('error') ?? jwtErrorOf(fields.get('response'));
    if (error !== undefined) return error;
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

/** What a run of the OP gave: its clock when it started, the response and its body (or what it threw), the order of what ran, and the records read and written. */
interface RunOutcome {
  at: number;
  response?: Response;
  body?: ArrayBuffer;
  thrown?: string;
  trace: TraceEvents;
  store: StoreAccess;
}

/** What a workspace's OP answered a request with: the response to give the client, and the exchange it was recorded as. */
export interface Answered {
  response: Response;
  exchange: LiveExchange;
}

/** Why a snapshot a storage kept is not one this build opens again (a notice), or undefined for one it opens. */
function refusedSnapshot(kept: unknown, issuer: string): string | undefined {
  if (kept === null || typeof kept !== 'object') return NOTICES.unreadable('保存されていたものがワークスペースの状態ではありません');
  const snapshot = kept as Partial<WorkspaceSnapshot>;
  return snapshot.version !== SNAPSHOT_VERSION || snapshot.issuer !== issuer || snapshot.build !== buildOf(issuer) ? NOTICES.changed : undefined;
}

/** A database from its JSON (codec.ts), checked to hold every collection a new database of the OP holds (made). */
function restoredDatabase(encoded: EncodedValue, made: MemoryDatabase): MemoryDatabase {
  const db = decodeValue(encoded) as Record<string, unknown> | null;
  for (const [collection, records] of Object.entries(made)) {
    if (records instanceof Map && !(db?.[collection] instanceof Map)) throw new Error(`the database has no collection ${collection}`);
  }
  return db as unknown as MemoryDatabase;
}

/** A workspace of the live OP (see the module comment). */
export class LiveWorkspace {
  private app!: Awaited<ReturnType<typeof createServerApp>>;
  private db!: MemoryDatabase;
  private features!: FeatureStores;
  private snapshot!: WorkspaceSnapshot;
  /** The number of the last preview (`p<n>`), counted from the workspace's start in this host. */
  private previews = 0;
  /** The post-logout redirect URIs the environment of this workspace's issuer registers (liveEnvironment). */
  private readonly logoutRegistry: Record<string, string[]>;
  /** The run of this workspace before the next (see the module comment). */
  private turn: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly id: string,
    readonly issuer: string,
    private readonly storage: WorkspaceStorage,
  ) {
    this.logoutRegistry = JSON.parse(liveEnvironment(issuer, { kid: '' })['OIDC_POST_LOGOUT_REDIRECT_URIS_JSON'] ?? '{}') as Record<string, string[]>;
  }

  /**
   * The workspace a host keeps in a storage: made again from what it holds,
   * or a new one of an issuer when it holds none. One whose storage cannot
   * be read or made again, or that another build of the OP kept, starts
   * over (its exchanges dropped, their ids not given again) with a notice
   * that says so.
   */
  static async open(id: string, issuer: string, storage: WorkspaceStorage = new MemoryStorage()): Promise<LiveWorkspace> {
    const workspace = new LiveWorkspace(id, issuer, storage);
    let kept: WorkspaceSnapshot | undefined;
    let notice: string | undefined;
    try {
      kept = await storage.load();
    } catch (error) {
      notice = NOTICES.unreadable(messageOf(error));
    }
    if (kept !== undefined) notice = refusedSnapshot(kept, issuer);
    if (kept !== undefined && notice === undefined) {
      try {
        await workspace.start(kept);
        return workspace;
      } catch (error) {
        notice = NOTICES.unreadable(messageOf(error));
      }
    }
    const counter = typeof kept?.counter === 'number' && Number.isSafeInteger(kept.counter) && kept.counter > 0 ? kept.counter : 0;
    await workspace.start(undefined, { counter, ...(notice === undefined ? {} : { notice }) });
    if (Array.isArray(kept?.exchanges)) {
      const dropped = kept.exchanges.map((summary: unknown) => (summary as Partial<ExchangeSummary> | null)?.id).filter((exchange): exchange is string => typeof exchange === 'string');
      // What another build kept goes with it; an exchange left behind is only never listed.
      await storage.deleteExchanges(dropped).catch(() => undefined);
    }
    return workspace;
  }

  /**
   * Make the app and the state: from a snapshot, or new (the clients and
   * users the app registers itself, a new key), counting exchanges on from
   * a number and saying a notice when given. The workspace takes them only
   * once all of them are made, so one that cannot be made changes nothing.
   */
  private async start(kept: WorkspaceSnapshot | undefined, fresh: { counter: number; notice?: string } = { counter: 0 }): Promise<void> {
    const signingKey = kept?.signingKey ?? (await newSigningKey(this.id));
    const made = createEmptyDatabase();
    // createServerApp registers the clients of OIDC_CLIENTS_JSON and the development users into the global database.
    const app = await exclusive(() => onDatabase(made, () => createServerApp(liveEnvironment(this.issuer, signingKey))));
    const db = kept === undefined ? made : restoredDatabase(kept.database, made);
    const features = await exclusive(() => FeatureStores.restore(kept?.featureWrites));
    const snapshot: WorkspaceSnapshot = kept ?? {
      version: SNAPSHOT_VERSION,
      build: buildOf(this.issuer),
      id: this.id,
      issuer: this.issuer,
      createdAt: Date.now(),
      clockOffset: 0,
      signingKey,
      database: encodeValue(made),
      featureWrites: [],
      exchanges: [],
      counter: fresh.counter,
      provenance: {},
      ...(fresh.notice === undefined ? {} : { notice: fresh.notice }),
    };
    if (kept === undefined) await this.storage.save(snapshot);
    this.app = app;
    this.db = db;
    this.features = features;
    this.snapshot = snapshot;
  }

  /** Run after every run of this workspace asked for before, alone among them (see the module comment). */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.turn.then(run);
    this.turn = result.catch(() => undefined);
    return result;
  }

  /** The routes the OP's app registers (Hono's `app.routes`), each method and path pattern, in the order it registered them. */
  routes(): Array<{ method: string; path: string }> {
    return this.app.routes.map(({ method, path }) => ({ method, path }));
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
   * given back. The body is read first; from then on the workspace runs
   * nothing else until the exchange is kept (`serial`).
   */
  async answer(request: Request, source: ExchangeSource, scenario?: string): Promise<Answered> {
    const sentBody = request.body === null ? '' : await request.clone().text();
    return this.serial(() => this.answerAlone(request, sentBody, source, scenario));
  }

  /** Answer a request whose body was read (answer), while nothing else of the workspace runs. */
  private async answerAlone(request: Request, sentBody: string, source: ExchangeSource, scenario: string | undefined): Promise<Answered> {
    const outcome = await exclusive(() => this.run(request));
    this.snapshot.counter += 1;
    const id = `x${this.snapshot.counter}`;
    const exchange = this.exchangeOf(id, request, sentBody, source, outcome, scenario);
    const response = outcome.response;
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

  /** A request answered (or thrown at) as an exchange: what was sent, what the OP answered, the order of what ran, and the records read and written. */
  private exchangeOf(id: string, request: Request, sentBody: string, source: ExchangeSource, outcome: RunOutcome, scenario?: string): LiveExchange {
    const sent = { method: request.method, url: request.url, headers: keptRequestHeaders(request.headers, source === 'http', this.id === PUBLIC_WORKSPACE), ...keptBody(sentBody) };
    const text = outcome.body === undefined ? '' : new TextDecoder().decode(outcome.body);
    const response = outcome.response;
    const error = response === undefined ? undefined : oauthErrorOf(response.status, response.headers, text);
    return {
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
  }

  /**
   * What a request would do if it were sent now, without sending it: the
   * OP answers it on a copy of the workspace's state (its database and the
   * stores of its features, at its clock), and the copy is dropped. The
   * exchange it gives (source `preview`, id `p<n>`) is not kept, and the
   * workspace's records, exchanges and counter stay as they were, so a code
   * the request would use up is still there for the request that is sent.
   * The map's flow view replays it while the reader edits a request.
   */
  async preview(request: LiveRequest): Promise<LiveExchange> {
    const sent = requestOf(this.issuer, request);
    const sentBody = sent.body === null ? '' : await sent.clone().text();
    return this.serial(async () => {
      const db = decodeValue(encodeValue(this.db)) as MemoryDatabase;
      const features = await exclusive(() => FeatureStores.restore(this.features.writes));
      const outcome = await exclusive(() => this.run(sent, { db, features }));
      this.previews += 1;
      return this.exchangeOf(`p${this.previews}`, sent, sentBody, 'preview', outcome);
    });
  }

  /**
   * Run a request on the app with a state on the global scope (the
   * workspace's, else the copy a preview runs on), recording what ran (one
   * at a time in the isolate). The workspace's snapshot takes the database
   * after the run only when the run is on the workspace's own state.
   */
  private async run(request: Request, on: { db: MemoryDatabase; features: FeatureStores } = { db: this.db, features: this.features }): Promise<RunOutcome> {
    const at = this.now();
    const own = on.db === this.db;
    return onDatabase(on.db, async () => {
      const reads = watchDatabase(on.db);
      const before = plainDatabase(on.db);
      let trace: TraceEvents = { probes: probeTable().hash, events: [] };
      const { result, access } = await on.features.bind(() => withClockOffset(this.snapshot.clockOffset * 1000, async () => {
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
      const wrote: StoreChange[] = [...changesBetween(before, plainDatabase(on.db)), ...access.wrote];
      if (own) this.snapshot.database = encodeValue(this.db);
      return { at, ...result, trace, store: { read: [...reads, ...access.read], wrote } };
    }, this.logoutRegistry);
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

  /**
   * Keep an exchange and the state after it, dropping the oldest exchanges
   * past MAX_EXCHANGES and the writes of the features' records that have
   * long expired (FeatureStores.prune). A state past SNAPSHOT_LIMIT starts
   * the workspace over, keeping only the exchange, with a notice.
   */
  private async keep(exchange: LiveExchange): Promise<void> {
    const { request: _request, response: _response, trace: _trace, store: _store, thrown: _thrown, ...summary } = exchange;
    this.features.prune(this.now());
    this.snapshot.featureWrites = this.features.writes;
    if (JSON.stringify(this.snapshot).length > SNAPSHOT_LIMIT) await this.startOver(NOTICES.tooLarge);
    this.snapshot.exchanges.push(summary);
    const dropped = this.snapshot.exchanges.splice(0, Math.max(0, this.snapshot.exchanges.length - MAX_EXCHANGES)).map((old) => old.id);
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
      ...(this.snapshot.notice === undefined ? {} : { notice: this.snapshot.notice }),
    };
  }

  /** Move the OP's clock on by some seconds (the real clock goes on too), after the requests of the workspace before it. */
  advanceClock(seconds: number): Promise<void> {
    return this.serial(async () => {
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 366 * 24 * 3600) throw new Error('The clock moves on by 0 seconds to a year.');
      this.snapshot.clockOffset += Math.floor(seconds);
      await this.storage.save(this.snapshot);
    });
  }

  /** Start the workspace over: a new OP with only what it is configured with, the exchanges dropped, after the requests of the workspace before it. */
  reset(): Promise<void> {
    return this.serial(() => this.startOver());
  }

  /**
   * Start over (reset, or a state past SNAPSHOT_LIMIT, with a notice), while
   * nothing else of the workspace runs: exchange ids go on from the last
   * one given, so a page that held an old one does not open a new exchange
   * by it.
   */
  private async startOver(notice?: string): Promise<void> {
    const dropped = this.snapshot.exchanges.map((summary) => summary.id);
    await this.start(undefined, { counter: this.snapshot.counter, ...(notice === undefined ? {} : { notice }) });
    if (dropped.length > 0) await this.storage.deleteExchanges(dropped);
  }
}
