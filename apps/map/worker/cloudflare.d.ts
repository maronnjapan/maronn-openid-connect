/**
 * The part of the Workers runtime the map's Worker uses (Durable Objects,
 * their storage and alarm, the assets binding), declared here rather than
 * taken from @cloudflare/workers-types: those replace the web platform's
 * types of the DOM (crypto, Request, Response) with the Workers' own, under
 * which the live OP's sources, which the Worker imports and which are
 * checked with the DOM's types as apps/hono's are, do not type-check.
 */
declare module 'cloudflare:workers' {
  /** The base class of a Durable Object (`ctx` its state, `env` the Worker's bindings). */
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
  }
}

/** The storage of a Durable Object: its key-value API and its alarm. */
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** The state of a Durable Object. */
interface DurableObjectState {
  readonly storage: DurableObjectStorage;
}

/** The id of a Durable Object. */
interface DurableObjectId {
  toString(): string;
}

/** A Durable Object to send a request to. */
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/** The Durable Objects of a class (a `durable_objects` binding). */
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** A binding that answers requests (the `assets` binding). */
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
